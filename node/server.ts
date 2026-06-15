/**
 * Pumpstr — le node (backend).
 *
 * Tient un VRAI wallet créateur Arkade (validé au spike A) ET dérive l'identité Nostr
 * du créateur de LA MÊME clé (ADR-004 : 1 seed -> npub + wallet). Expose :
 *   - un overlay (source OBS) qui explose à chaque tip, AVEC l'identité Nostr du tippeur
 *   - une page tip (viewer) : le tippeur s'authentifie en Nostr (NIP-07 ou clé éphémère)
 *     et signe une zap request (NIP-57 kind 9734) ; on génère une vraie facture LN-in
 *   - un flux WebSocket temps réel
 *
 * Identité d'un tip : le tippeur signe une zap request -> on VÉRIFIE la signature, on
 * RÉSOUT son profil (kind 0 : nom + avatar), et on corrèle identité<->paiement via le swap.
 *
 * Run : npm start   (Node 22 LTS, réseau réel requis)
 */
import "fake-indexeddb/auto"; // Node n'a pas IndexedDB ; en RN -> ./adapters/asyncStorage
import { EventSource } from "eventsource"; // SSE du watcher SDK ; absent en Node, react-native-sse en RN
(globalThis as any).EventSource ??= EventSource;
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { SingleKey, Wallet } from "@arkade-os/sdk";
import { ArkadeSwaps, BoltzSwapProvider } from "@arkade-os/boltz-swap";
import { SimplePool, getPublicKey, verifyEvent, finalizeEvent, nip19 } from "nostr-tools";

// notifyIncomingFunds démarre aussi un watcher ON-CHAIN (Electrum WS) qui boucle en
// reconnexion sur mutinynet (pas d'endpoint Electrum). Off-chain (VTXO via SSE) non affecté
// -> on tait juste ce bruit précis pour garder des logs propres.
for (const m of ["error", "warn", "log"] as const) {
  const orig = (console[m] as any).bind(console);
  (console[m] as any) = (...a: any[]) => {
    const s = String(a[0] ?? "");
    if (s.includes("WebSocket error") || s.includes("Scheduling WebSocket reconnect")) return;
    orig(...a);
  };
}

// Le watcher ON-CHAIN (Esplora/Electrum) peut THROW (fetch/TLS transitoires sur mutinynet,
// p.ex. CERT_NOT_YET_VALID) et tuer le process via une rejection non gérée. L'OFF-CHAIN
// (VTXO via SSE) n'en dépend pas -> on garde le serveur vivant, fail-fast seulement sur l'inattendu.
let onchainWarned = false;
const isOnchainNoise = (e: any) =>
  /fetch failed|CERT_NOT_YET_VALID|certificate|EsploraProvider|ContractWatcher|onchain|ECONN|ETIMEDOUT|ENOTFOUND/i
    .test(`${e?.message ?? e} ${e?.cause?.code ?? ""} ${e?.stack ?? ""}`);
for (const ev of ["unhandledRejection", "uncaughtException"] as const) {
  process.on(ev, (e: any) => {
    if (isOnchainNoise(e)) {
      if (!onchainWarned) {
        onchainWarned = true;
        console.error("[arkade] watcher on-chain indisponible (off-chain non affecté) :", String(e?.cause?.code ?? e?.message ?? e));
      }
      return;
    }
    console.error(`[fatal] ${ev}:`, e?.stack ?? e);
    process.exit(1);
  });
}

const PORT = Number(process.env.PORT ?? 4242);
const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";
const BOLTZ_NETWORK = process.env.BOLTZ_NETWORK ?? "mutinynet";
const RELAYS = (process.env.NOSTR_RELAYS || "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net")
  .split(",").map((s) => s.trim()).filter(Boolean);
const STREAM = {
  d: process.env.STREAM_D ?? "pumpstr-live",
  title: process.env.STREAM_TITLE ?? "🔴 Pumpstr live",
  summary: process.env.STREAM_SUMMARY ?? "Streaming souverain sur Bitcoin — tips en sats, en direct.",
  url: process.env.STREAM_URL ?? "",     // URL HLS (la vidéo = couche suivante) ; vide pour l'instant
  image: process.env.STREAM_IMAGE ?? "", // miniature
};
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const KEY_FILE = process.env.KEY_FILE ?? join(HERE, ".creator-key"); // en conteneur : monté sur un volume

function loadOrCreateKeyHex(): string {
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  const hex = Buffer.from(b).toString("hex");
  writeFileSync(KEY_FILE, hex);
  return hex;
}

