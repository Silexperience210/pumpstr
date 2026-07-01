/**
 * Pumpstr — le node (backend).
 *
 * Tient un VRAI wallet créateur Arkade (validé au spike A) ET dérive l'identité Nostr
 * du créateur de LA MÊME clé (ADR-004 : 1 seed -> npub + wallet). Expose :
 * - un overlay (source OBS) qui explose à chaque tip, AVEC l'identité Nostr du tippeur
 * - une page tip (viewer) : le tippeur s'authentifie en Nostr (NIP-07 ou clé éphémère)
 *   et signe une zap request (NIP-57 kind 9734) ; on génère une vraie facture LN-in
 * - un flux WebSocket temps réel
 *
 * Identité d'un tip : le tippeur signe une zap request -> on VÉRIFIE la signature, on
 * RÉSOUT son profil (kind 0 : nom + avatar), et on corrèle identité<->paiement via le swap.
 *
 * Run : npm start (Node 22 LTS, réseau réel requis)
 */
import "fake-indexeddb/auto"; // Node n'a pas IndexedDB ; en RN -> ./adapters/asyncStorage
import { EventSource } from "eventsource"; // SSE du watcher SDK ; absent en Node, react-native-sse en RN
(globalThis as any).EventSource ??= EventSource;
import { createServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { execFileSync } from "node:child_process";
import { networkInterfaces } from "node:os";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { ArkadeRail } from "@pumpstr/payment-rail/arkade"; // ADR-007 : tout le money passe par le rail
import { SimplePool, getPublicKey, verifyEvent, finalizeEvent, nip19 } from "nostr-tools";
import { createHandler } from "./server-core.js";
import { PumpstrDb, defaultDbPath } from "./db.js";
import { createRelay } from "./relay.js";
import { createSignaling } from "./signaling.js";

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

// --- Config réseau persistante : charge node/.env s'il existe (Node >=20.12) ---
try {
  const envFile = fileURLToPath(new URL(".env", import.meta.url));
  if (existsSync(envFile)) { (process as any).loadEnvFile(envFile); console.log(`[env] chargé : ${envFile}`); }
} catch (e: any) { console.error("[env] .env non chargé:", e?.message ?? e); }

const PORT = Number(process.env.PORT ?? 4242);
const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";
const BOLTZ_NETWORK = process.env.BOLTZ_NETWORK ?? "mutinynet";
const RELAYS = (process.env.NOSTR_RELAYS || "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net")
  .split(",").map((s) => s.trim()).filter(Boolean);
const STREAM = {
  d: process.env.STREAM_D ?? "pumpstr-live",
  title: process.env.STREAM_TITLE ?? "🔴 Pumpstr live",
  summary: process.env.STREAM_SUMMARY ?? "Streaming souverain sur Bitcoin — tips en sats, en direct.",
  url: process.env.STREAM_URL ?? "",
  image: process.env.STREAM_IMAGE ?? "",
};
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const KEY_FILE = process.env.KEY_FILE ?? join(HERE, ".creator-key");

const TLS_DIR = join(HERE, ".tls");
const TLS_KEY = join(TLS_DIR, "key.pem");
const TLS_CERT = join(TLS_DIR, "cert.pem");
function localIps(): string[] {
  const ips = new Set(["127.0.0.1"]);
  for (const nets of Object.values(networkInterfaces())) for (const n of nets ?? []) if (n.family === "IPv4" && !n.internal) ips.add(n.address);
  return [...ips];
}
function ensureTlsCert(): boolean {
  if (existsSync(TLS_KEY) && existsSync(TLS_CERT)) return true;
  try {
    mkdirSync(TLS_DIR, { recursive: true });
    const san = "subjectAltName=DNS:localhost," + localIps().map((ip) => `IP:${ip}`).join(",");
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", TLS_KEY, "-out", TLS_CERT,
      "-days", "825", "-subj", "/CN=pumpstr-local", "-addext", san], { stdio: "ignore" });
    console.log(`[tls] certificat auto-signé généré (${san})`);
    return true;
  } catch (e: any) { console.error("[tls] HTTPS indispo (openssl absent ?) :", e?.message ?? e); return false; }
}

const LN_ADDRESS_USER = process.env.LN_ADDRESS_USER || "pay";
const LN_ADDRESS_BASE = (process.env.LN_ADDRESS_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const lnAddress = `${LN_ADDRESS_USER}@${LN_ADDRESS_BASE.replace(/^https?:\/\//, "")}`;
const lnMetadata = JSON.stringify([["text/plain", `Tip ⚡ ${lnAddress} (Pumpstr)`], ["text/identifier", lnAddress]]);

const PLATFORM_SPLIT_BPS = Number(process.env.PLATFORM_SPLIT_BPS ?? 0);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || LN_ADDRESS_BASE).replace(/\/$/, "");

