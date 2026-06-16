/**
 * Tests d'intégration du handler HTTP (server-core.ts) avec un rail mocké.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import request from "supertest";
import { createHandler, type Tipper } from "../server-core.js";
import { PumpstrDb } from "../db.js";

const PUBKEY = "0".repeat(63) + "1";

function makeRail() {
  return {
    getAddress: () => Promise.resolve("tark1mock"),
    getBalance: () => Promise.resolve(1000n),
    send: () => Promise.resolve({ id: "tx-send", status: "settled" }),
    createLnInvoice: () => Promise.resolve({ bolt11: "lnbc1mock" }),
    createLnInvoiceWithSettle: () => Promise.resolve({
      bolt11: "lnbc1mock",
      settle: () => Promise.resolve({ txid: "tx-settle" }),
    }),
    escrowClaimable: () => Promise.resolve({ id: "ref-mock" }),
    claim: () => Promise.resolve({ id: "tx-claim", status: "settled" }),
    refund: () => Promise.resolve({ id: "tx-refund", status: "settled" }),
    exit: () => Promise.resolve({ txid: "tx-exit" }),
  };
}

function makeDeps(rail = makeRail()) {
  const db = new PumpstrDb(":memory:");
  const deps: any = {
    rail: rail as any,
    config: {
      port: 4242,
      lnAddressUser: "pay",
      lnAddressBase: "http://localhost:4242",
      lnMetadata: JSON.stringify([["text/plain", "Tip"]]),
      creatorAddress: "tark1mock",
      creatorPubkey: PUBKEY,
      creatorNpub: "npub1mock",
      stream: { url: "", title: "🔴 Live", summary: "", image: "", d: "live" },
      publicBase: "http://localhost:4242",
      adminToken: "secret",
      platformSplitBps: 0,
    },
    db,
    state: {
      claimedTxids: new Set<string>(),
    },
    helpers: {
      registerTip: (amount: number, tipper: Tipper) => { db.addTip({ amount, name: tipper.name, picture: tipper.picture, pubkey: tipper.pubkey, comment: tipper.comment, via: tipper.via, createdAt: Date.now() }); },
      publishZapReceipt: () => Promise.resolve(),
      publishRewardNote: () => Promise.resolve(),
      tipperFromBody: async (_body: any, via: string) => ({ name: "alice", via }),
    },
    fs: { publicDir: "/tmp/public", portalDir: "/tmp/portal" },
  };
  return deps;
}

function makeApp(deps = makeDeps()) {
  const handler = createHandler(deps);
  return createServer(handler);
}

test("GET /api/creator retourne les infos créateur", async () => {
  const res = await request(makeApp()).get("/api/creator").expect(200);
  assert.equal(res.body.address, "tark1mock");
  assert.equal(res.body.npub, "npub1mock");
});

test("GET /.well-known/lnurlp/pay retourne le payRequest", async () => {
  const res = await request(makeApp()).get("/.well-known/lnurlp/pay").expect(200);
  assert.equal(res.body.tag, "payRequest");
  assert.equal(res.body.callback, "http://localhost:4242/api/lnurlp/callback");
  assert.equal(res.body.allowsNostr, true);
});

test("GET /.well-known/lnurlp/wrong retourne 404", async () => {
  await request(makeApp()).get("/.well-known/lnurlp/wrong").expect(404);
});

test("GET /api/lnurlp/callback avec montant invalide retourne une erreur", async () => {
  const res = await request(makeApp()).get("/api/lnurlp/callback?amount=0").expect(200);
  assert.equal(res.body.status, "ERROR");
});

test("GET /api/lnurlp/callback avec montant valide retourne une facture", async () => {
  const res = await request(makeApp()).get("/api/lnurlp/callback?amount=1000000").expect(200);
  assert.ok(res.body.pr.startsWith("lnbc1mock"));
});

test("POST /api/invoice avec montant invalide retourne 400", async () => {
  await request(makeApp()).post("/api/invoice").send({ amount: 0 }).expect(400);
  await request(makeApp()).post("/api/invoice").send({ amount: "abc" }).expect(400);
});

test("POST /api/invoice avec montant valide retourne une facture", async () => {
  const res = await request(makeApp()).post("/api/invoice").send({ amount: 1000 }).expect(200);
  assert.equal(res.body.amount, 1000);
  assert.ok(res.body.bolt11.startsWith("lnbc1mock"));
});

test("POST /api/reward sans token admin retourne 401", async () => {
  await request(makeApp()).post("/api/reward").send({ to: PUBKEY, amount: 1000 }).expect(401);
});

test("POST /api/reward avec token admin crée un reward", async () => {
  const deps = makeDeps();
  const res = await request(makeApp(deps))
    .post("/api/reward")
    .set("x-admin-token", "secret")
    .send({ to: PUBKEY, amount: 1000, reason: "test" })
    .expect(200);
  assert.equal(res.body.amount, 1000);
  assert.ok(res.body.ref);
  assert.equal(deps.db.getRewardsFor(PUBKEY).length, 1);
});

test("POST /api/reward avec montant sous dust retourne 400", async () => {
  await request(makeApp())
    .post("/api/reward")
    .set("x-admin-token", "secret")
    .send({ to: PUBKEY, amount: 100 })
    .expect(400);
});

test("POST /api/reward avec npub invalide retourne 400", async () => {
  await request(makeApp())
    .post("/api/reward")
    .set("x-admin-token", "secret")
    .send({ to: "npub1invalid", amount: 1000 })
    .expect(400);
});

test("GET /api/rewards liste les rewards d'un bénéficiaire", async () => {
  const deps = makeDeps();
  deps.db.addReward({ id: "r1", to: PUBKEY, npub: "npub1mock", amount: 500, reason: "", ref: "ref1", createdAt: 1, claimed: 0 });
  const res = await request(makeApp(deps)).get(`/api/rewards?to=${PUBKEY}`).expect(200);
  assert.equal(res.body.count, 1);
  assert.equal(res.body.rewards[0].amount, 500);
});

test("POST /api/reward/claimed marque un reward réclamé", async () => {
  const deps = makeDeps();
  deps.db.addReward({ id: "r1", to: PUBKEY, npub: "npub1mock", amount: 500, reason: "", ref: "ref1", createdAt: 1, claimed: 0 });
  const res = await request(makeApp(deps)).post("/api/reward/claimed").send({ id: "r1" }).expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(deps.db.getRewardById("r1")?.claimed, 1);
});

test("POST /api/reward/refund sans token retourne 401", async () => {
  await request(makeApp()).post("/api/reward/refund").send({ id: "r1" }).expect(401);
});

test("POST /api/reward/refund avec token effectue le refund", async () => {
  const deps = makeDeps();
  deps.db.addReward({ id: "r1", to: PUBKEY, npub: "npub1mock", amount: 500, reason: "", ref: "ref1", createdAt: 1, claimed: 0 });
  const res = await request(makeApp(deps))
    .post("/api/reward/refund")
    .set("x-admin-token", "secret")
    .send({ id: "r1" })
    .expect(200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.txid, "tx-refund");
  assert.equal(deps.db.getRewardById("r1")?.claimed, 1);
});

test("POST /api/simulate enregistre un tip", async () => {
  const deps = makeDeps();
  const res = await request(makeApp(deps)).post("/api/simulate").send({ amount: 1234, name: "bob" }).expect(200);
  assert.equal(res.body.amount, 1234);
  assert.equal(deps.db.recentTips().length, 1);
});

test("POST /api/simulate avec montant invalide fallback aléatoire", async () => {
  const deps = makeDeps();
  const res = await request(makeApp(deps)).post("/api/simulate").send({ amount: "abc" }).expect(200);
  assert.ok(res.body.amount >= 100 && res.body.amount <= 5000);
});

test("GET /api/stream retourne le flux", async () => {
  const res = await request(makeApp()).get("/api/stream").expect(200);
  assert.equal(res.body.demo, true);
  assert.equal(res.body.title, "🔴 Live");
});

test("Route inconnue retourne 404", async () => {
  await request(makeApp()).get("/nope").expect(404);
});
