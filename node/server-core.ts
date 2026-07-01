/**
 * server-core.ts — logique HTTP du node Pumpstr, isolée pour la testabilité.
 *
 * Exporte `createHandler(deps)` qui retourne la fonction de requête HTTP.
 * Aucun état global n'est créé ici : tout est injecté via `deps`.
 */
import { readFile } from "node:fs/promises";
import { join, extname } from "node:path";
import { nip19 } from "nostr-tools";
import type { PaymentRail } from "@pumpstr/payment-rail";
import { sendJson, readBody, parseJson, parseUrl } from "./http-helpers.js";
import { RateLimiter, rateLimitKey } from "./rate-limit.js";
import { parseSats, parseComment, parseName, requirePubkey, DUST_SATS } from "./validation.js";
import type { PumpstrDb, TipRow, RewardRow } from "./db.js";

export type Tipper = { name: string; pubkey?: string; picture?: string; comment?: string; via: string };

export interface HandlerDeps {
  rail: PaymentRail & {
    createLnInvoiceWithSettle?(amount: bigint, description?: string): Promise<{ bolt11: string; settle: () => Promise<{ txid: string }> }>;
    refund?(ref: { id: string }): Promise<{ id: string; status: string }>;
    withdrawToLightning?(invoice: string): Promise<{ amount: number; txid: string; preimage?: string }>;
  };
  config: {
    port: number;
    lnAddressUser: string;
    lnAddressBase: string;
    lnMetadata: string;
    creatorAddress: string;
    creatorPubkey: string;
    creatorNpub: string;
    stream: { url: string; title: string; summary: string; image: string; d: string };
    publicBase: string;
    adminToken: string;
    platformSplitBps: number;
    actions?: { id: string; label: string; emoji: string; sats: number; effect: string }[];
  };
  db: PumpstrDb;
  state: {
    claimedTxids: Set<string>;
    incomingFundsLock: boolean;
  };
  helpers: {
    registerTip: (amount: number, tipper: Tipper) => void;
    publishZapReceipt: (zapRequest: any, bolt11: string, amountSats: number) => Promise<void> | void;
    publishRewardNote: (pubkey: string, amount: number, claimUrl: string, reason: string) => Promise<void> | void;
    tipperFromBody: (body: any, via: string) => Promise<Tipper>;
    broadcast?: (msg: object) => void;
  };
  fs: {
    publicDir: string;
    portalDir: string;
  };
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

function shortNpub(pubkey: string): string {
  try { return nip19.npubEncode(pubkey).slice(0, 11) + "…"; } catch { return pubkey.slice(0, 8) + "…"; }
}

// H1 : échappement HTML pour éviter XSS dans l'overlay
function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// H4 : fetch avec timeout pour Lightning Address
async function fetchWithTimeout(url: string, opts: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

async function resolveLnAddress(address: string, amountSats: number): Promise<string> {
  const m = /^([a-z0-9._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})$/i.exec(address.trim());
  if (!m) throw new Error("format attendu nom@domaine");
  const [, name, domain] = m;
  const meta: any = await fetchWithTimeout(`https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`).then((r) => r.json());
  if (meta?.tag !== "payRequest" || !meta?.callback) throw new Error("LNURL-pay introuvable sur ce domaine");
  const msat = amountSats * 1000;
  if (msat < (meta.minSendable ?? 1) || msat > (meta.maxSendable ?? Number.MAX_SAFE_INTEGER)) {
    throw new Error(`montant hors limites (${Math.ceil((meta.minSendable ?? 0) / 1000)}–${Math.floor((meta.maxSendable ?? 0) / 1000)} sats)`);
  }
  const sep = String(meta.callback).includes("?") ? "&" : "?";
  const cb: any = await fetchWithTimeout(`${meta.callback}${sep}amount=${msat}`).then((r) => r.json());
  if (!cb?.pr) throw new Error(cb?.reason || "le service n'a pas renvoyé de facture");
  return String(cb.pr);
}

function settleAndZap(
  settle: (() => Promise<{ txid: string }>) | null,
  bolt11: string | null,
  amount: number,
  tipper: Tipper,
  claimedTxids: Set<string>,
  registerTip: (amount: number, tipper: Tipper) => void,
  publishZapReceipt: (zapRequest: any, bolt11: string, amountSats: number) => Promise<void> | void,
  zapRequest?: any,
  broadcast?: (msg: object) => void,
  incomingFundsLock?: { value: boolean },
) {
  if (!settle) return;
  if (incomingFundsLock) incomingFundsLock.value = true;
  settle()
    .then((cl) => {
      if (cl?.txid) claimedTxids.add(cl.txid);
      registerTip(amount, tipper);
      if (zapRequest && bolt11) publishZapReceipt(zapRequest, bolt11, amount);
      // B3 : notifier le viewer que son tip est reçu
      broadcast?.({ type: "tip-confirmed", amount, name: tipper.name });
    })
    .catch((e: any) => {
      console.error("[ln] settle:", e?.message ?? e);
      broadcast?.({ type: "tip-failed", amount, error: "Le paiement a été reçu mais le crédit a échoué. Contacte l'admin." });
    })
    .finally(() => {
      if (incomingFundsLock) incomingFundsLock.value = false;
    });
}

export function createHandler(deps: HandlerDeps) {
  const { rail, config, db, state, helpers, fs } = deps;
  const limiter = new RateLimiter();

  // H9 : timing-safe comparison pour l'admin token
  const requireAdmin = (req: any, res: any): boolean => {
    if (!config.adminToken) return true;
    const token = req.headers["x-admin-token"] ?? "";
    if (token.length !== config.adminToken.length) {
      sendJson(res, 401, { error: "x-admin-token requis" });
      return false;
    }
    let mismatch = 0;
    for (let i = 0; i < token.length; i++) mismatch |= token.charCodeAt(i) ^ config.adminToken.charCodeAt(i);
    if (mismatch !== 0) {
      sendJson(res, 401, { error: "x-admin-token requis" });
      return false;
    }
    return true;
  };

  // H5 : CORS — autorise tout (fédération), avec credentials explicites
  const setCors = (res: any) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type, x-admin-token");
  };

  return async (req: any, res: any) => {
    setCors(res);
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    const url = parseUrl(req, config.port);

    if (url.pathname === "/api/creator") {
      return sendJson(res, 200, {
        address: config.creatorAddress,
        npub: config.creatorNpub,
        lnAddress: `${config.lnAddressUser}@${config.lnAddressBase.replace(/^https?:\/\//, "")}`,
        recentTips: db.recentTips(),
      });
    }

    if (url.pathname === "/api/dashboard") {
      if (!requireAdmin(req, res)) return;
      let balance: number | null = null;
      try { balance = Number(await rail.getBalance()); } catch { /* réseau wallet indispo -> null */ }
      const tips = db.tipStats();
      const rewards = db.rewardStats();
      return sendJson(res, 200, {
        creator: {
          address: config.creatorAddress,
          npub: config.creatorNpub,
          lnAddress: `${config.lnAddressUser}@${config.lnAddressBase.replace(/^https?:\/\//, "")}`,
        },
        balance,
        splitBps: config.platformSplitBps,
        tips: { ...tips, recent: db.recentTips(12) },
        rewards: {
          ...rewards,
          list: db.allRewards(60).map((r) => ({
            id: r.id, npub: r.npub, amount: r.amount, reason: r.reason,
            ref: r.ref, createdAt: r.createdAt, claimed: r.claimed,
          })),
        },
      });
    }

    if (url.pathname === "/api/fund" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const rl = limiter.check(rateLimitKey(req, "fund"), { limit: 20, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: `rate limit — retry after ${rl.retryAfter}s` });

      const body = parseJson(await readBody(req));
      let amount: bigint;
      try {
        amount = parseSats(body.amount, { min: 1000n, max: 100_000_000_000n });
      } catch (e: any) {
        return sendJson(res, 400, { error: e?.message ?? "montant invalide" });
      }
      try {
        if (!rail.createLnInvoiceWithSettle) throw new Error("rail.createLnInvoiceWithSettle non disponible");
        const { bolt11, settle } = await rail.createLnInvoiceWithSettle(amount, "Recharge wallet Pumpstr");
        settle()
          .then((r) => {
            if (r?.txid) state.claimedTxids.add(r.txid);
            helpers.broadcast?.({ type: "fund", amount: Number(amount), txid: r?.txid ?? "" });
            console.log(`[fund] +${Number(amount)} sats encaissés${r?.txid ? ` (${r.txid})` : ""}`);
          })
          .catch((e: any) => console.error("[fund] settle:", e?.message ?? e));
        return sendJson(res, 200, { bolt11, amount: Number(amount) });
      } catch (e: any) {
        return sendJson(res, 502, { error: e?.message ?? String(e) });
      }
    }

    if (url.pathname === "/api/withdraw" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const rl = limiter.check(rateLimitKey(req, "withdraw"), { limit: 20, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: `rate limit — retry after ${rl.retryAfter}s` });

      const body = parseJson(await readBody(req));
      let invoice = String(body.invoice ?? "").trim().toLowerCase();
      const lnAddress = String(body.lnAddress ?? "").trim();
      if (!invoice && lnAddress) {
        let amount: bigint;
        try { amount = parseSats(body.amount, { min: 1n, max: 100_000_000_000n }); }
        catch { return sendJson(res, 400, { error: "montant (sats) requis avec une Lightning Address" }); }
        try { invoice = (await resolveLnAddress(lnAddress, Number(amount))).toLowerCase(); }
        catch (e: any) { return sendJson(res, 400, { error: "Lightning Address : " + (e?.message ?? e) }); }
      }
      if (!/^ln(bc|tbs|tb)[0-9]/.test(invoice)) {
        return sendJson(res, 400, { error: "fournis une facture BOLT11 (lnbc…) ou une Lightning Address + montant" });
      }
      try {
        if (!rail.withdrawToLightning) throw new Error("rail.withdrawToLightning non disponible");
        const r = await rail.withdrawToLightning(invoice);
        helpers.broadcast?.({ type: "withdraw", amount: r.amount, txid: r.txid });
        console.log(`[withdraw] -${r.amount} sats -> LN${r.txid ? ` (${r.txid})` : ""}`);
        return sendJson(res, 200, { ok: true, amount: r.amount, txid: r.txid });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const code = /insufficient|fund|solde|limit|min|max|amount|expired|invoice/i.test(msg) ? 400 : 502;
        return sendJson(res, code, { error: msg });
      }
    }

    if (url.pathname.startsWith("/.well-known/lnurlp/")) {
      const rl = limiter.check(rateLimitKey(req, "lnurlp"), { limit: 60, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { status: "ERROR", reason: `rate limit — retry after ${rl.retryAfter}s` });

      const user = decodeURIComponent(url.pathname.split("/").pop() || "");
      if (user !== config.lnAddressUser) return sendJson(res, 404, { status: "ERROR", reason: "unknown user" });
      return sendJson(res, 200, {
        tag: "payRequest",
        callback: `${config.lnAddressBase}/api/lnurlp/callback`,
        minSendable: 1000,
        maxSendable: 100_000_000_000,
        metadata: config.lnMetadata,
        commentAllowed: 140,
        allowsNostr: true,
        nostrPubkey: config.creatorPubkey,
      });
    }

    if (url.pathname === "/api/lnurlp/callback") {
      const rl = limiter.check(rateLimitKey(req, "lnurlp-callback"), { limit: 60, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { status: "ERROR", reason: `rate limit — retry after ${rl.retryAfter}s` });

      const msats = Number(url.searchParams.get("amount") || 0);
      let sats: bigint;
      try {
        sats = parseSats(Math.floor(msats / 1000), { min: 333n, max: 100_000_000_000n });
      } catch {
        return sendJson(res, 200, { status: "ERROR", reason: "montant invalide — minimum 333 sats (swap Lightning entrant)" });
      }

      let zapRequest: any = null;
      const nostrParam = url.searchParams.get("nostr");
      if (nostrParam) { try { zapRequest = JSON.parse(nostrParam); } catch { /* ignore */ } }
      const comment = url.searchParams.get("comment") || "";

      try {
        if (!rail.createLnInvoiceWithSettle) throw new Error("rail.createLnInvoiceWithSettle non disponible");
        const description = zapRequest ? JSON.stringify(zapRequest) : config.lnMetadata;
        const { bolt11, settle } = await rail.createLnInvoiceWithSettle(sats, description);
        const tipper = await helpers.tipperFromBody({ zapRequest, comment }, "lnaddr");
        settleAndZap(settle, bolt11, Number(sats), tipper, state.claimedTxids, helpers.registerTip, helpers.publishZapReceipt, zapRequest, helpers.broadcast, { value: state.incomingFundsLock });
        return sendJson(res, 200, { pr: bolt11, routes: [] });
      } catch (e: any) {
        return sendJson(res, 200, { status: "ERROR", reason: e?.message ?? String(e) });
      }
    }

    if (url.pathname === "/api/stream") {
      return sendJson(res, 200, { url: config.stream.url, demo: !config.stream.url, title: config.stream.title });
    }

    if (url.pathname === "/api/actions") {
      return sendJson(res, 200, { actions: config.actions ?? [] });
    }

    if (url.pathname === "/api/invoice" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "invoice"), { limit: 60, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: `rate limit — retry after ${rl.retryAfter}s` });

      const body = parseJson(await readBody(req));
      let amount: bigint;
      try {
        amount = parseSats(body.amount, { min: 333n, max: 100_000_000_000n });
      } catch {
        return sendJson(res, 400, { error: "montant invalide — minimum 333 sats (plancher d'un swap Lightning entrant)" });
      }
      const zapRequest = body?.zapRequest;
      const tipper = await helpers.tipperFromBody(body, "ln");
      try {
        if (!rail.createLnInvoiceWithSettle) throw new Error("rail.createLnInvoiceWithSettle non disponible");
        const { bolt11, settle } = await rail.createLnInvoiceWithSettle(amount, zapRequest ? JSON.stringify(zapRequest) : "Tip Pumpstr");
        settleAndZap(settle, bolt11, Number(amount), tipper, state.claimedTxids, helpers.registerTip, helpers.publishZapReceipt, zapRequest, helpers.broadcast, { value: state.incomingFundsLock });
        return sendJson(res, 200, { bolt11, amount: Number(amount) });
      } catch (e: any) {
        return sendJson(res, 502, { error: e?.message ?? String(e) });
      }
    }

    if (url.pathname === "/api/reward" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "reward"), { limit: 30, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: `rate limit — retry after ${rl.retryAfter}s` });

      if (!requireAdmin(req, res)) return;
      const body = parseJson(await readBody(req));
      let pubkey: string;
      let amount: bigint;
      try {
        pubkey = requirePubkey(body.to);
        amount = parseSats(body.amount, { min: BigInt(DUST_SATS), max: 100_000_000_000n });
      } catch (e: any) {
        return sendJson(res, 400, { error: e?.message ?? "paramètre invalide" });
      }
      const reason = parseComment(body.reason);

      try {
        const ref = await rail.escrowClaimable(pubkey, amount, { splitToPlatformBps: config.platformSplitBps });
        const npub = nip19.npubEncode(pubkey);
        const reward: RewardRow = {
          id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
          to: pubkey, npub, amount: Number(amount), reason,
          ref: ref.id, createdAt: Date.now(), claimed: 0,
        };
        db.addReward(reward);
        const claimUrl = `${config.publicBase}/claim.html?to=${npub}`;
        helpers.publishRewardNote(pubkey, Number(amount), claimUrl, reason);
        return sendJson(res, 200, { id: reward.id, to: npub, amount: Number(amount), ref: ref.id, claimUrl });
      } catch (e: any) {
        const msg = String(e?.message ?? e);
        const code = /insufficient|fund|solde|dust/i.test(msg) ? 400 : 502;
        return sendJson(res, code, { error: msg });
      }
    }