// ---------- identités ----------
type Tipper = { name: string; pubkey?: string; picture?: string; comment?: string; via: string };
let creatorAddress = "";
const recentTips: { amount: number; name: string; picture?: string; at: number }[] = [];

// ---------- Nostr (résolution de profil + vérif des zap requests) ----------
const pool = new SimplePool();
const profileCache = new Map<string, { name: string; picture?: string }>();
const shortNpub = (pubkey: string) => {
  try { return nip19.npubEncode(pubkey).slice(0, 11) + "…"; } catch { return pubkey.slice(0, 8) + "…"; }
};
async function resolveProfile(pubkey: string): Promise<{ name: string; picture?: string }> {
  if (profileCache.has(pubkey)) return profileCache.get(pubkey)!;
  let prof: { name: string; picture?: string } = { name: shortNpub(pubkey) };
  try {
    const ev: any = await Promise.race([
      pool.get(RELAYS, { kinds: [0], authors: [pubkey] }),
      new Promise((r) => setTimeout(() => r(null), 4000)),
    ]);
    if (ev?.content) {
      const meta = JSON.parse(ev.content);
      prof = { name: meta.display_name || meta.name || shortNpub(pubkey), picture: meta.picture };
    }
  } catch { /* relais injoignable -> fallback npub court */ }
  profileCache.set(pubkey, prof);
  return prof;
}
/** Vérifie une zap request (NIP-57 kind 9734) signée et en extrait le tippeur. */
function verifiedTipper(zr: any): { pubkey: string; comment: string } | null {
  try {
    if (!zr || typeof zr !== "object" || !verifyEvent(zr)) return null;
    return { pubkey: zr.pubkey, comment: typeof zr.content === "string" ? zr.content.slice(0, 140) : "" };
  } catch { return null; }
}
async function tipperFromBody(body: any, via: string): Promise<Tipper> {
  const v = verifiedTipper(body?.zapRequest);
  if (v) {
    const prof = await resolveProfile(v.pubkey);
    return { name: prof.name, pubkey: v.pubkey, picture: prof.picture, comment: v.comment || (body?.comment ?? ""), via };
  }
  // pas d'identité Nostr signée -> anonyme (nom libre optionnel)
  return { name: (body?.name || "anon").toString().slice(0, 24), comment: (body?.comment ?? "").toString().slice(0, 140), via };
}

// ---------- Arkade (le vrai rail) ----------
console.log(`[arkade] connexion à ${ARK_SERVER_URL} ...`);
const keyHex = loadOrCreateKeyHex();
const identity = SingleKey.fromHex(keyHex);
const creatorSk = Uint8Array.from(Buffer.from(keyHex, "hex"));
const creatorPubkey = getPublicKey(creatorSk); // MÊME clé -> wallet Arkade + Nostr (ADR-004)
const creatorNpub = nip19.npubEncode(creatorPubkey);
const wallet = await Wallet.create({ identity, arkServerUrl: ARK_SERVER_URL });
creatorAddress = await wallet.getAddress();
const swaps = new ArkadeSwaps({
  wallet,
  swapProvider: new BoltzSwapProvider({ network: BOLTZ_NETWORK as any }),
  swapManager: false, // on claim explicitement par facture (waitAndClaim) -> corrélation identité fiable
});
console.log(`[arkade] créateur prêt`);
console.log(`         adresse : ${creatorAddress}`);
console.log(`         npub    : ${creatorNpub}`);

// ---------- WebSocket : pousse les tips ----------
const clients = new Set<WebSocket>();
function broadcast(msg: object) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}
function registerTip(amount: number, t: Tipper) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const at = Date.now();
  recentTips.unshift({ amount, name: t.name, picture: t.picture, at });
  if (recentTips.length > 20) recentTips.length = 20;
  broadcast({ type: "tip", amount, at, name: t.name, pubkey: t.pubkey, picture: t.picture, comment: t.comment, via: t.via });
  console.log(`[tip] +${amount} sats — ${t.name} (${t.via})${t.comment ? ` : "${t.comment}"` : ""}`);
}

