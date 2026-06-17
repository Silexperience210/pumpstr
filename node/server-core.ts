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
    /** Extension ArkadeRail pour corréler identité↔paiement LN-in. */
    createLnInvoiceWithSettle?(amount: bigint, description?: string): Promise<{ bolt11: string; settle: () => Promise<{ txid: string }> }>;
    /** Extension ArkadeRail pour le refund d'un escrow expiré. */
    refund?(ref: { id: string }): Promise<{ id: string; status: string }>;
    /** Extension ArkadeRail pour le withdraw LN-out (paie un BOLT11 depuis le wallet). */
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
  };
  db: PumpstrDb;
  state: {
    claimedTxids: Set<string>;
  };
  helpers: {
    registerTip: (amount: number, tipper: Tipper) => void;
    publishZapReceipt: (zapRequest: any, bolt11: string, amountSats: number) => Promise<void> | void;
    publishRewardNote: (pubkey: string, amount: number, claimUrl: string, reason: string) => Promise<void> | void;
    tipperFromBody: (body: any, via: string) => Promise<Tipper>;
    /** Diffuse un message à tous les clients WS /ws (feedback live : fund/withdraw). */
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

function settleAndZap(
  settle: (() => Promise<{ txid: string }>) | null,
  bolt11: string | null,
  amount: number,
  tipper: Tipper,
  claimedTxids: Set<string>,
  registerTip: (amount: number, tipper: Tipper) => void,
  publishZapReceipt: (zapRequest: any, bolt11: string, amountSats: number) => Promise<void> | void,
  zapRequest?: any,
) {
  if (!settle) return;
  settle()
    .then((cl) => {
      if (cl?.txid) claimedTxids.add(cl.txid);
      registerTip(amount, tipper);
      if (zapRequest && bolt11) publishZapReceipt(zapRequest, bolt11, amount);
    })
    .catch((e: any) => console.error("[ln] settle:", e?.message ?? e));
}

export function createHandler(deps: HandlerDeps) {
  const { rail, config, db, state, helpers, fs } = deps;
  const limiter = new RateLimiter();

  /** Gate admin : si ADMIN_TOKEN est défini, exige l'en-tête. Renvoie false (+401) si refusé. */
  const requireAdmin = (req: any, res: any): boolean => {
    if (config.adminToken && req.headers["x-admin-token"] !== config.adminToken) {
      sendJson(res, 401, { error: "x-admin-token requis" });
      return false;
    }
    return true;
  };

  return async (req: any, res: any) => {
    const url = parseUrl(req, config.port);

    if (url.pathname === "/api/creator") {
      return sendJson(res, 200, {
        address: config.creatorAddress,
        npub: config.creatorNpub,
        lnAddress: `${config.lnAddressUser}@${config.lnAddressBase.replace(/^https?:\/\//, "")}`,
        recentTips: db.recentTips(),
      });
    }

    // Console créateur : tout ce qu'il faut pour piloter le node en un seul appel (admin).
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

    // Recharger le wallet du node en Lightning (admin) : facture LN-in -> VTXO.
    // Pas de side-effect "tip" : on dédupe le txid pour que la subscription ne le recompte pas.
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
            if (r?.txid) state.claimedTxids.add(r.txid); // pas un tip : suppression du double-compte
            helpers.broadcast?.({ type: "fund", amount: Number(amount), txid: r?.txid ?? "" }); // efface l'invoice côté UI
            console.log(`[fund] +${Number(amount)} sats encaissés${r?.txid ? ` (${r.txid})` : ""}`);
          })
          .catch((e: any) => console.error("[fund] settle:", e?.message ?? e));
        return sendJson(res, 200, { bolt11, amount: Number(amount) });
      } catch (e: any) {
        return sendJson(res, 502, { error: e?.message ?? String(e) });
      }
    }

    // Withdraw LN-out (admin) : paie un BOLT11 (collé depuis n'importe quel wallet LN) depuis
    // le wallet du node via swap submarine Boltz. Bloque jusqu'au règlement (auto-refund si échec).
    if (url.pathname === "/api/withdraw" && req.method === "POST") {
      if (!requireAdmin(req, res)) return;
      const rl = limiter.check(rateLimitKey(req, "withdraw"), { limit: 20, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: `rate limit — retry after ${rl.retryAfter}s` });

      const body = parseJson(await readBody(req));
      const invoice = String(body.invoice ?? "").trim().toLowerCase();
      if (!/^ln(bc|tbs|tb)[0-9]/.test(invoice)) {
        return sendJson(res, 400, { error: "facture BOLT11 invalide (attendu lnbc… / lntbs…)" });
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

    // LUD-16 Lightning Address
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

    // Callback LNURL-pay
    if (url.pathname === "/api/lnurlp/callback") {
      const rl = limiter.check(rateLimitKey(req, "lnurlp-callback"), { limit: 60, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { status: "ERROR", reason: `rate limit — retry after ${rl.retryAfter}s` });

      const msats = Number(url.searchParams.get("amount") || 0);
      let sats: bigint;
      try {
        sats = parseSats(Math.floor(msats / 1000));
      } catch (e: any) {
        return sendJson(res, 200, { status: "ERROR", reason: e?.message ?? "montant invalide" });
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
        settleAndZap(settle, bolt11, Number(sats), tipper, state.claimedTxids, helpers.registerTip, helpers.publishZapReceipt, zapRequest);
        return sendJson(res, 200, { pr: bolt11, routes: [] });
      } catch (e: any) {
        return sendJson(res, 200, { status: "ERROR", reason: e?.message ?? String(e) });
      }
    }

    if (url.pathname === "/api/stream") {
      return sendJson(res, 200, { url: config.stream.url, demo: !config.stream.url, title: config.stream.title });
    }

    if (url.pathname === "/api/invoice" && req.method === "POST") {
      const rl = limiter.check(rateLimitKey(req, "invoice"), { limit: 60, windowMs: 60_000 });
      if (rl.limited) return sendJson(res, 429, { error: `rate limit — retry after ${rl.retryAfter}s` });

      const body = parseJson(await readBody(req));
      let amount: bigint;
      try {
        amount = parseSats(body.amount, { min: 1n, max: 100_000_000_000n });
      } catch (e: any) {
        return sendJson(res, 400, { error: e?.message ?? "montant invalide" });
      }
      const zapRequest = body?.zapRequest;
      const tipper = await helpers.tipperFromBody(body, "ln");
      try {
        if (!rail.createLnInvoiceWithSettle) throw new Error("rail.createLnInvoiceWithSettle non disponible");
        const { bolt11, settle } = await rail.createLnInvoiceWithSettle(amount, zapRequest ? JSON.stringify(zapRequest) : "Tip Pumpstr");
        settleAndZap(settle, bolt11, Number(amount), tipper, state.claimedTxids, helpers.registerTip, helpers.publishZapReceipt, zapRequest);
        return sendJson(res, 200, { bolt11, amount: Number(amount) });
      } catch (e: any) {
        return sendJson(res, 502, { error: e?.message ?? String(e) });
      }
    }

    // Rewards
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

    // Refund admin d'un escrow expiré
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

    // NIP-11 : document d'info du relay embarqué (le WS upgrade /relay est géré en amont).
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

    // portail fédéré
    if (url.pathname === "/portal" || url.pathname === "/portal/") {
      try {
        const data = await readFile(join(fs.portalDir, "index.html"));
        res.setHeader("content-type", "text/html; charset=utf-8");
        return res.end(data);
      } catch { res.statusCode = 404; return res.end("portal not built"); }
    }

    // statique
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
