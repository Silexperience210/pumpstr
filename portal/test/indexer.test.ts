/**
 * Tests des fonctions pures de portal/indexer.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { upsert, list, cleanup, resetCache, tagv, ingestZap, satsFor, leaderboard, resetZaps } from "../indexer.js";

function makeEvent(overrides: Partial<{ id: string; pubkey: string; created_at: number; status: string; d: string; streaming: string; r: string; title: string }> = {}) {
  return {
    id: overrides.id ?? "ev1",
    pubkey: overrides.pubkey ?? "pk1",
    created_at: overrides.created_at ?? 1_000_000,
    kind: 30311,
    tags: [
      ["d", overrides.d ?? "live1"],
      ["title", overrides.title ?? "Super live"],
      ["summary", "Résumé"],
      ["status", overrides.status ?? "live"],
      ["t", "pumpstr"],
      ...(overrides.streaming ? [["streaming", overrides.streaming]] : []),
      ...(overrides.r ? [["r", overrides.r]] : []),
    ],
    content: "",
    sig: "sig",
  } as any;
}

test("tagv extrait un tag", () => {
  const ev = makeEvent({ title: "Titre" });
  assert.equal(tagv(ev, "title"), "Titre");
  assert.equal(tagv(ev, "inconnu"), undefined);
});

test("upsert ajoute un live", () => {
  resetCache();
  upsert(makeEvent({ id: "ev1", pubkey: "pk1", created_at: 1_000_000 }));
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "live");
  assert.equal(items[0].title, "Super live");
});

test("upsert remplace un live plus ancien même pubkey:d", () => {
  resetCache();
  upsert(makeEvent({ id: "ev1", pubkey: "pk1", created_at: 1_000_000, status: "live" }));
  upsert(makeEvent({ id: "ev2", pubkey: "pk1", created_at: 1_000_001, status: "ended" }));
  const items = list();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "ended");
});

test("upsert ignore un live plus ancien", () => {
  resetCache();
  upsert(makeEvent({ id: "ev2", pubkey: "pk1", created_at: 1_000_001, status: "ended" }));
  upsert(makeEvent({ id: "ev1", pubkey: "pk1", created_at: 1_000_000, status: "live" }));
  const items = list();
  assert.equal(items[0].status, "ended");
});

test("list filtre par status", () => {
  resetCache();
  upsert(makeEvent({ id: "ev1", pubkey: "pk1", created_at: 1_000_000, status: "live" }));
  upsert(makeEvent({ id: "ev2", pubkey: "pk2", created_at: 1_000_001, status: "ended" }));
  assert.equal(list("live").length, 1);
  assert.equal(list("ended").length, 1);
});

test("list trie live avant ended", () => {
  resetCache();
  upsert(makeEvent({ id: "ev1", pubkey: "pk1", created_at: 1_000_001, status: "ended" }));
  upsert(makeEvent({ id: "ev2", pubkey: "pk2", created_at: 1_000_000, status: "live" }));
  const items = list();
  assert.equal(items[0].status, "live");
  assert.equal(items[1].status, "ended");
});

test("cleanup supprime les vieux events", () => {
  resetCache();
  const old = Date.now() - 25 * 3600 * 1000; // 25h
  upsert(makeEvent({ id: "ev1", pubkey: "pk1", created_at: Math.floor(old / 1000) }));
  cleanup();
  assert.equal(list().length, 0);
});

test("nodeUrl et streaming extraits", () => {
  resetCache();
  upsert(makeEvent({ id: "ev1", pubkey: "pk1", streaming: "https://stream/hls.m3u8", r: "https://node.example.com" }));
  const items = list();
  assert.equal(items[0].streaming, "https://stream/hls.m3u8");
  assert.equal(items[0].nodeUrl, "https://node.example.com");
});

// ---- indexer trending / leaderboard (agrégation des zaps 9735) ----
function makeZap(o: { id?: string; host?: string; msat?: number; created_at?: number } = {}) {
  return {
    id: o.id ?? "z1", pubkey: "node", kind: 9735, created_at: o.created_at ?? 1_000_000,
    tags: [["p", o.host ?? "pk1"], ["amount", String(o.msat ?? 21_000_000)]],
    content: "", sig: "s",
  } as any;
}

test("ingestZap agrège les sats par hôte et dédupe par id", () => {
  resetZaps();
  assert.equal(ingestZap(makeZap({ id: "z1", host: "pk1", msat: 21_000_000 })), true);
  assert.equal(ingestZap(makeZap({ id: "z1", host: "pk1", msat: 21_000_000 })), false); // même id -> ignoré
  assert.equal(ingestZap(makeZap({ id: "z2", host: "pk1", msat: 1_000_000 })), true);
  assert.equal(satsFor("pk1"), 22_000);
  assert.equal(satsFor("inconnu"), 0);
});

test("ingestZap ignore sans hôte ou montant nul", () => {
  resetZaps();
  assert.equal(ingestZap({ id: "z3", tags: [["amount", "1000"]] }), false); // pas de tag p
  assert.equal(ingestZap({ id: "z4", tags: [["p", "pk1"], ["amount", "0"]] }), false);
  assert.equal(satsFor("pk1"), 0);
});

test("list expose les sats agrégés par live", () => {
  resetCache(); resetZaps();
  upsert(makeEvent({ pubkey: "pk1" }));
  ingestZap(makeZap({ id: "z1", host: "pk1", msat: 5_000_000 }));
  assert.equal(list()[0].sats, 5_000);
});

test("list sort=trending classe par vélocité de sats", () => {
  resetCache(); resetZaps();
  upsert(makeEvent({ id: "a", pubkey: "pkA", d: "a", created_at: 1_000_000, status: "live" }));
  upsert(makeEvent({ id: "b", pubkey: "pkB", d: "b", created_at: 1_000_000, status: "live" }));
  const nowS = Math.floor(Date.now() / 1000);
  ingestZap(makeZap({ id: "z1", host: "pkB", msat: 50_000_000, created_at: nowS })); // gros + récent
  ingestZap(makeZap({ id: "z2", host: "pkA", msat: 1_000_000, created_at: nowS }));
  const t = list(undefined, "trending");
  assert.equal(t[0].pubkey, "pkB");
  assert.equal(t[0].sats >= t[1].sats, true);
});

test("leaderboard classe les créateurs par sats reçus", () => {
  resetCache(); resetZaps();
  upsert(makeEvent({ pubkey: "pk1", title: "Alice" }));
  ingestZap(makeZap({ id: "z1", host: "pk1", msat: 9_000_000 }));
  ingestZap(makeZap({ id: "z2", host: "pk2", msat: 21_000_000 }));
  const lb = leaderboard();
  assert.equal(lb[0].pubkey, "pk2");
  assert.equal(lb[0].sats, 21_000);
  assert.equal(lb[1].pubkey, "pk1");
  assert.equal(lb[1].title, "Alice");
});