// ---------- NIP-53 : publier le live sur Nostr (le portail fédéré l'agrège) ----------
const startedAt = Math.floor(Date.now() / 1000);
function buildLiveEvent(status: "live" | "ended", participants: number) {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["d", STREAM.d],                              // identifiant stable -> event remplaçable (NIP-53)
    ["title", STREAM.title],
    ["summary", STREAM.summary],
    ["status", status],
    ["starts", String(startedAt)],
    ["current_participants", String(participants)],
    ["p", creatorPubkey, RELAYS[0] ?? "", "host"], // l'hôte
    ["t", "pumpstr"],                              // le portail filtre là-dessus
    ["client", "pumpstr"],
  ];
  if (STREAM.url) tags.push(["streaming", STREAM.url]);
  if (STREAM.image) tags.push(["image", STREAM.image]);
  if (status === "ended") tags.push(["ends", String(now)]);
  return finalizeEvent({ kind: 30311, created_at: now, content: "", tags }, creatorSk);
}
async function publishLive(status: "live" | "ended") {
  try {
    await Promise.any(pool.publish(RELAYS, buildLiveEvent(status, clients.size)));
    console.log(`[nostr] live "${status}" publié (kind:30311 d=${STREAM.d}, ${clients.size} viewers) -> ${RELAYS.length} relais`);
  } catch (e: any) {
    console.error("[nostr] publishLive:", e?.message ?? e);
  }
}

// ---------- NIP-57 : zap receipt (9735) sur un VRAI paiement LN réglé ----------
async function publishZapReceipt(zapRequest: any, bolt11: string, amountSats: number) {
  try {
    const receipt = finalizeEvent({
      kind: 9735,
      created_at: Math.floor(Date.now() / 1000),
      content: typeof zapRequest?.content === "string" ? zapRequest.content : "",
      tags: [
        ["p", creatorPubkey],                                      // bénéficiaire (le créateur)
        ...(zapRequest?.pubkey ? [["P", zapRequest.pubkey]] : []), // le tippeur
        ["bolt11", bolt11],
        ["description", JSON.stringify(zapRequest)],               // la zap request 9734
        ["amount", String(amountSats * 1000)],
      ],
    }, creatorSk);
    await Promise.any(pool.publish(RELAYS, receipt));
    console.log(`[nostr] zap receipt 9735 publié (${amountSats} sats)`);
  } catch (e: any) {
    console.error("[nostr] zap receipt:", e?.message ?? e);
  }
}

// ---------- Vidéo : provisionnement Cloudflare Stream (creds-gated) ----------
// Si les creds CF sont présents -> crée un live input (ingest RTMPS pour OBS) + construit
// l'URL HLS de lecture, et la pousse dans le tag `streaming` du NIP-53. Sinon STREAM.url reste
// vide et la page /watch tombe sur un flux de démo. API: developers.cloudflare.com/stream/stream-live
async function provisionCloudflareLive(): Promise<void> {
  const acct = process.env.CLOUDFLARE_STREAM_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_STREAM_API_TOKEN;
  const code = process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE; // sous-domaine customer-<CODE>
  if (STREAM.url || !acct || !token) return; // déjà une URL, ou pas de creds -> on saute
  try {
    const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${acct}/stream/live_inputs`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ meta: { name: `pumpstr-${creatorPubkey.slice(0, 8)}` }, recording: { mode: "automatic" } }),
    });
    const j: any = await r.json();
    const li = j?.result ?? j;
    if (!li?.uid) throw new Error(j?.errors?.[0]?.message ?? "réponse live input invalide");
    console.log(`[video] Cloudflare live input créé — ingest RTMPS pour OBS :`);
    console.log(`        ${li.rtmps?.url}  (clé: ${li.rtmps?.streamKey})`);
    if (code) {
      STREAM.url = `https://customer-${code}.cloudflarestream.com/${li.uid}/manifest/video.m3u8`;
      console.log(`        lecture HLS: ${STREAM.url}`);
    } else {
      console.log(`        ⚠️ définis CLOUDFLARE_STREAM_CUSTOMER_CODE (ou STREAM_URL) pour l'URL de lecture`);
    }
  } catch (e: any) {
    console.error("[video] provisionnement Cloudflare échoué:", e?.message ?? e);
  }
}

// ---------- détection temps réel (SDK) + dédup des tips identifiés ----------
// Les VTXO claimés par facture (waitAndClaim) sont déjà comptés AVEC identité ; on les
// dédupe ici par txid pour que la subscription ne les recompte pas en "anon".
const claimedTxids = new Set<string>();
const sumValue = (coins: any[] = []) => coins.reduce((s, c) => s + Number(c?.value ?? c?.amount ?? 0), 0);

