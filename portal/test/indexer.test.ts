/**
 * Tests des fonctions pures de portal/indexer.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { upsert, list, cleanup, resetCache, tagv } from "../indexer.js";

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
