/**
 * rate-limit.ts — rate limiting simple en mémoire pour le node Pumpstr.
 * Pas de dépendance externe ; adapté à un node auto-hébergé (pas de Redis).
 *
 * Stratégie : fenêtre glissante par clé (IP + route). Si la limite est dépassée,
 * on retourne un objet `{ limited: true, retryAfter: seconds }` que l'appelant
 * transforme en HTTP 429.
 */

type Bucket = { count: number; resetAt: number };

export interface RateLimitOptions {
  limit: number;
  windowMs: number;
  key?: string;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private defaultOpts: RateLimitOptions = { limit: 30, windowMs: 60_000 }) {}

  check(key: string, opts?: Partial<RateLimitOptions>): { limited: false } | { limited: true; retryAfter: number } {
    const { limit, windowMs } = { ...this.defaultOpts, ...opts };
    const now = Date.now();

    // H2 : nettoyage paresseux mais aussi périodique
    if (this.buckets.size > 10_000) this.cleanup(now);

    const bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      this.buckets.set(key, { count: 1, resetAt: now + windowMs });
      return { limited: false };
    }

    if (bucket.count >= limit) {
      return { limited: true, retryAfter: Math.ceil((bucket.resetAt - now) / 1000) };
    }

    bucket.count++;
    return { limited: false };
  }

  cleanup(now = Date.now()) {
    for (const [k, b] of this.buckets) {
      if (b.resetAt <= now) this.buckets.delete(k);
    }
  }

  reset() {
    this.buckets.clear();
  }
}

// H2 : nettoyage périodique global (toutes les 5 min)
export function startRateLimitCleanup(rl: RateLimiter, intervalMs = 300_000): () => void {
  const t = setInterval(() => rl.cleanup(), intervalMs);
  return () => clearInterval(t);
}

export function rateLimitKey(req: { socket?: { remoteAddress?: string }; headers?: Record<string, string> }, route: string): string {
  const forwarded = req.headers?.["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : req.socket?.remoteAddress) ?? "unknown";
  return `${ip}:${route}`;
}
