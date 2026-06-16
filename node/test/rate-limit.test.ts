/**
 * Tests de rate-limit.ts — logique pure, sans réseau.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RateLimiter, rateLimitKey } from "../rate-limit.js";

test("RateLimiter autorise dans la limite", () => {
  const rl = new RateLimiter({ limit: 3, windowMs: 1000 });
  assert.equal(rl.check("a").limited, false);
  assert.equal(rl.check("a").limited, false);
  assert.equal(rl.check("a").limited, false);
});

test("RateLimiter bloque au-delà de la limite", () => {
  const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
  rl.check("a");
  rl.check("a");
  const r = rl.check("a");
  assert.equal(r.limited, true);
  if (r.limited) assert.ok(r.retryAfter > 0 && r.retryAfter <= 1);
});

test("RateLimiter isole les clés", () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
  rl.check("a");
  assert.equal(rl.check("b").limited, false);
  assert.equal(rl.check("a").limited, true);
});

test("RateLimiter reset fonctionne", () => {
  const rl = new RateLimiter({ limit: 1, windowMs: 1000 });
  rl.check("a");
  assert.equal(rl.check("a").limited, true);
  rl.reset();
  assert.equal(rl.check("a").limited, false);
});

test("rateLimitKey utilise x-forwarded-for si présent", () => {
  const req = { socket: { remoteAddress: "1.2.3.4" }, headers: { "x-forwarded-for": "5.6.7.8, 9.10.11.12" } } as any;
  assert.equal(rateLimitKey(req, "api"), "5.6.7.8:api");
});

test("rateLimitKey fallback sur remoteAddress", () => {
  const req = { socket: { remoteAddress: "1.2.3.4" }, headers: {} } as any;
  assert.equal(rateLimitKey(req, "api"), "1.2.3.4:api");
});
