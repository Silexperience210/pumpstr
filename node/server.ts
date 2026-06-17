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
// Fige mainnet/signet sans dépendre d'une variable d'env au lancement (un restart
// ne doit jamais retomber en signet en silence quand on croit être en mainnet).
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
  url: process.env.STREAM_URL ?? "",     // URL HLS (la vidéo = couche suivante) ; vide pour l'instant
  image: process.env.STREAM_IMAGE ?? "", // miniature
};
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const KEY_FILE = process.env.KEY_FILE ?? join(HERE, ".creator-key"); // en conteneur : monté sur un volume

// HTTPS local (cert auto-signé) : getUserMedia (caméra/micro du Studio, scan QR) exige un
// contexte sécurisé -> bloqué sur http://<IP-LAN>. On sert AUSSI en https (port HTTPS_PORT)
// pour que ça marche sur le tel (accepter l'alerte de cert auto-signé). http reste intact.
const TLS_DIR = join(HERE, ".tls");
const TLS_KEY = join(TLS_DIR, "key.pem");
const TLS_CERT = join(TLS_DIR, "cert.pem");
function localIps(): string[] {
  const ips = new Set<string>(["127.0.0.1"]);
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
// Lightning Address (LUD-16) : <user>@<domaine>. En prod, mets LN_ADDRESS_BASE_URL=https://ton-domaine
// (exposé via Cloudflare Tunnel sur Umbrel) pour que n'importe quel wallet LN puisse payer.
const LN_ADDRESS_USER = process.env.LN_ADDRESS_USER || "pay";
const LN_ADDRESS_BASE = (process.env.LN_ADDRESS_BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const lnAddress = `${LN_ADDRESS_USER}@${LN_ADDRESS_BASE.replace(/^https?:\/\//, "")}`;
const lnMetadata = JSON.stringify([["text/plain", `Tip ⚡ ${lnAddress} (Pumpstr)`], ["text/identifier", lnAddress]]);

// --- Rewards : escrow réclamable (ADR-004/006). Le créateur récompense un bénéficiaire (npub),
// potentiellement offline ; les sats sont parqués dans un VTXO que LUI SEUL réclame (sa clé). ---
const PLATFORM_SPLIT_BPS = Number(process.env.PLATFORM_SPLIT_BPS ?? 0);        // part plateforme (ADR-006)
const ADMIN_TOKEN = process.env.ADMIN_TOKEN ?? "";                            // si défini : requis pour créer
const PUBLIC_BASE = (process.env.PUBLIC_BASE_URL || LN_ADDRESS_BASE).replace(/\/$/, "");

// Tip-to-trigger : tiper EXACTEMENT ce prix déclenche l'effet (overlay + viewers).
const ACTIONS = [
  { id: "horn",     label: "Klaxon",         emoji: "📯", sats: 500,   effect: "horn" },
  { id: "hearts",   label: "Pluie de cœurs", emoji: "💚", sats: 1000,  effect: "hearts" },
  { id: "confetti", label: "Confettis",      emoji: "🎉", sats: 2100,  effect: "confetti" },
  { id: "rainbow",  label: "Arc-en-ciel",    emoji: "🌈", sats: 5000,  effect: "rainbow" },
  { id: "mega",     label: "MEGA HYPE",      emoji: "🚀", sats: 21000, effect: "mega" },
];

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

// ---------- Persistance SQLite ----------
const db = new PumpstrDb(defaultDbPath(HERE));
console.log(`[db] persistance SQLite : ${defaultDbPath(HERE)}`);

// ---------- Relay Nostr embarqué (NIP-01) ----------
// Source fédérée souveraine : le node sert ses propres events (lives 30311, zap
// receipts 9735, notes reward) sur ws://<node>/relay, même si les relais publics
// sont injoignables. Pas un chokepoint — juste un relais de plus, garanti par le node.
const relay = createRelay();

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

// ---------- Arkade via le PaymentRail (ADR-007) ----------
// La MÊME clé dérive le wallet Arkade (rail) ET l'identité Nostr (ici) — ADR-004.
console.log(`[arkade] connexion à ${ARK_SERVER_URL} ...`);
const keyHex = loadOrCreateKeyHex();
const creatorSk = Uint8Array.from(Buffer.from(keyHex, "hex"));
const creatorPubkey = getPublicKey(creatorSk);
const creatorNpub = nip19.npubEncode(creatorPubkey);
// lnAutoClaim:false -> on règle explicitement (settle) pour corréler identité↔paiement.
const rail = await ArkadeRail.fromSeed(keyHex, {
  arkServerUrl: ARK_SERVER_URL,
  boltzNetwork: BOLTZ_NETWORK as any,
  lnAutoClaim: false,
});
creatorAddress = await rail.getAddress();
console.log(`[arkade] créateur prêt`);
console.log(`         adresse : ${creatorAddress}`);
console.log(`         npub    : ${creatorNpub}`);

// ---------- WebSocket : pousse les tips ----------
const clients = new Set<WebSocket>();
let livePot = 0; // cagnotte du live courant (sats) : reset au go-live, diffusée avec chaque tip
function broadcast(msg: object) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}

// Signaling WebRTC (go-live P2P) : relaie offer/answer/ICE entre le créateur et les viewers.
// onGoLive : la cagnotte du live repart de zéro et on prévient tous les viewers.
const sig = createSignaling((msg) => broadcast(msg), { onGoLive: () => { livePot = 0; broadcast({ type: "pot", pot: 0 }); } });
function registerTip(amount: number, t: Tipper) {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const at = Date.now();
  livePot += amount;
  const action = ACTIONS.find((a) => a.sats === amount); // prix exact -> effet déclenché
  db.addTip({ amount, name: t.name, picture: t.picture, pubkey: t.pubkey, comment: t.comment, via: t.via, createdAt: at });
  broadcast({ type: "tip", amount, at, name: t.name, pubkey: t.pubkey, picture: t.picture, comment: t.comment, via: t.via, pot: livePot,
    action: action ? { id: action.id, label: action.label, emoji: action.emoji, effect: action.effect } : undefined });
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
  tags.push(["r", PUBLIC_BASE]); // URL du node pour que le portail redirige le viewer
  if (status === "ended") tags.push(["ends", String(now)]);
  return finalizeEvent({ kind: 30311, created_at: now, content: "", tags }, creatorSk);
}
async function publishLive(status: "live" | "ended") {
  const ev = buildLiveEvent(status, clients.size);
  relay.publishLocal(ev as any); // toujours dispo sur le relay local, même si les relais publics échouent
  try {
    await Promise.any(pool.publish(RELAYS, ev));
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
    relay.publishLocal(receipt as any); // le leaderboard/portail peut lire ce zap depuis le relay local
    await Promise.any(pool.publish(RELAYS, receipt));
    console.log(`[nostr] zap receipt 9735 publié (${amountSats} sats)`);
  } catch (e: any) {
    console.error("[nostr] zap receipt:", e?.message ?? e);
  }
}

// ---------- NIP : notifier le bénéficiaire d'un reward (kind:1 le taguant) ----------
// Le ref n'est pas un secret (le VTXO n'est réclamable que par la clé du bénéficiaire) ; on
// pointe quand même vers une page de claim plutôt que de l'exposer en clair dans la note.
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
  stopWatch = await rail.onIncomingFunds((funds: any) => {
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
  state: { claimedTxids },
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

// ---------- WS : 2 serveurs (noServer) routés par path sur l'upgrade ----------
// /ws    -> flux de tips temps réel (overlay/watch/tip/dashboard)
// /relay -> relay Nostr embarqué (NIP-01)
// (un seul routeur d'upgrade : deux WSS `{server,path}` se court-circuiteraient.)
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "hello", address: creatorAddress, npub: creatorNpub, recentTips: db.recentTips(), live: sig.isLive() }));
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
  publishLive("live");                            // annonce le live sur Nostr (NIP-53)
  setInterval(() => publishLive("live"), 45_000); // rafraîchit statut + nb de viewers
});

