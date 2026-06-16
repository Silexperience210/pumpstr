/**
 * Tests des helpers purs de `escrow-spend.ts` (construction d'inputs, filtrage).
 * Sans réseau, sans wallet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildEscrowInputs,
  buildEscrowVtxoScript,
  filterSpendableVtxos,
  fromHex,
  toHex,
} from "../src/escrow-spend.js";
import { SingleKey, type RelativeTimelock } from "@arkade-os/sdk";

const hex = toHex;
const xonly = (h: string) => SingleKey.fromHex(h).xOnlyPublicKey();

const PLATFORM = "11".repeat(32);
const BENEF = "22".repeat(32);
const SERVER = "33".repeat(32);
const EXPIRY = 1_900_000_000n;
const EXIT: RelativeTimelock = { type: "seconds", value: 86_016n };

function fakeVtxo(overrides: Partial<{ isSpent: boolean; spentBy: string; isUnrolled: boolean; value: number }> = {}) {
  return {
    txid: "abc",
    vout: 0,
    value: 1_000,
    script: "0011",
    ...overrides,
  } as any;
}

test("filterSpendableVtxos garde seulement les VTXO dépensables", () => {
  const spendable = fakeVtxo();
  const spent = fakeVtxo({ isSpent: true });
  const unrolled = fakeVtxo({ isUnrolled: true });
  const zero = fakeVtxo({ value: 0 });
  const out = filterSpendableVtxos([spendable, spent, unrolled, zero]);
  assert.equal(out.length, 1);
  assert.equal(out[0], spendable);
});

test("buildEscrowInputs attache tapTree et leaf script", async () => {
  const [b, p, s] = await Promise.all([xonly(BENEF), xonly(PLATFORM), xonly(SERVER)]);
  const { script, claim } = buildEscrowVtxoScript(b, p, s, EXPIRY, EXIT);
  const vtxos = [fakeVtxo(), fakeVtxo()];
  const inputs = buildEscrowInputs(script, script.findLeaf(hex(claim)), vtxos as any);
  assert.equal(inputs.length, 2);
  for (const input of inputs) {
    assert.equal(hex(input.tapTree), hex(script.encode()));
    assert.ok(input.forfeitTapLeafScript);
    assert.ok(input.intentTapLeafScript);
  }
});

test("buildEscrowVtxoScript retourne claim ET refund", async () => {
  const [b, p, s] = await Promise.all([xonly(BENEF), xonly(PLATFORM), xonly(SERVER)]);
  const { script, claim, refund } = buildEscrowVtxoScript(b, p, s, EXPIRY, EXIT);
  assert.equal(script.scripts.length, 3);
  assert.doesNotThrow(() => script.findLeaf(hex(claim)), "claim retrouvable");
  assert.doesNotThrow(() => script.findLeaf(hex(refund)), "refund retrouvable");
});