let stopWatch: (() => void) | undefined;
try {
  stopWatch = await (wallet as any).notifyIncomingFunds((funds: any) => {
    if (Array.isArray(funds?.newVtxos)) {
      const fresh = funds.newVtxos.filter((v: any) => !claimedTxids.has(v.txid));
      for (const v of funds.newVtxos) claimedTxids.delete(v.txid);
      const net = sumValue(fresh) - sumValue(funds.spentVtxos); // net > 0 = vrai entrant non identifié
      if (net > 0) registerTip(net, { name: "anon", via: "vtxo" });
    } else if (Array.isArray(funds?.coins)) {
      const net = sumValue(funds.coins);
      if (net > 0) registerTip(net, { name: "anon", via: "boarding" });
    }
  });
  console.log("[arkade] subscription temps réel des fonds entrants : ON");
} catch (e: any) {
  console.error("[arkade] notifyIncomingFunds a échoué:", e?.message ?? e);
}

process.on("SIGINT", async () => {
  stopWatch?.();
  await publishLive("ended").catch(() => {}); // marque le live terminé sur Nostr
  pool.close(RELAYS);
  process.exit(0);
});

await provisionCloudflareLive(); // creds CF -> live input + URL HLS ; sinon /watch utilise un flux démo

// ---------- HTTP ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
};
function sendJson(res: any, code: number, body: object) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}
function readBody(req: any): Promise<string> {
  return new Promise((resolve) => {
    let d = ""; req.on("data", (c: any) => (d += c)); req.on("end", () => resolve(d)); req.on("error", () => resolve(""));
  });
}
const parseJson = (s: string): any => { try { return JSON.parse(s || "{}"); } catch { return {}; } };

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/api/creator") {
    return sendJson(res, 200, { address: creatorAddress, npub: creatorNpub, recentTips });
  }

  if (url.pathname === "/api/stream") {
    return sendJson(res, 200, { url: STREAM.url, demo: !STREAM.url, title: STREAM.title });
  }

  if (url.pathname === "/api/invoice" && req.method === "POST") {
    const body = parseJson(await readBody(req));
    const amount = Number(body.amount) || 1000;
    const zapRequest = body?.zapRequest;
    const tipper = await tipperFromBody(body, "ln");
    try {
      const r: any = await swaps.createLightningInvoice({ amount });
      const bolt11 = r?.invoice ?? r?.bolt11 ?? r?.paymentRequest ?? null;
      const pendingSwap = r?.pendingSwap ?? r;
      // corrélation identité<->paiement : quand CE swap se règle, fire le tip identifié
      // + publie le zap receipt NIP-57 (9735) — la preuve Nostr du zap.
      if (pendingSwap && typeof (swaps as any).waitAndClaim === "function") {
        (swaps as any).waitAndClaim(pendingSwap)
          .then((cl: any) => {
            if (cl?.txid) claimedTxids.add(cl.txid);
            registerTip(amount, tipper);
            if (zapRequest && bolt11) publishZapReceipt(zapRequest, bolt11, amount);
          })
          .catch((e: any) => console.error("[ln] waitAndClaim:", e?.message ?? e));
      }
      return sendJson(res, 200, { bolt11, amount });
    } catch (e: any) {
      return sendJson(res, 502, { error: e?.message ?? String(e) });
    }
  }

  if (url.pathname === "/api/simulate" && req.method === "POST") {
    const body = parseJson(await readBody(req));
    const amount = Number(body.amount) || Math.floor(Math.random() * 4900) + 100;
    const tipper = await tipperFromBody(body, "demo");
    registerTip(amount, tipper);
    return sendJson(res, 200, { ok: true, amount, name: tipper.name });
  }

  // le portail fédéré (client Nostr) — servi depuis ../portal pour le confort de démo
  if (url.pathname === "/portal" || url.pathname === "/portal/") {
    try {
      const data = await readFile(join(HERE, "..", "portal", "index.html"));
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.end(data);
    } catch { res.statusCode = 404; return res.end("portal not built"); }
  }

  // statique
  const p = url.pathname === "/" ? "/overlay.html" : url.pathname;
  try {
    const data = await readFile(join(PUBLIC, p));
    res.setHeader("content-type", MIME[extname(p)] ?? "application/octet-stream");
    res.end(data);
  } catch {
    res.statusCode = 404;
    res.end("not found");
  }
});

// ---------- WS attaché ----------
const wss = new WebSocketServer({ server, path: "/ws" });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "hello", address: creatorAddress, npub: creatorNpub, recentTips }));
  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`\n  🔥 PUMPSTR node en ligne :`);
  console.log(`     overlay (source OBS) : http://localhost:${PORT}/overlay.html`);
  console.log(`     page tip (viewer)    : http://localhost:${PORT}/tip.html`);
  console.log(`     portail fédéré       : http://localhost:${PORT}/portal\n`);
  publishLive("live");                            // annonce le live sur Nostr (NIP-53)
  setInterval(() => publishLive("live"), 45_000); // rafraîchit statut + nb de viewers
});
