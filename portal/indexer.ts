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

// --------------------------------------------------------------------------
// Indexer trending/leaderboard FÉDÉRÉ : on agrège les zap receipts NIP-57
// (kind:9735) que les nodes publient sur chaque tip réglé. Chaque receipt tague
// l'hôte (`p`) et porte `amount` (msats). On somme par hôte -> classement par
// sats. 100 % lecture publique de Nostr : aucune base centrale, l'indexer reste
// une lentille remplaçable (ADR-003). Le trending pondère la récence (demi-vie).
// --------------------------------------------------------------------------
interface ZapAgg { total: number; count: number; recent: { amount: number; at: number }[]; }
const zaps = new Map<string, ZapAgg>();        // key = pubkey hôte -> sats agrégés
const seenZaps = new Map<string, number>();     // id receipt -> at (dédup + purge par âge)
const TRENDING_HALFLIFE_MS = Number(process.env.TRENDING_HALFLIFE_MS ?? 3600_000); // 1h

/** Ingère un zap receipt (kind:9735). Idempotent (dédup par id). Renvoie true si compté. */
export function ingestZap(ev: any): boolean {
  if (!ev?.id || seenZaps.has(ev.id)) return false;
  const host = tagv(ev, "p");
  const sats = Math.floor(Number(tagv(ev, "amount") || 0) / 1000); // amount = msats
  if (!host || !(sats > 0)) return false;
  const at = (ev.created_at ?? Math.floor(Date.now() / 1000)) * 1000;
  seenZaps.set(ev.id, at);
  const agg = zaps.get(host) ?? { total: 0, count: 0, recent: [] };
  agg.total += sats; agg.count += 1; agg.recent.push({ amount: sats, at });
  zaps.set(host, agg);
  return true;
}

/** Total de sats reçus par un hôte (all-time dans la fenêtre de cache). */
export function satsFor(pubkey: string): number {
  return zaps.get(pubkey)?.total ?? 0;
}

/** Score de tendance : sats pondérés par la récence (décroissance exponentielle). */
export function trendingScore(pubkey: string, now = Date.now()): number {
  const agg = zaps.get(pubkey);
  if (!agg) return 0;
  let s = 0;
  for (const z of agg.recent) s += z.amount * Math.pow(0.5, (now - z.at) / TRENDING_HALFLIFE_MS);
  return s;
}

/** Classement des créateurs par sats reçus (enrichi du titre du live si connu). */
export function leaderboard(limit = 10): { pubkey: string; sats: number; count: number; title?: string }[] {
  return [...zaps.entries()]
    .map(([pubkey, a]) => {
      const live = [...lives.values()].find((l) => l.pubkey === pubkey);
      return { pubkey, sats: a.total, count: a.count, title: live?.title };
    })
    .sort((x, y) => y.sats - x.sats)
    .slice(0, limit);
}

export function resetZaps() {
  zaps.clear(); seenZaps.clear();
}

function cleanupInternal() {
  const cutoff = Date.now() - MAX_AGE_MS;
  for (const [k, v] of lives) {
    if (v.createdAt < cutoff) lives.delete(k);
  }
  // purge les zaps anciens (récence pour le trending) + ids vus pour borner la mémoire
  for (const [id, at] of seenZaps) if (at < cutoff) seenZaps.delete(id);
  for (const agg of zaps.values()) agg.recent = agg.recent.filter((z) => z.at >= cutoff);
}

export function cleanup() {
  cleanupInternal();
}

export type LiveWithSats = LiveEvent & { sats: number };

export function list(status?: string, sort: "recent" | "trending" = "recent"): LiveWithSats[] {
  let arr: LiveWithSats[] = [...lives.values()].map((v) => ({ ...v, sats: satsFor(v.pubkey) }));
  if (status === "live") arr = arr.filter((x) => x.status === "live");
  else if (status === "ended") arr = arr.filter((x) => x.status === "ended");
  const now = Date.now();
  return arr.sort((a, b) => {
    const sa = a.status === "live" ? 1 : 0, sb = b.status === "live" ? 1 : 0;
    if (sb !== sa) return sb - sa;                 // live toujours en premier
    if (sort === "trending") {
      const ta = trendingScore(a.pubkey, now), tb = trendingScore(b.pubkey, now);
      if (tb !== ta) return tb - ta;               // puis vélocité de sats
    }
    return b.createdAt - a.createdAt;              // sinon (ou égalité) : récence
  });
}

// Souscription zaps (9735) : les receipts ne portent pas de #t, ils taguent l'hôte
// (`p`). On (re)souscrit sur l'ensemble des hôtes vus dans les lives 30311.
let zapSub: { close: () => void } | undefined;
let knownHosts = new Set<string>();
function refreshZapSub() {
  const hosts = [...new Set([...lives.values()].map((l) => l.pubkey))];
  if (hosts.length === knownHosts.size && hosts.every((h) => knownHosts.has(h))) return; // rien de neuf
  knownHosts = new Set(hosts);
  zapSub?.close();
  if (!hosts.length) return;
  zapSub = pool.subscribeMany(RELAYS, [{ kinds: [9735], "#p": hosts }] as any, { onevent: ingestZap });
  console.log(`[indexer] souscription zaps (9735) pour ${hosts.length} hôte(s)`);
}

async function bootstrap() {
  // Récupère les lives existants
  const existing = await pool.querySync(RELAYS, { kinds: [30311], "#t": ["pumpstr"] });
  for (const ev of existing) upsert(ev);
  console.log(`[indexer] ${lives.size} live(s) en cache initial`);

  // Agrège les zaps existants pour ces hôtes (classement dès le démarrage)
  const hosts = [...new Set([...lives.values()].map((l) => l.pubkey))];
  if (hosts.length) {
    const zr = await pool.querySync(RELAYS, { kinds: [9735], "#p": hosts });
    let n = 0; for (const ev of zr) if (ingestZap(ev)) n++;
    console.log(`[indexer] ${n} zap(s) agrégé(s) au démarrage`);
  }
  refreshZapSub();

  // Souscriptions temps réel (lives + zaps des nouveaux hôtes)
  pool.subscribeMany(RELAYS, [{ kinds: [30311], "#t": ["pumpstr"] }] as any, {
    onevent: (ev: any) => { upsert(ev); refreshZapSub(); },
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
    const sort = url.searchParams.get("sort") === "trending" ? "trending" : "recent";
    return sendJson(res, 200, { count: lives.size, lives: list(status, sort) });
  }

  if (url.pathname === "/api/leaderboard") {
    const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") || 10)));
    return sendJson(res, 200, { leaders: leaderboard(limit) });
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
