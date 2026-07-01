/**
 * test/integration.test.ts — Tests d'intégration end-to-end
 *
 * Simule le flux complet : tip LN-in → overlay → Nostr zap receipt
 * en utilisant les vrais modules mais avec des mocks réseau.
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import request from "supertest";
import { PumpstrDb } from "../db.js";
import { createHandler } from "../server-core.js";
import { createRelay } from "../relay.js";

describe("Integration — Tip flow", () => {
  let tmpDir: string;
  let db: PumpstrDb;
  let relay: ReturnType<typeof createRelay>;
  let tips: any[] = [];
  let zapReceipts: any[] = [];

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pumpstr-integ-"));
    db = new PumpstrDb(join(tmpDir, "test.db"));
    relay = createRelay();
    tips = [];
    zapReceipts = [];
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const mockRail = {
      getBalance: async () => 10000n,
      createLnInvoiceWithSettle: async (amount: bigint, desc?: string) => ({
        bolt11: "lnbc" + amount + "n1p...",
        settle: async () => ({ txid: "txid_" + Math.random().toString(36).slice(2) }),
      }),
      escrowClaimable: async (pubkey: string, amount: bigint) => ({ id: "escrow_" + Math.random().toString(36).slice(2) }),
      refund: async () => ({ id: "refund_123", status: "ok" }),
      withdrawToLightning: async (invoice: string) => ({ amount: 1000, txid: "withdraw_123", preimage: "preimage_123" }),
    };

    const handler = createHandler({
      rail: mockRail as any,
      config: {
        port: 4242,
        lnAddressUser: "pay",
        lnAddressBase: "http://localhost:4242",
        lnMetadata: "[["text/plain","Tip"]]",
        creatorAddress: "bc1q...",
        creatorPubkey: "a".repeat(64),
        creatorNpub: "npub1...",
        stream: { url: "", title: "Test", summary: "", image: "", d: "test" },
        publicBase: "http://localhost:4242",
        adminToken: "test_admin_token_12345678901234567890",
        platformSplitBps: 0,
        actions: [
          { id: "horn", label: "Klaxon", emoji: "📯", sats: 500, effect: "horn" },
        ],
      },
      db,
      state: { claimedTxids: new Set<string>(), incomingFundsLock: false },
      helpers: {
        registerTip: (amount: number, tipper: any) => {
          tips.push({ amount, tipper });
          db.addTip({ amount, name: tipper.name, picture: tipper.picture, pubkey: tipper.pubkey, comment: tipper.comment, via: tipper.via, createdAt: Date.now() });
        },
        publishZapReceipt: (zr: any, bolt11: string, amount: number) => {
          zapReceipts.push({ zr, bolt11, amount });
        },
        publishRewardNote: async () => {},
        tipperFromBody: async (body: any, via: string) => ({ name: body?.name || "anon", via }),
        broadcast: (msg: any) => {},
      },
      fs: { publicDir: tmpDir, portalDir: tmpDir },
    });

    return createServer(handler);
  }

  it("POST /api/invoice crée une facture et enregistre le tip", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/invoice")
      .send({ amount: 1000, name: "TestUser" });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.bolt11.startsWith("lnbc"));
    assert.strictEqual(res.body.amount, 1000);

    // Le tip doit être enregistré après settle
    assert.strictEqual(tips.length, 1);
    assert.strictEqual(tips[0].amount, 1000);
    assert.strictEqual(tips[0].tipper.name, "TestUser");
  });

  it("POST /api/simulate génère un tip", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/simulate")
      .send({ amount: 500, name: "SimUser" });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.amount, 500);
    assert.strictEqual(res.body.name, "SimUser");

    const stats = db.tipStats();
    assert.ok(stats.count >= 1);
    assert.ok(stats.total >= 500);
  });

  it("POST /api/reward crée un reward", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/reward")
      .set("x-admin-token", "test_admin_token_12345678901234567890")
      .send({
        to: "a".repeat(64),
        amount: 1000,
        reason: "Test reward",
      });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.id);
    assert.strictEqual(res.body.amount, 1000);

    const rewards = db.rewardStats();
    assert.strictEqual(rewards.count, 1);
    assert.strictEqual(rewards.total, 1000);
  });

  it("GET /api/creator retourne les infos", async () => {
    const app = createApp();
    const res = await request(app).get("/api/creator");

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.address);
    assert.ok(res.body.npub);
    assert.ok(res.body.lnAddress);
    assert.ok(Array.isArray(res.body.recentTips));
  });

  it("GET /api/dashboard protégé par admin token", async () => {
    const app = createApp();

    // Sans token
    let res = await request(app).get("/api/dashboard");
    assert.strictEqual(res.status, 401);

    // Avec mauvais token
    res = await request(app).get("/api/dashboard").set("x-admin-token", "wrong");
    assert.strictEqual(res.status, 401);

    // Avec bon token
    res = await request(app).get("/api/dashboard").set("x-admin-token", "test_admin_token_12345678901234567890");
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.creator);
    assert.ok(res.body.tips);
    assert.ok(res.body.rewards);
  });

  it("GET /.well-known/lnurlp/{user} retourne LNURL-pay", async () => {
    const app = createApp();
    const res = await request(app).get("/.well-known/lnurlp/pay");

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.tag, "payRequest");
    assert.ok(res.body.callback);
    assert.ok(res.body.minSendable);
    assert.ok(res.body.maxSendable);
  });

  it("GET /api/lnurlp/callback génère une facture", async () => {
    const app = createApp();
    const res = await request(app).get("/api/lnurlp/callback?amount=1000000");

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.pr); // bolt11
  });

  it("POST /api/fund protégé par admin", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/fund")
      .set("x-admin-token", "test_admin_token_12345678901234567890")
      .send({ amount: 5000 });

    assert.strictEqual(res.status, 200);
    assert.ok(res.body.bolt11);
  });

  it("POST /api/withdraw protégé par admin", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/withdraw")
      .set("x-admin-token", "test_admin_token_12345678901234567890")
      .send({ invoice: "lnbc1000n1p..." });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
  });

  it("rate limit sur /api/simulate", async () => {
    const app = createApp();
    // 20 requêtes rapides
    for (let i = 0; i < 25; i++) {
      await request(app).post("/api/simulate").send({});
    }

    const res = await request(app).post("/api/simulate").send({});
    assert.strictEqual(res.status, 429);
    assert.ok(res.body.error.includes("rate limit"));
  });

  it("CORS headers sur toutes les réponses", async () => {
    const app = createApp();
    const res = await request(app).get("/api/creator");

    assert.strictEqual(res.headers["access-control-allow-origin"], "*");
    assert.strictEqual(res.headers["access-control-allow-methods"], "GET, POST, OPTIONS");
  });

  it("OPTIONS retourne 204", async () => {
    const app = createApp();
    const res = await request(app).options("/api/creator");
    assert.strictEqual(res.status, 204);
  });
});

describe("Integration — Relay Nostr", () => {
  it("publishLocal et query fonctionnent", () => {
    const relay = createRelay();
    const ev = {
      id: "test123",
      pubkey: "a".repeat(64),
      created_at: 1000,
      kind: 1,
      tags: [],
      content: "Hello",
      sig: "b".repeat(128),
    };

    relay.publishLocal(ev);
    const results = relay.store.query([{ kinds: [1] }]);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, "Hello");
  });

  it("events remplaçables sont remplacés", () => {
    const relay = createRelay();
    const ev1 = { id: "old1", pubkey: "a".repeat(64), created_at: 1000, kind: 0, tags: [], content: "Old", sig: "b".repeat(128) };
    const ev2 = { id: "new1", pubkey: "a".repeat(64), created_at: 2000, kind: 0, tags: [], content: "New", sig: "c".repeat(128) };

    relay.publishLocal(ev1);
    relay.publishLocal(ev2);

    const results = relay.store.query([{ kinds: [0] }]);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].content, "New");
  });

  it("rate limit relay bloque le spam", () => {
    const relay = createRelay();
    let blocked = 0;

    for (let i = 0; i < 150; i++) {
      const ev = { id: `id${i}`, pubkey: "a".repeat(64), created_at: i, kind: 1, tags: [], content: "spam", sig: "b".repeat(128) };
      const rateLimit = (relay as any).rateLimit;
      if (!rateLimit.check("192.168.1.1")) {
        blocked++;
      }
    }

    assert.ok(blocked > 0, "Au moins un event doit être bloqué");
  });
});
