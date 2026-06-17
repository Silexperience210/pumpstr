/**
 * Tests du relay Nostr embarqué (NIP-01) — fonctions pures + handler de connexion.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFilter, replaceableKey, RelayStore, createRelay, type NostrEvent } from "../relay.js";

function ev(o: Partial<NostrEvent> = {}): NostrEvent {
  return {
    id: o.id ?? "id1", pubkey: o.pubkey ?? "pk1", created_at: o.created_at ?? 1000,
    kind: o.kind ?? 1, tags: o.tags ?? [], content: o.content ?? "", sig: o.sig ?? "sig",
  };
}

test("matchFilter : kinds / authors / ids", () => {
  const e = ev({ id: "a", pubkey: "pkX", kind: 30311 });
  assert.equal(matchFilter(e, { kinds: [30311] }), true);
  assert.equal(matchFilter(e, { kinds: [1] }), false);
  assert.equal(matchFilter(e, { authors: ["pkX"] }), true);
  assert.equal(matchFilter(e, { authors: ["autre"] }), false);
  assert.equal(matchFilter(e, { ids: ["a"] }), true);
  assert.equal(matchFilter(e, { ids: ["b"] }), false);
});

test("matchFilter : tags #p et fenêtre temporelle", () => {
  const e = ev({ created_at: 1500, tags: [["p", "host1"], ["t", "pumpstr"]] });
  assert.equal(matchFilter(e, { "#p": ["host1"] } as any), true);
  assert.equal(matchFilter(e, { "#p": ["autre"] } as any), false);
  assert.equal(matchFilter(e, { "#t": ["pumpstr"] } as any), true);
  assert.equal(matchFilter(e, { since: 1000, until: 2000 }), true);
  assert.equal(matchFilter(e, { since: 1600 }), false);
  assert.equal(matchFilter(e, { until: 1400 }), false);
});

test("replaceableKey : addressable (30311+d), remplaçable (0), régulier (1)", () => {
  assert.equal(replaceableKey(ev({ kind: 30311, pubkey: "pk", tags: [["d", "live1"]] })), "30311:pk:live1");
  assert.equal(replaceableKey(ev({ kind: 0, pubkey: "pk" })), "0:pk");
  assert.equal(replaceableKey(ev({ kind: 10002, pubkey: "pk" })), "10002:pk");
  assert.equal(replaceableKey(ev({ kind: 1, pubkey: "pk" })), null);
  assert.equal(replaceableKey(ev({ kind: 9735, pubkey: "pk" })), null);
});

test("RelayStore : add ok / dup / remplacement", () => {
  const s = new RelayStore();
  assert.equal(s.add(ev({ id: "a", kind: 1 })), "ok");
  assert.equal(s.add(ev({ id: "a", kind: 1 })), "dup");
  // remplaçable : un 30311 plus récent évince l'ancien (même pubkey:d)
  assert.equal(s.add(ev({ id: "live-old", kind: 30311, pubkey: "pk", created_at: 100, tags: [["d", "x"]] })), "ok");
  assert.equal(s.add(ev({ id: "live-older", kind: 30311, pubkey: "pk", created_at: 50, tags: [["d", "x"]] })), "old");
  assert.equal(s.add(ev({ id: "live-new", kind: 30311, pubkey: "pk", created_at: 200, tags: [["d", "x"]] })), "ok");
  const got = s.query([{ kinds: [30311] }]);
  assert.equal(got.length, 1);
  assert.equal(got[0].id, "live-new");
});

test("RelayStore : query trie récent d'abord + respecte limit", () => {
  const s = new RelayStore();
  s.add(ev({ id: "a", created_at: 100 }));
  s.add(ev({ id: "b", created_at: 300 }));
  s.add(ev({ id: "c", created_at: 200 }));
  const all = s.query([{ kinds: [1] }]);
  assert.deepEqual(all.map((e) => e.id), ["b", "c", "a"]);
  assert.equal(s.query([{ kinds: [1], limit: 2 }]).length, 2);
});

test("RelayStore : éviction au plafond", () => {
  const s = new RelayStore(2);
  s.add(ev({ id: "a", created_at: 1 }));
  s.add(ev({ id: "b", created_at: 2 }));
  s.add(ev({ id: "c", created_at: 3 }));
  assert.equal(s.size, 2);
  assert.equal(s.query([{ ids: ["a"] }]).length, 0); // le plus vieux a été évincé
});

/* ---- handler de connexion (ws factice, verify injecté) ---- */
function fakeWs() {
  const h: Record<string, (...a: any[]) => void> = {};
  const sent: any[] = [];
  return {
    readyState: 1, sent,
    send: (s: string) => sent.push(JSON.parse(s)),
    on: (e: string, cb: (...a: any[]) => void) => { h[e] = cb; },
    emit: (e: string, data?: any) => h[e]?.(data),
  };
}

test("relay : EVENT valide stocké + OK, REQ renvoie EVENT puis EOSE", () => {
  const relay = createRelay({ verify: () => true });
  const ws = fakeWs();
  relay.onConnection(ws as any);
  ws.emit("message", JSON.stringify(["EVENT", ev({ id: "z", kind: 30311, tags: [["d", "l"]] })]));
  assert.deepEqual(ws.sent[0], ["OK", "z", true, ""]);

  ws.emit("message", JSON.stringify(["REQ", "sub1", { kinds: [30311] }]));
  const evt = ws.sent.find((m) => m[0] === "EVENT");
  assert.equal(evt[1], "sub1");
  assert.equal(evt[2].id, "z");
  assert.deepEqual(ws.sent.at(-1), ["EOSE", "sub1"]);
});

test("relay : EVENT à signature invalide -> OK false, non stocké", () => {
  const relay = createRelay({ verify: () => false });
  const ws = fakeWs();
  relay.onConnection(ws as any);
  ws.emit("message", JSON.stringify(["EVENT", ev({ id: "bad" })]));
  assert.equal(ws.sent[0][0], "OK");
  assert.equal(ws.sent[0][2], false);
  assert.equal(relay.store.size, 0);
});

test("relay : publishLocal diffuse aux abonnés qui matchent", () => {
  const relay = createRelay({ verify: () => true });
  const ws = fakeWs();
  relay.onConnection(ws as any);
  ws.emit("message", JSON.stringify(["REQ", "s", { kinds: [9735], "#p": ["host1"] }]));
  assert.deepEqual(ws.sent.at(-1), ["EOSE", "s"]); // rien en cache encore
  relay.publishLocal(ev({ id: "zap1", kind: 9735, tags: [["p", "host1"], ["amount", "21000000"]] }));
  const pushed = ws.sent.find((m) => m[0] === "EVENT" && m[2].id === "zap1");
  assert.ok(pushed, "le zap matchant doit être poussé à l'abonné");
});

test("relay : CLOSE retire la souscription (plus de push)", () => {
  const relay = createRelay({ verify: () => true });
  const ws = fakeWs();
  relay.onConnection(ws as any);
  ws.emit("message", JSON.stringify(["REQ", "s", { kinds: [1] }]));
  ws.emit("message", JSON.stringify(["CLOSE", "s"]));
  const before = ws.sent.length;
  relay.publishLocal(ev({ id: "n", kind: 1 }));
  assert.equal(ws.sent.length, before, "aucun push après CLOSE");
});
