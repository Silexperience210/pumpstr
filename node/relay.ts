/**
 * relay.ts — relay Nostr (NIP-01) minimal EMBARQUÉ dans le node Pumpstr.
 *
 * Rend le node auto-suffisant pour la fédération : ses lives (kind:30311), ses
 * zap receipts (9735) et ses notes de reward (1) restent lisibles depuis
 * `ws:///relay` même si les relais publics sont injoignables. C'est une
 * source souveraine de plus, pas un chokepoint : le portail agrège déjà
 * plusieurs relais (ADR-003), celui-ci en est juste un que LE node garantit.
 *
 * Stockage 100 % mémoire, borné (pas de dépendance externe). Events remplaçables
 * gérés selon NIP-01 (kind 0/3, 10000–19999 par auteur ; 30000–39999 par auteur+`d`).
 *
 * Le wiring WebSocket (2ᵉ WSS sur `/relay`) vit dans server.ts ; ici tout est pur
 * et testable. `verify` est injectable pour les tests (sinon vérif réelle).
 */
import { verifyEvent } from "nostr-tools";

export interface NostrEvent {
  id: string; pubkey: string; created_at: number; kind: number; tags: string[][]; content: string; sig: string;
}
export interface Filter {
  ids?: string[]; authors?: string[]; kinds?: number[]; since?: number; until?: number; limit?: number;
  [tag: string]: string[] | undefined;
}

export function replaceableKey(ev: NostrEvent): string | null {
  const { kind, pubkey } = ev;
  if (kind === 0 || kind === 3 || (kind >= 10000 && kind < 20000)) return `${kind}:${pubkey}`;
  if (kind >= 30000 && kind < 40000) {
    const d = (ev.tags.find((t) => t[0] === "d") || [])[1] || "";
    return `${kind}:${pubkey}:${d}`;
  }
  return null;
}

export function matchFilter(ev: NostrEvent, f: Filter): boolean {
  if (f.ids && !f.ids.includes(ev.id)) return false;
  if (f.authors && !f.authors.includes(ev.pubkey)) return false;
  if (f.kinds && !f.kinds.includes(ev.kind)) return false;
  if (typeof f.since === "number" && ev.created_at < f.since) return false;
  if (typeof f.until === "number" && ev.created_at > f.until) return false;
  for (const key of Object.keys(f)) {
    if (key[0] !== "#") continue;
    const want = (f as any)[key] as string[];
    const tag = key.slice(1);
    const have = ev.tags.filter((t) => t[0] === tag).map((t) => t[1]);
    if (!want.some((v) => have.includes(v))) return false;
  }
  return true;
}

export const matchAny = (ev: NostrEvent, filters: Filter[]): boolean => filters.some((f) => matchFilter(ev, f));

export class RelayStore {
  private byId = new Map<string, NostrEvent>();
  private repl = new Map<string, string>();
  constructor(private max = 5000) {}

  add(ev: NostrEvent): "ok" | "dup" | "old" {
    if (this.byId.has(ev.id)) return "dup";
    const rk = replaceableKey(ev);
    if (rk) {
      const prevId = this.repl.get(rk);
      const prev = prevId ? this.byId.get(prevId) : undefined;
      if (prev && prev.created_at >= ev.created_at) return "old";
      if (prevId) this.byId.delete(prevId);
      this.repl.set(rk, ev.id);
    }
    this.byId.set(ev.id, ev);
    if (this.byId.size > this.max) {
      const oldest = this.byId.keys().next().value;
      if (oldest !== undefined) this.byId.delete(oldest);
    }
    return "ok";
  }

  query(filters: Filter[], hardLimit = 500): NostrEvent[] {
    const out: NostrEvent[] = [];
    for (const ev of this.byId.values()) if (matchAny(ev, filters)) out.push(ev);
    out.sort((a, b) => b.created_at - a.created_at);
    const limit = Math.min(hardLimit, ...filters.map((f) => f.limit ?? hardLimit));
    return out.slice(0, Math.max(0, limit));
  }

  get size(): number { return this.byId.size; }
}

type WsLike = { readyState: number; send: (s: string) => void; on: (ev: string, cb: (...a: any[]) => void) => void };

// H6 : rate limiting du relay (events par minute par IP)
class RelayRateLimit {
  private events = new Map<string, { count: number; resetAt: number }>();
  private maxPerWindow = 120; // 2 events/sec en moyenne
  private windowMs = 60_000;

  check(ip: string): boolean {
    const now = Date.now();
    const bucket = this.events.get(ip);
    if (!bucket || bucket.resetAt <= now) {
      this.events.set(ip, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (bucket.count >= this.maxPerWindow) return false;
    bucket.count++;
    return true;
  }
}

export function createRelay(opts: { max?: number; verify?: (ev: any) => boolean } = {}) {
  const store = new RelayStore(opts.max);
  const verify = opts.verify ?? verifyEvent;
  const subs = new Map<WsLike, Map<string, Filter[]>>();
  const rateLimit = new RelayRateLimit();

  function fanout(ev: NostrEvent) {
    for (const [ws, m] of subs) {
      if (ws.readyState !== 1) continue;
      for (const [subId, filters] of m) if (matchAny(ev, filters)) ws.send(JSON.stringify(["EVENT", subId, ev]));
    }
  }

  function publishLocal(ev: NostrEvent) {
    if (store.add(ev) === "ok") fanout(ev);
  }

  function onConnection(ws: WsLike, ip?: string) {
    subs.set(ws, new Map());
    ws.on("message", (data: any) => {
      let msg: any;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (!Array.isArray(msg) || !msg.length) return;
      const type = msg[0];

      if (type === "EVENT") {
        const ev = msg[1];
        if (!ev || typeof ev.id !== "string") return;
        // H6 : rate limit
        if (ip && !rateLimit.check(ip)) {
          ws.send(JSON.stringify(["OK", ev.id, false, "rate-limited: too many events"]));
          return;
        }
        let ok = false;
        try { ok = verify(ev); } catch { ok = false; }
        if (!ok) return ws.send(JSON.stringify(["OK", ev.id, false, "invalid: bad signature"]));
        const r = store.add(ev);
        ws.send(JSON.stringify(["OK", ev.id, true, r === "dup" ? "duplicate:" : ""]));
        if (r === "ok") fanout(ev);

      } else if (type === "REQ") {
        const subId = String(msg[1]);
        const filters: Filter[] = msg.slice(2);
        subs.get(ws)?.set(subId, filters);
        for (const ev of store.query(filters)) ws.send(JSON.stringify(["EVENT", subId, ev]));
        ws.send(JSON.stringify(["EOSE", subId]));

      } else if (type === "CLOSE") {
        subs.get(ws)?.delete(String(msg[1]));
      }
    });
    ws.on("close", () => subs.delete(ws));
  }

  return { store, onConnection, publishLocal };
}