    if (url.pathname === "/api/reward/refund" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const body = parseJson(await readBody(req));
      const reward = db.getRewardById(body.id);
      if (!reward) return sendJson(res, 404, { error: "reward inconnu" });
      if (reward.claimed) return sendJson(res, 400, { error: "reward déjà marqué réclamé" });
      try {
        if (!rail.refund) throw new Error("rail.refund non disponible");
        const result = await rail.refund({ id: reward.ref });
        db.markRewardClaimed(reward.id);
        return sendJson(res, 200, { ok: true, txid: result.id });
      } catch (e: any) {
        return sendJson(res, 502, { error: e?.message ?? String(e) });
      }
    }

    if (url.pathname === "/api/rewards") {
      const pk = requirePubkey(url.searchParams.get("pubkey") || url.searchParams.get("to") || "");
      if (!pk) return sendJson(res, 400, { error: "pubkey/npub requis" });
      const mine = db.getRewardsFor(pk)
        .map((r) => ({ id: r.id, amount: r.amount, reason: r.reason, ref: r.ref, createdAt: r.createdAt }));
      return sendJson(res, 200, { pubkey: pk, count: mine.length, rewards: mine });
    }

    if (url.pathname === "/api/reward/claimed" && req.method === "POST") {
      const body = parseJson(await readBody(req));
      const ok = db.markRewardClaimed(body.id);
      return sendJson(res, 200, { ok });
    }

