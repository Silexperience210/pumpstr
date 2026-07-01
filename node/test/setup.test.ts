/**
 * test/setup.test.ts — Tests du wizard de configuration
 *
 * Couvre :
 * - Détection du mode setup (setup_complete absent)
 * - Redirection auto vers /setup.html
 * - API /api/setup/* (wallet, network, domain, https, complete)
 * - Génération du .env
 * - Persistance SQLite config
 */
import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { createServer } from "node:http";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import request from "supertest";
import { PumpstrDb } from "../db.js";
import { createSetupHandler } from "../setup.js";

describe("Setup Wizard", () => {
  let tmpDir: string;
  let db: PumpstrDb;
  let envPath: string;
  let setupCompleteCalled = false;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pumpstr-setup-"));
    envPath = join(tmpDir, ".env");
    db = new PumpstrDb(join(tmpDir, "test.db"));
  });

  after(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createApp() {
    const setupHandler = createSetupHandler({
      db,
      envPath,
      here: tmpDir,
      onComplete: () => { setupCompleteCalled = true; },
    });
    return createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost`);
      if (url.pathname.startsWith("/api/setup")) {
        return setupHandler(req, res);
      }
      res.statusCode = 404;
      res.end("not found");
    });
  }

  it("setup non terminé par défaut", () => {
    assert.strictEqual(db.getConfig("setup_complete"), undefined);
  });

  it("GET /api/setup/status retourne setupComplete: false", async () => {
    const app = createApp();
    const res = await request(app).get("/api/setup/status");
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.setupComplete, false);
    assert.ok(Array.isArray(res.body.steps));
    assert.strictEqual(res.body.steps.length, 4);
  });

  it("POST /api/setup/wallet avec Arkade", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/wallet")
      .send({
        backend: "arkade",
        adminToken: "test_admin_token_12345678901234567890",
        arkServerUrl: "https://mutinynet.arkade.sh",
        boltzNetwork: "mutinynet",
      });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.backend, "arkade");
    assert.strictEqual(db.getConfig("wallet_backend"), "arkade");
    assert.strictEqual(db.getConfig("admin_token"), "test_admin_token_12345678901234567890");
  });

  it("POST /api/setup/wallet avec NWC", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/wallet")
      .send({
        backend: "nwc",
        adminToken: "test_admin_token_12345678901234567890",
        nwcUri: "nostr+walletconnect://abc123?relay=wss://relay.damus.io&secret=xxx",
      });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(db.getConfig("wallet_backend"), "nwc");
    assert.ok(db.getConfig("nwc_uri")?.includes("nostr+walletconnect"));
  });

  it("POST /api/setup/wallet — adminToken trop court", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/wallet")
      .send({
        backend: "arkade",
        adminToken: "short",
      });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes("32"));
  });

  it("POST /api/setup/wallet — NWC URI invalide", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/wallet")
      .send({
        backend: "nwc",
        adminToken: "test_admin_token_12345678901234567890",
        nwcUri: "invalid-uri",
      });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes("NWC"));
  });

  it("POST /api/setup/network", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/network")
      .send({ mode: "public", port: 4242, httpsPort: 4243 });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mode, "public");
    assert.strictEqual(db.getConfig("network_mode"), "public");
    assert.strictEqual(db.getConfig("port"), "4242");
  });

  it("POST /api/setup/domain — manual", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/domain")
      .send({ domain: "monstream.com", provider: "manual" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.domain, "monstream.com");
    assert.strictEqual(db.getConfig("domain"), "monstream.com");
    assert.strictEqual(db.getConfig("domain_provider"), "manual");
  });

  it("POST /api/setup/domain — domaine invalide", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/domain")
      .send({ domain: "not_a_domain!", provider: "manual" });
    assert.strictEqual(res.status, 400);
  });

  it("POST /api/setup/https — auto", async () => {
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/https")
      .send({ mode: "auto", email: "admin@test.com" });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.mode, "auto");
    assert.ok(res.body.caddyfile.includes("monstream.com"));
    assert.strictEqual(db.getConfig("https_mode"), "auto");
  });

  it("POST /api/setup/https — auto sans domaine", async () => {
    // Reset domain
    db.setConfig("domain", "");
    const app = createApp();
    const res = await request(app)
      .post("/api/setup/https")
      .send({ mode: "auto", email: "admin@test.com" });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error.includes("domaine"));
  });

  it("POST /api/setup/complete — étapes manquantes", async () => {
    // Reset pour simuler étapes manquantes
    db.setConfig("step_wallet", "0");
    const app = createApp();
    const res = await request(app).post("/api/setup/complete").send({});
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.missing.includes("step_wallet"));
  });

  it("POST /api/setup/complete — succès", async () => {
    // Compléter toutes les étapes
    db.setConfig("step_wallet", "1");
    db.setConfig("step_network", "1");
    db.setConfig("step_domain", "1");
    db.setConfig("step_https", "1");
    db.setConfig("wallet_backend", "arkade");
    db.setConfig("admin_token", "test_admin_token_12345678901234567890");
    db.setConfig("port", "4242");
    db.setConfig("https_port", "4243");
    db.setConfig("network_mode", "public");
    db.setConfig("https_mode", "auto");
    db.setConfig("https_email", "admin@test.com");
    db.setConfig("domain", "monstream.com");

    const app = createApp();
    const res = await request(app).post("/api/setup/complete").send({});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(db.getConfig("setup_complete"), "1");
    assert.ok(existsSync(envPath));

    const envContent = readFileSync(envPath, "utf8");
    assert.ok(envContent.includes("ADMIN_TOKEN=test_admin_token_12345678901234567890"));
    assert.ok(envContent.includes("WALLET_BACKEND=arkade"));
    assert.ok(envContent.includes("DOMAIN=monstream.com"));
    assert.ok(setupCompleteCalled);
  });

  it("rate limit sur /api/setup/complete", async () => {
    const app = createApp();
    // Premier appel OK
    let res = await request(app).post("/api/setup/complete").send({});
    // Appels rapides suivants
    for (let i = 0; i < 6; i++) {
      res = await request(app).post("/api/setup/complete").send({});
    }
    assert.strictEqual(res.status, 429);
  });
});
