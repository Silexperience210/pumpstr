/**
 * Tests de db.ts — persistance SQLite en mémoire.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { PumpstrDb } from "../db.js";

function makeDb() {
  return new PumpstrDb(":memory:");
}

test("addTip + recentTips", () => {
  const db = makeDb();
  db.addTip({ amount: 1000, name: "alice", via: "ln", createdAt: Date.now() });
  db.addTip({ amount: 2000, name: "bob", picture: "http://pic", pubkey: "pk", comment: "yo", via: "simulate", createdAt: Date.now() + 1 });
  const tips = db.recentTips();
  assert.equal(tips.length, 2);
  assert.equal(tips[0].amount, 2000);
  assert.equal(tips[1].amount, 1000);
  db.close();
});

test("recentTips respecte la limite", () => {
  const db = makeDb();
  for (let i = 0; i < 25; i++) db.addTip({ amount: i, name: "x", via: "demo", createdAt: Date.now() + i });
  assert.equal(db.recentTips().length, 20);
  assert.equal(db.recentTips(5).length, 5);
  db.close();
});

test("addReward + getRewardsFor", () => {
  const db = makeDb();
  const r = { id: "r1", to: "pk", npub: "npub1", amount: 1000, reason: "gg", ref: "ref1", createdAt: 1, claimed: 0 };
  db.addReward(r);
  const found = db.getRewardsFor("pk");
  assert.equal(found.length, 1);
  assert.equal(found[0].amount, 1000);
  db.close();
});

test("markRewardClaimed", () => {
  const db = makeDb();
  db.addReward({ id: "r1", to: "pk", npub: "npub1", amount: 1000, reason: "", ref: "ref1", createdAt: 1, claimed: 0 });
  assert.equal(db.markRewardClaimed("r1"), true);
  assert.equal(db.markRewardClaimed("r1"), false);
  assert.equal(db.getRewardsFor("pk").length, 0);
  db.close();
});

test("getRewardById", () => {
  const db = makeDb();
  db.addReward({ id: "r1", to: "pk", npub: "npub1", amount: 1000, reason: "", ref: "ref1", createdAt: 1, claimed: 0 });
  const found = db.getRewardById("r1");
  assert.ok(found);
  assert.equal(found!.id, "r1");
  assert.equal(db.getRewardById("nope"), undefined);
  db.close();
});

test("countUnclaimedRewards", () => {
  const db = makeDb();
  db.addReward({ id: "r1", to: "pk", npub: "npub1", amount: 1000, reason: "", ref: "ref1", createdAt: 1, claimed: 0 });
  db.addReward({ id: "r2", to: "pk", npub: "npub1", amount: 2000, reason: "", ref: "ref2", createdAt: 2, claimed: 0 });
  db.addReward({ id: "r3", to: "pk2", npub: "npub2", amount: 500, reason: "", ref: "ref3", createdAt: 3, claimed: 0 });
  assert.equal(db.countUnclaimedRewards("pk"), 2);
  db.markRewardClaimed("r1");
  assert.equal(db.countUnclaimedRewards("pk"), 1);
  db.close();
});