const ACTIONS = [
  { id: "horn", label: "Klaxon", emoji: "📯", sats: 500, effect: "horn" },
  { id: "hearts", label: "Pluie de cœurs", emoji: "💚", sats: 1000, effect: "hearts" },
  { id: "confetti", label: "Confettis", emoji: "🎉", sats: 2100, effect: "confetti" },
  { id: "rainbow", label: "Arc-en-ciel", emoji: "🌈", sats: 5000, effect: "rainbow" },
  { id: "mega", label: "MEGA HYPE", emoji: "🚀", sats: 21000, effect: "mega" },
];

function loadOrCreateKeyHex(): string {
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  const hex = Buffer.from(b).toString("hex");
  writeFileSync(KEY_FILE, hex);
  console.log(`[key] nouvelle clé créée → ${KEY_FILE} (BACKUP CE FICHIER)`);
  return hex;
}

// --- identités ----------
type Tipper = { name: string; pubkey?: string; picture?: string; comment?: string; via: string };
let creatorAddress = "";

// --- Persistance SQLite ----------
const db = new PumpstrDb(defaultDbPath(HERE));
console.log(`[db] persistance SQLite : ${defaultDbPath(HERE)}`);

// --- Relay Nostr embarqué (NIP-01) ----------
const relay = createRelay();

// --- Nostr (résolution de profil + vérif des zap requests) ----------
const pool = new SimplePool();
const profileCache = new Map<string, { name: string; picture?: string }>();
const MAX_PROFILE_CACHE = 2000; // HARDENING H3 : limite du cache
const shortNpub = (pubkey: string) => {
  try { return nip19.npubEncode(pubkey).slice(0, 11) + "…"; } catch { return pubkey.slice(0, 8) + "…"; }
};
async function resolveProfile(pubkey: string): Promise<{ name: string; picture?: string }> {
  if (profileCache.has(pubkey)) return profileCache.get(pubkey)!;
  // HARDENING H3 : éviction LRU si plein
  if (profileCache.size >= MAX_PROFILE_CACHE) {
    const first = profileCache.keys().next().value;
    profileCache.delete(first);
  }
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
  return { name: (body?.name || "anon").toString().slice(0, 24), comment: (body?.comment ?? "").toString().slice(0, 140), via };
}

// --- Arkade via le PaymentRail (ADR-007) ----------
console.log(`[arkade] connexion à ${ARK_SERVER_URL} ...`);
const keyHex = loadOrCreateKeyHex();
const creatorSk = Uint8Array.from(Buffer.from(keyHex, "hex"));
const creatorPubkey = getPublicKey(creatorSk);
const creatorNpub = nip19.npubEncode(creatorPubkey);
const rail = await ArkadeRail.fromSeed(keyHex, {
  arkServerUrl: ARK_SERVER_URL,
  boltzNetwork: BOLTZ_NETWORK as any,
  lnAutoClaim: false,
});
creatorAddress = await rail.getAddress();
console.log(`[arkade] créateur prêt`);
console.log(`  adresse : ${creatorAddress}`);
console.log(`  npub    : ${creatorNpub}`);

// --- WebSocket : pousse les tips ----------
const clients = new Set<WebSocket>();
// M4 : livePot persistant dans SQLite
let livePot = db.getLivePot();
function broadcast(msg: object) {
  const s = JSON.stringify(msg);
  for (const c of clients) {
    if (c.readyState === 1) {
      try { c.send(s); } catch { /* client mort */ }
    }
  }
}

// Signaling WebRTC (go-live P2P)
const sig = createSignaling((msg) => broadcast(msg), {
  onGoLive: () => { livePot = 0; db.setLivePot(0); broadcast({ type: "pot", pot: 0 }); },
  onEndLive: () => { /* B1 : le live est terminé, publishLive s'en occupera */ },
});
function registerTip(amount: number, t: Tipper) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const at = Date.now();
  livePot += amount;
  db.setLivePot(livePot); // M4 : persistance
  const action = ACTIONS.find((a) => a.sats === amount);
  db.addTip({ amount, name: t.name, picture: t.picture, pubkey: t.pubkey, comment: t.comment, via: t.via, createdAt: at });
  broadcast({ type: "tip", amount, at, name: t.name, pubkey: t.pubkey, picture: t.picture, comment: t.comment, via: t.via, pot: livePot,
    action: action ? { id: action.id, label: action.label, emoji: action.emoji, effect: action.effect } : undefined });
  console.log(`[tip] +${amount} sats — ${t.name} (${t.via})${t.comment ? ` : "${t.comment}"` : ""}`);
}

