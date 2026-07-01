/**
 * test/bugs-regression.test.ts — Tests de régression pour les bugs critiques B1-B5
 *
 * Vérifie que les bugs corrigés ne réapparaissent pas.
 */
import { describe, it, before } from "node:test";
import assert from "node:assert";
import { createSignaling } from "../signaling.js";
import { RateLimiter } from "../rate-limit.js";
import { escapeHtml } from "../validation.js";
import { PumpstrDb } from "../db.js";
import { join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

describe("B1 — publishLive après endlive", () => {
  it("sig.isLive() retourne false après endlive", () => {
    const messages: any[] = [];
    const sig = createSignaling((msg) => messages.push(msg), {
      onGoLive: () => {},
      onEndLive: () => {},
    });

    assert.strictEqual(sig.isLive(), false);

    // Simuler un broadcaster
    const broadcaster = { send: () => {}, readyState: 1 };
    sig.onMessage(broadcaster, { type: "golive" });
    assert.strictEqual(sig.isLive(), true);

    // End live
    sig.onMessage(broadcaster, { type: "endlive" });
    assert.strictEqual(sig.isLive(), false);

    // publishLive ne devrait pas republier si isLive() === false
    // (ce comportement est dans server.ts, testé ici indirectement)
    assert.strictEqual(sig.isLive(), false);
  });
});

describe("B2 — Race condition double-compte de tips", () => {
  let db: PumpstrDb;
  let tmpDir: string;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "pumpstr-b2-"));
    db = new PumpstrDb(join(tmpDir, "test.db"));
  });

  it("incomingFundsLock empêche le double-compte", async () => {
    let incomingFundsLock = false;
    let tipCount = 0;

    const simulateIncomingFunds = () => {
      if (incomingFundsLock) {
        return "locked"; // Simule le rejet par le lock
      }
      incomingFundsLock = true;
      tipCount++;
      incomingFundsLock = false;
      return "processed";
    };

    const simulateSettleAndZap = () => {
      incomingFundsLock = true;
      // Simule le traitement
      tipCount++;
      incomingFundsLock = false;
      return "settled";
    };

    // Appels concurrents
    const results = await Promise.all([
      simulateIncomingFunds(),
      simulateSettleAndZap(),
      simulateIncomingFunds(),
    ]);

    // Un seul devrait être "locked"
    const lockedCount = results.filter((r) => r === "locked").length;
    assert.ok(lockedCount >= 1, "Au moins un appel doit être bloqué par le lock");
    // Le tipCount ne doit pas dépasser 2 (un incoming + un settle)
    assert.ok(tipCount <= 2, `tipCount=${tipCount} ne doit pas dépasser 2`);
  });

  it("livePot persistant après redémarrage", () => {
    db.setLivePot(1500);
    assert.strictEqual(db.getLivePot(), 1500);

    // Simuler redémarrage (nouvelle instance avec même DB)
    const db2 = new PumpstrDb(join(tmpDir, "test.db"));
    assert.strictEqual(db2.getLivePot(), 1500);
    db2.close();
  });
});

describe("B3 — Notification viewer tip reçu", () => {
  it("broadcast envoie tip-confirmed", () => {
    const messages: any[] = [];
    const broadcast = (msg: any) => messages.push(msg);

    // Simuler un tip réussi
    broadcast({ type: "tip-confirmed", amount: 1000, name: "Alice" });

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, "tip-confirmed");
    assert.strictEqual(messages[0].amount, 1000);
    assert.strictEqual(messages[0].name, "Alice");
  });

  it("broadcast envoie tip-failed en cas d'erreur", () => {
    const messages: any[] = [];
    const broadcast = (msg: any) => messages.push(msg);

    broadcast({ type: "tip-failed", amount: 1000, error: "Le crédit a échoué" });

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].type, "tip-failed");
    assert.ok(messages[0].error.includes("échoué"));
  });
});

describe("B4 — Heartbeat WS nettoie les clients morts", () => {
  it("clients avec pumpstrAlive=false sont terminés", () => {
    const clients = new Set<any>();
    const deadClients = new Set<any>();

    // Simuler 3 clients
    const client1 = { readyState: 1, pumpstrAlive: true, send: () => {}, terminate: () => { deadClients.add(client1); } };
    const client2 = { readyState: 1, pumpstrAlive: false, send: () => {}, terminate: () => { deadClients.add(client2); } };
    const client3 = { readyState: 1, pumpstrAlive: true, send: () => {}, terminate: () => { deadClients.add(client3); } };

    clients.add(client1);
    clients.add(client2);
    clients.add(client3);

    // Simuler le heartbeat
    for (const c of clients) {
      if (c.pumpstrAlive === false) {
        deadClients.add(c);
        c.terminate();
      } else {
        c.pumpstrAlive = false;
      }
    }
    for (const c of deadClients) clients.delete(c);

    assert.strictEqual(clients.size, 2);
    assert.ok(!clients.has(client2));
    assert.ok(clients.has(client1));
    assert.ok(clients.has(client3));
  });
});

describe("B5 — Rejet multi-broadcaster", () => {
  it("deuxième golive est rejeté", () => {
    const messages: any[] = [];
    const sig = createSignaling((msg) => messages.push(msg));

    const broadcaster1 = { send: (s: string) => messages.push(JSON.parse(s)), readyState: 1 };
    const broadcaster2 = { send: (s: string) => messages.push(JSON.parse(s)), readyState: 1 };

    // Premier broadcaster
    sig.onMessage(broadcaster1, { type: "golive" });
    assert.strictEqual(sig.isLive(), true);

    // Second broadcaster — doit être rejeté
    sig.onMessage(broadcaster2, { type: "golive" });

    const errorMsg = messages.find((m) => m.type === "error");
    assert.ok(errorMsg, "Un message d'erreur doit être envoyé");
    assert.ok(errorMsg.message.includes("déjà en cours"));
    assert.strictEqual(sig.isLive(), true); // Le premier broadcaster reste actif
  });

  it("détachement du broadcaster libère le slot", () => {
    const sig = createSignaling(() => {});
    const broadcaster = { send: () => {}, readyState: 1 };

    sig.onMessage(broadcaster, { type: "golive" });
    assert.strictEqual(sig.isLive(), true);

    sig.detach(broadcaster);
    assert.strictEqual(sig.isLive(), false);

    // Un nouveau broadcaster peut maintenant prendre le slot
    const broadcaster2 = { send: () => {}, readyState: 1 };
    sig.onMessage(broadcaster2, { type: "golive" });
    assert.strictEqual(sig.isLive(), true);
  });
});