// ---------- HTTPS local (caméra/micro sur le tel via LAN) ----------
const HTTPS_PORT = Number(process.env.HTTPS_PORT ?? PORT + 1);
if (process.env.HTTPS !== "0" && ensureTlsCert()) {
  try {
    const httpsServer = createHttpsServer({ key: readFileSync(TLS_KEY), cert: readFileSync(TLS_CERT) }, handler);
    httpsServer.on("upgrade", routeUpgrade); // mêmes WS (wss) que le http
    httpsServer.on("error", (e: any) => console.error("[tls] serveur HTTPS:", e?.message ?? e));
    httpsServer.listen(HTTPS_PORT, () => {
      const ip = localIps().find((x) => x.startsWith("192.168.")) ?? localIps().find((x) => x !== "127.0.0.1") ?? "localhost";
      console.log(`  🔒 HTTPS (cam/micro, cert auto-signé) :`);
      console.log(`     Studio sur le tel    : https://${ip}:${HTTPS_PORT}/studio.html  (accepte l'alerte de sécurité 1×)`);
      console.log(`     console / overlay…   : https://${ip}:${HTTPS_PORT}/dashboard.html\n`);
    });
  } catch (e: any) { console.error("[tls] HTTPS non démarré:", e?.message ?? e); }
}