// --- NIP-53 : publier le live sur Nostr ----------
const startedAt = Math.floor(Date.now() / 1000);
function buildLiveEvent(status: "live" | "ended", participants: number) {
  const now = Math.floor(Date.now() / 1000);
  const tags: string[][] = [
    ["d", STREAM.d],
    ["title", STREAM.title],
    ["summary", STREAM.summary],
    ["status", status],
    ["starts", String(startedAt)],
    ["current_participants", String(participants)],
    ["p", creatorPubkey, RELAYS[0] ?? "", "host"],
    ["t", "pumpstr"],
    ["client", "pumpstr"],
  ];
  if (STREAM.url) tags.push(["streaming", STREAM.url]);
  if (STREAM.image) tags.push(["image", STREAM.image]);
  tags.push(["r", PUBLIC_BASE]);
  if (status === "ended") tags.push(["ends", String(now)]);
  return finalizeEvent({ kind: 30311, created_at: now, content: "", tags }, creatorSk);
}
async function publishLive(status: "live" | "ended") {
  const ev = buildLiveEvent(status, sig.viewerCount());
  relay.publishLocal(ev as any);
  try {
    await Promise.any(pool.publish(RELAYS, ev));
    console.log(`[nostr] live "${status}" publié (kind:30311 d=${STREAM.d}, ${sig.viewerCount()} viewers) -> ${RELAYS.length} relais`);
  } catch (e: any) {
    console.error("[nostr] publishLive:", e?.message ?? e);
  }
}

// --- NIP-57 : zap receipt ----------
async function publishZapReceipt(zapRequest: any, bolt11: string, amountSats: number) {
  try {
    const receipt = finalizeEvent({
      kind: 9735,
      created_at: Math.floor(Date.now() / 1000),
      content: typeof zapRequest?.content === "string" ? zapRequest.content : "",
      tags: [
        ["p", creatorPubkey],
        ...(zapRequest?.pubkey ? [["P", zapRequest.pubkey]] : []),
        ["bolt11", bolt11],
        ["description", JSON.stringify(zapRequest)],
        ["amount", String(amountSats * 1000)],
      ],
    }, creatorSk);
    relay.publishLocal(receipt as any);
    await Promise.any(pool.publish(RELAYS, receipt));
    console.log(`[nostr] zap receipt 9735 publié (${amountSats} sats)`);
  } catch (e: any) {
    console.error("[nostr] zap receipt:", e?.message ?? e);
  }
}

// --- NIP : notifier le bénéficiaire d'un reward ----------
async function publishRewardNote(pubkey: string, amount: number, claimUrl: string, reason: string) {
  try {
    const note = finalizeEvent({
      kind: 1,
      created_at: Math.floor(Date.now() / 1000),
      content: `🎁 Tu as reçu un reward Pumpstr de ${amount} sats${reason ? ` — ${reason}` : ""}. Réclame-le (self-custody) : ${claimUrl}`,
      tags: [["p", pubkey], ["t", "pumpstr"], ["t", "pumpstrreward"]],
    }, creatorSk);
    relay.publishLocal(note as any);
    await Promise.any(pool.publish(RELAYS, note));
    console.log(`[reward] note Nostr -> ${shortNpub(pubkey)} (${amount} sats)`);
  } catch (e: any) {
    console.error("[reward] note:", e?.message ?? e);
  }
}

// --- Vidéo : provisionnement Cloudflare Stream ----------
async function provisionCloudflareLive(): Promise<void> {
  const acct = process.env.CLOUDFLARE_STREAM_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_STREAM_API_TOKEN;
  const code = process.env.CLOUDFLARE_STREAM_CUSTOMER_CODE;
  if (STREAM.url || !acct || !token) return;
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
      console.log(`        ⚠️ définis CLOUDFLARE_STREAM_CUSTOMER_CODE pour l'URL de lecture`);
    }
  } catch (e: any) {
    console.error("[video] provisionnement Cloudflare échoué:", e?.message ?? e);
  }
}

// --- détection temps réel + dédup des tips identifiés ----------
const claimedTxids = new Set<string>();
// B2 : mutex pour éviter la race condition entre settleAndZap et onIncomingFunds
let incomingFundsLock = false;
const sumValue = (coins: any[] = []) => coins.reduce((s, c) => s + Number(c?.value ?? c?.amount ?? 0), 0);
let stopWatch: (() => void) | undefined;

