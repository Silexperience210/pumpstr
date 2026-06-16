/**
 * portal/indexer.ts — indexer backend OPTIONNEL pour le portail fédéré Pumpstr.
 *
 * Le portail reste 100 % fonctionnel en client Nostr pur (index.html). Cet indexer
 * est un confort : il cache/classe les events NIP-53 #pumpstr et expose une API REST
 * légère. Il ne contrôle rien : n'importe qui peut lancer un autre indexer/portail.
 *
 * Run : npm run start:indexer
 */
import "fake-indexeddb/auto"; // nostr-tools peut l'utiliser indirectement
import { EventSource } from "eventsource";
(globalThis as any).EventSource ??= EventSource;
import { createServer } from "node:http";
import { SimplePool, nip19 } from "nostr-tools";

const PORT = Number(process.env.PORT ?? 4243);
const RELAYS = (process.env.NOSTR_RELAYS || "wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_AGE_MS = Number(process.env.MAX_AGE_MS ?? 24 * 3600 * 1000); // garde les events 24h

interface LiveEvent {
  id: string;
  pubkey: string;
  d: string;
  title: string;
  summary: string;
  status: "live" | "ended";
  streaming?: string;
  image?: string;
  nodeUrl?: string;
  viewers: number;
  starts?: number;
  createdAt: number;
}

const pool = new SimplePool();
const lives = new Map<string, LiveEvent>(); // key = pubkey:d

export function tagv(ev: any, k: string): string | undefined {
  return (ev.tags.find((t: string[]) => t[0] === k) || [])[1];
}

export function upsert(ev: any) {
  const d = tagv(ev, "d") || "";
  const key = `${ev.pubkey}:${d}`;
  const prev = lives.get(key);
  if (prev && prev.createdAt >= ev.created_at * 1000) return;

  const status = tagv(ev, "status") || "live";
  lives.set(key, {
    id: ev.id,
    pubkey: ev.pubkey,
    d,
    title: tagv(ev, "title") || "Live",
    summary: tagv(ev, "summary") || "",
    status: status === "live" ? "live" : "ended",
    streaming: tagv(ev, "streaming"),
    image: tagv(ev, "image"),
    nodeUrl: tagv(ev, "r"),
    viewers: Number(tagv(ev, "current_participants") || 0),
    starts: tagv(ev, "starts") ? Number(tagv(ev, "starts")) : undefined,
    createdAt: ev.created_at * 1000,
  });
}

export function resetCache() {
  lives.clear();
}

function cleanupInternal() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of lives) {
    if (v.createdAt < cutoff) lives.delete(k);
  }
}

export function cleanup() {
  cleanupInternal();
}

export function list(status?: string): LiveEvent[] {
  const arr = [...lives.values()];
  if (status === "live") return arr.filter((x) => x.status === "live");
  if (status === "ended") return arr.filter((x) => x.status === "ended");
  return arr.sort((a, b) => {
    const sa = a.status === "live" ? 1 : 0, sb = b.status === "live" ? 1 : 0;
    return sb - sa || b.createdAt - a.createdAt;
  });
}

async function bootstrap() {
  // Récupère les events existants
  const existing = await pool.querySync(RELAYS, { kinds: [30311], "#t": ["pumpstr"] });
  for (const ev of existing) upsert(ev);
  console.log(`[indexer] ${lives.size} live(s) en cache initial`);

  // Souscription temps réel
  pool.subscribeMany(RELAYS, [{ kinds: [30311], "#t": ["pumpstr"] }] as any, {
    onevent: upsert,
  });
}

function sendJson(res: any, code: number, body: object) {
  res.statusCode = code;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/api/lives") {
    const status = url.searchParams.get("status") ?? undefined;
    return sendJson(res, 200, { count: lives.size, lives: list(status) });
  }

  if (url.pathname === "/api/live" && req.method === "GET") {
    const pubkey = url.searchParams.get("pubkey");
    const d = url.searchParams.get("d") || "";
    if (!pubkey) return sendJson(res, 400, { error: "pubkey requis" });
    const live = lives.get(`${pubkey}:${d}`);
    if (!live) return sendJson(res, 404, { error: "live inconnu" });
    return sendJson(res, 200, live);
  }

  if (url.pathname === "/health") {
    return sendJson(res, 200, { ok: true, lives: lives.size });
  }

  res.statusCode = 404;
  res.end("not found");
});

export async function startIndexer() {
  setInterval(cleanupInternal, 60_000);
  server.listen(PORT, async () => {
    console.log(`[indexer] écoute sur http://localhost:${PORT}`);
    console.log(`[indexer] relais : ${RELAYS.join(", ")}`);
    await bootstrap();
  });
  process.on("SIGINT", () => { pool.close(RELAYS); process.exit(0); });
}

// Ne démarre le serveur que si ce fichier est le point d'entrée (pas en test/import).
const isMainEntry = import.meta.url.startsWith("file:") && process.argv[1]?.includes("indexer.ts");
if (isMainEntry) startIndexer();
