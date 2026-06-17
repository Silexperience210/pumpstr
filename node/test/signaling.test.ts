/**
 * Tests du signaling WebRTC : routage broadcaster <-> viewers (sans vrais médias).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignaling } from "../signaling.js";

function fakeWs() {
  const sent: any[] = [];
  return { readyState: 1, sent, send: (s: string) => sent.push(JSON.parse(s)) };
}
const last = (ws: any) => ws.sent.at(-1);

test("join sans broadcaster -> no-live", () => {
  const sig = createSignaling(() => {});
  const v = fakeWs();
  sig.onMessage(v as any, { type: "join" });
  assert.deepEqual(last(v), { type: "no-live" });
});

test("golive puis join -> le broadcaster reçoit viewer-join", () => {
  const bc = []; const sig = createSignaling((m) => bc.push(m));
  const b = fakeWs(), v = fakeWs();
  sig.onMessage(b as any, { type: "golive" });
  assert.deepEqual(bc.at(-1), { type: "live-started" });
  sig.onMessage(v as any, { type: "join" });
  const j = b.sent.find((m) => m.type === "viewer-join");
  assert.ok(j && j.from, "viewer-join avec un id");
  assert.equal(sig.isLive(), true);
  assert.equal(sig.viewerCount(), 1);
});

test("golive après des viewers présents -> handshake rétro-déclenché", () => {
  const sig = createSignaling(() => {});
  const b = fakeWs(), v = fakeWs();
  sig.onMessage(v as any, { type: "join" }); // pas de live -> no-live
  sig.onMessage(b as any, { type: "golive" });
  const j = b.sent.find((m) => m.type === "viewer-join");
  assert.ok(j, "le broadcaster est notifié du viewer déjà présent");
});

test("offer broadcaster->viewer, answer + ice viewer->broadcaster", () => {
  const sig = createSignaling(() => {});
  const b = fakeWs(), v = fakeWs();
  sig.onMessage(b as any, { type: "golive" });
  sig.onMessage(v as any, { type: "join" });
  const vid = b.sent.find((m) => m.type === "viewer-join").from;

  sig.onMessage(b as any, { type: "offer", to: vid, sdp: "OFFER" });
  assert.deepEqual(last(v), { type: "offer", sdp: "OFFER" });

  sig.onMessage(v as any, { type: "answer", sdp: "ANSWER" });
  const ans = b.sent.find((m) => m.type === "answer");
  assert.equal(ans.sdp, "ANSWER"); assert.equal(ans.from, vid);

  sig.onMessage(v as any, { type: "ice", candidate: "C1" });
  const ice = b.sent.find((m) => m.type === "ice");
  assert.equal(ice.candidate, "C1"); assert.equal(ice.from, vid);

  sig.onMessage(b as any, { type: "ice", to: vid, candidate: "C2" });
  assert.deepEqual(last(v), { type: "ice", candidate: "C2" });
});

test("detach broadcaster -> live-ended diffusé ; detach viewer -> viewer-leave", () => {
  const bc: any[] = []; const sig = createSignaling((m) => bc.push(m));
  const b = fakeWs(), v = fakeWs();
  sig.onMessage(b as any, { type: "golive" });
  sig.onMessage(v as any, { type: "join" });
  const vid = b.sent.find((m) => m.type === "viewer-join").from;

  sig.detach(v as any);
  assert.deepEqual(last(b), { type: "viewer-leave", from: vid });
  assert.equal(sig.viewerCount(), 0);

  sig.detach(b as any);
  assert.deepEqual(bc.at(-1), { type: "live-ended" });
  assert.equal(sig.isLive(), false);
});