try {
  stopWatch = await rail.onIncomingFunds((funds: any) => {
    if (incomingFundsLock) {
      console.log("[arkade] incomingFunds ignoré (lock actif — settle en cours)");
      return;
    }
    if (Array.isArray(funds?.newVtxos)) {
      const fresh = funds.newVtxos.filter((v: any) => !claimedTxids.has(v.txid));
      for (const v of funds.newVtxos) claimedTxids.delete(v.txid);
      const net = sumValue(fresh) - sumValue(funds.spentVtxos);
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
  await publishLive("ended").catch(() => {});
  pool.close(RELAYS);
  process.exit(0);
});

await provisionCloudflareLive();

// --- HTTP ----------
const handler = createHandler({
  rail,
  config: {
    port: PORT,
    lnAddressUser: LN_ADDRESS_USER,
    lnAddressBase: LN_ADDRESS_BASE,
    lnMetadata,
    creatorAddress,
    creatorPubkey,
    creatorNpub,
    stream: STREAM,
    publicBase: PUBLIC_BASE,
    adminToken: ADMIN_TOKEN,
    platformSplitBps: PLATFORM_SPLIT_BPS,
    actions: ACTIONS,
  },
  db,
  state: { claimedTxids, incomingFundsLock },
  helpers: {
    registerTip,
    publishZapReceipt,
    publishRewardNote,
    tipperFromBody,
    broadcast,
  },
  fs: { publicDir: PUBLIC, portalDir: join(HERE, "..", "portal") },
});
const server = createServer(handler);

// --- WS : 2 serveurs (noServer) routés par path ----------
const wss = new WebSocketServer({ noServer: true });
// B4 : heartbeat WS pour détecter les clients morts
const HEARTBEAT_INTERVAL = 30000;
const deadClients = new Set<WebSocket>();
function heartbeat() { deadClients.clear(); }
setInterval(() => {
  for (const c of clients) {
    if ((c as any).pumpstrAlive === false) {
      deadClients.add(c);
      try { c.terminate(); } catch {}
    } else {
      (c as any).pumpstrAlive = false;
      try { c.ping(); } catch {}
    }
  }
  for (const c of deadClients) clients.delete(c);
}, HEARTBEAT_INTERVAL);

wss.on("connection", (ws) => {
  clients.add(ws);
  (ws as any).pumpstrAlive = true;
  ws.on("pong", () => { (ws as any).pumpstrAlive = true; });
  ws.send(JSON.stringify({ type: "hello", address: creatorAddress, npub: creatorNpub, recentTips: db.recentTips(), live: sig.isLive(), pot: livePot }));
  ws.on("message", (data: any) => { let m: any; try { m = JSON.parse(data.toString()); } catch { return; } sig.onMessage(ws as any, m); });
  ws.on("close", () => { clients.delete(ws); sig.detach(ws as any); });
});

const relayWss = new WebSocketServer({ noServer: true });
relayWss.on("connection", (ws) => relay.onConnection(ws as any));

function routeUpgrade(req: any, socket: any, head: any) {
  let pathname = "/";
  try { pathname = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).pathname; } catch { /* */ }
  if (pathname === "/ws") wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else if (pathname === "/relay") relayWss.handleUpgrade(req, socket, head, (ws) => relayWss.emit("connection", ws, req));
  else socket.destroy();
}
server.on("upgrade", routeUpgrade);

server.listen(PORT, () => {
  console.log(`\n  🔥 PUMPSTR node en ligne :`);
  console.log(`     console créateur     : http://localhost:${PORT}/dashboard.html`);
  console.log(`     overlay (source OBS) : http://localhost:${PORT}/overlay.html`);
  console.log(`     page tip (viewer)    : http://localhost:${PORT}/tip.html`);
  console.log(`     portail fédéré       : http://localhost:${PORT}/portal`);
  console.log(`     relay Nostr embarqué : ws://localhost:${PORT}/relay  (NIP-01)`);
  console.log(`     lightning address    : ${lnAddress}\n`);
  publishLive("live");
  // B1 : vérifie sig.isLive() avant de republier
  setInterval(() => { if (sig.isLive()) publishLive("live"); }, 45_000);
});

// --- HTTPS local ----------
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? PORT + 1);
if (process.env.HTTPS !== "0" && ensureTlsCert()) {
  try {
    const httpsServer = createHttpsServer({ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) }, handler);
    httpsServer.on("upgrade", routeUpgrade);
    httpsServer.on("error", (e: any) => console.error("[tls] serveur HTTPS:", e?.message ?? e));
    httpsServer.listen(HTTPS_PORT, () => {
      const ip = localIps().find((x) => x.startsWith("192.168.")) ?? localIps().find((x) => x !== "127.0.0.1") ?? "localhost";
      console.log(`  🔒 HTTPS (cam/micro, cert auto-signé) :`);
      console.log(`     Studio sur le tel    : https://${ip}:${HTTPS_PORT}/studio.html  (accepte l'alerte de sécurité 1×)`);
      console.log(`     console / overlay…   : https://${ip}:${HTTPS_PORT}/dashboard.html\n`);
    });
  } catch (e: any) { console.error("[tls] HTTPS non démarré:", e?.message ?? e); }
}
