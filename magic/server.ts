/**
 * Pumpstr — la tranche magique (backend).
 *
 * Tient un VRAI wallet créateur Arkade (validé au spike A), expose :
 *   - une page overlay (source navigateur OBS) qui explose à chaque tip
 *   - une page tip (viewer) qui génère une vraie facture LN-in
 *   - un flux WebSocket qui pousse les tips en temps réel
 *
 * Détection des tips : poll du solde Arkade + diff. Un bouton "simulate" permet
 * de déclencher l'overlay sans sats (démo). Quand un vrai paiement LN arrive
 * (auto-claim Boltz), le solde monte → l'overlay réagit pareil.
 *
 * Run : npm start   (Node 22 LTS, réseau réel requis pour l'opérateur)
 */
import "fake-indexeddb/auto"; // Node n'a pas IndexedDB ; en RN -> ./adapters/asyncStorage
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { SingleKey, Wallet } from "@arkade-os/sdk";
import { ArkadeSwaps, BoltzSwapProvider } from "@arkade-os/boltz-swap";

const PORT = Number(process.env.PORT ?? 4242);
const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";
const BOLTZ_NETWORK = process.env.BOLTZ_NETWORK ?? "mutinynet";
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC = join(HERE, "public");
const KEY_FILE = join(HERE, ".creator-key");

function loadOrCreateKeyHex(): string {
  if (existsSync(KEY_FILE)) return readFileSync(KEY_FILE, "utf8").trim();
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  const hex = Buffer.from(b).toString("hex");
  writeFileSync(KEY_FILE, hex);
  return hex;
}

// ---------- état ----------
let creatorAddress = "";
let lastTotal = 0;
const recentTips: { amount: number; from: string; at: number }[] = [];

// ---------- Arkade (le vrai rail) ----------
console.log(`[arkade] connexion à ${ARK_SERVER_URL} ...`);
const identity = SingleKey.fromHex(loadOrCreateKeyHex());
const wallet = await Wallet.create({ identity, arkServerUrl: ARK_SERVER_URL });
creatorAddress = await wallet.getAddress();
const swaps = new ArkadeSwaps({
  wallet,
  swapProvider: new BoltzSwapProvider({ network: BOLTZ_NETWORK as any }),
  swapManager: true, // auto-claim des paiements LN entrants
});
try {
  const b: any = await wallet.getBalance();
  lastTotal = Number(b?.total ?? 0);
} catch { /* solde lu au prochain tick */ }
console.log(`[arkade] créateur prêt — adresse: ${creatorAddress}`);

// ---------- WebSocket : pousse les tips ----------
const clients = new Set<WebSocket>();
function broadcast(msg: object) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === 1) c.send(s);
}
function registerTip(amount: number, from = "anon", via = "demo") {
  if (!Number.isFinite(amount) || amount <= 0) return;
  const at = Date.now();
  recentTips.unshift({ amount, from, at });
  if (recentTips.length > 20) recentTips.length = 20;
  broadcast({ type: "tip", amount, from, via, at });
  console.log(`[tip] +${amount} sats — ${from} (${via})`);
}

// ---------- détection des vrais tips : poll + diff ----------
setInterval(async () => {
  try {
    const b: any = await wallet.getBalance();
    const total = Number(b?.total ?? 0);
    if (total > lastTotal) registerTip(total - lastTotal, "lightning", "ln");
    lastTotal = total;
  } catch { /* opérateur momentanément injoignable */ }
}, 4000);

// ---------- HTTP ----------
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};
function sendJson(res: any, code: number, body: object) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/api/creator") {
    return sendJson(res, 200, { address: creatorAddress, recentTips });
  }

  if (url.pathname === "/api/invoice" && req.method === "POST") {
    const amount = Number(url.searchParams.get("amount") ?? 1000);
    try {
      const r: any = await swaps.createLightningInvoice({ amount });
      const bolt11 = r?.invoice ?? r?.bolt11 ?? r?.paymentRequest ?? null;
      return sendJson(res, 200, { bolt11, amount });
    } catch (e: any) {
      return sendJson(res, 502, { error: e?.message ?? String(e) });
    }
  }

  if (url.pathname === "/api/simulate" && req.method === "POST") {
    const amount = Number(url.searchParams.get("amount") ?? Math.floor(Math.random() * 4900) + 100);
    const from = url.searchParams.get("from") ?? "demo";
    registerTip(amount, from, "demo");
    return sendJson(res, 200, { ok: true, amount, from });
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
  ws.send(JSON.stringify({ type: "hello", address: creatorAddress, recentTips }));
  ws.on("close", () => clients.delete(ws));
});

server.listen(PORT, () => {
  console.log(`\n  🔥 PUMPSTR magic slice en ligne :`);
  console.log(`     overlay (source OBS) : http://localhost:${PORT}/overlay.html`);
  console.log(`     page tip (viewer)    : http://localhost:${PORT}/tip.html`);
  console.log(`     simuler un tip       : curl -X POST "http://localhost:${PORT}/api/simulate?amount=2100&from=satoshi"\n`);
});