    if (url.pathname === "/api/simulate" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "simulate"), { limit: 20, windowMs: 10_000 });
      if (rl.limited) return sendJson(res, 429, { error: `rate limit — retry after ${rl.retryAfter}s` });

      const body = parseJson(await readBody(req));
      let amount = 0;
      try {
        if (body.amount !== undefined) amount = Number(parseSats(body.amount, { min: 1n, max: 100_000_000_000n }));
      } catch { /* fallback aléatoire */ }
      if (!amount || amount <= 0) amount = Math.floor(Math.random() * 4900) + 100;
      const tipper = await helpers.tipperFromBody(body, "demo");
      helpers.registerTip(amount, tipper);
      return sendJson(res, 200, { ok: true, amount, name: tipper.name });
    }

    if (url.pathname === "/relay") {
      res.setHeader("content-type", "application/nostr+json");
      res.setHeader("access-control-allow-origin", "*");
      return res.end(JSON.stringify({
        name: "pumpstr-node",
        description: "Relay Nostr embarqué d'un node Pumpstr — lives NIP-53 (30311) + zap receipts (9735), source fédérée souveraine.",
        pubkey: config.creatorPubkey,
        supported_nips: [1, 11],
        software: "https://github.com/Silexperience210/pumpstr",
        version: "0.1",
      }));
    }

    if (url.pathname === "/portal" || url.pathname === "/portal/") {
      try {
        const data = await readFile(join(fs.portalDir, "index.html"));
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(data);
      } catch { res.statusCode = 404; return res.end("portal not built"); }
    }

    const p = url.pathname === "/" ? "/overlay.html" : url.pathname;
    try {
      const data = await readFile(join(fs.publicDir, p));
      res.setHeader("content-type", MIME[extname(p)] ?? "application/octet-stream");
      res.end(data);
    } catch {
      res.statusCode = 404;
      res.end("not found");
    }
  };
}
