/**
 * Tests du cœur escrow réclamable — purs, déterministes, sans réseau.
 * Runner : node:test + tsx (respecte la résolution NodeNext `.js`).
 *
 * Run : npm test
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SingleKey,
  decodeTapscript,
  MultisigTapscript,
  CLTVMultisigTapscript,
  CSVMultisigTapscript,
  type RelativeTimelock,
} from "@arkade-os/sdk";
import {
  buildEscrowVtxoScript,
  parseBeneficiary,
  encodeRef,
  decodeRef,
  type EscrowRef,
} from "../src/arkade.js";

const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const xonly = (h: string) => SingleKey.fromHex(h).xOnlyPublicKey();

const PLATFORM = "11".repeat(32);
const BENEF = "22".repeat(32);
const SERVER = "33".repeat(32);
const EXPIRY = 1_900_000_000n; // timestamp CLTV
const EXIT: RelativeTimelock = { type: "seconds", value: 86_016n }; // multiple de 512 (BIP68)

// ---------- ClaimableRef (format `pumpstr-claim&k=v`) ----------
const sampleRef: EscrowRef = {
  net: "mutinynet",
  tapTree: "01c04420deadbeef",
  claimLeaf: "20" + "ab".repeat(32) + "ac",
  beneficiary: BENEF,
  expiry: EXPIRY.toString(),
  amount: "15000",
  tx: "abc123",
};

test("ref : round-trip encode -> decode", () => {
  const id = encodeRef(sampleRef);
  assert.ok(id.startsWith("pumpstr-claim&"));
  assert.deepEqual(decodeRef(id), sampleRef);
});

test("ref : rejette un tag inconnu", () => {
  assert.throws(() => decodeRef("garbage&net=mutinynet"), /invalide/);
});

test("ref : rejette un champ manquant", () => {
  assert.throws(() => decodeRef("pumpstr-claim&net=mutinynet&amount=1"), /champ manquant/);
});

// ---------- parseBeneficiary ----------
test("parseBeneficiary : accepte une pubkey x-only hex 32o", () => {
  const out = parseBeneficiary(BENEF);
  assert.equal(out.length, 32);
  assert.equal(hex(out), BENEF);
});

test("parseBeneficiary : rejette npub et garbage (décodage côté appelant)", () => {
  assert.throws(() => parseBeneficiary("npub1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), /x-only/);
  assert.throws(() => parseBeneficiary("pas-une-cle"), /x-only/);
  assert.throws(() => parseBeneficiary("ab".repeat(31)), /x-only/); // 31 octets
});

// ---------- buildEscrowVtxoScript (le construct) ----------
test("escrow : 3 feuilles, chaque feuille round-trip vers sa closure", async () => {
  const [b, p, s] = await Promise.all([xonly(BENEF), xonly(PLATFORM), xonly(SERVER)]);
  const { script, claim } = buildEscrowVtxoScript(b, p, s, EXPIRY, EXIT);

  assert.equal(script.scripts.length, 3, "claim/refund/exit");
  assert.ok(MultisigTapscript.is(decodeTapscript(script.scripts[0])), "claim = multisig");
  assert.ok(CLTVMultisigTapscript.is(decodeTapscript(script.scripts[1])), "refund = cltv-multisig");
  assert.ok(CSVMultisigTapscript.is(decodeTapscript(script.scripts[2])), "exit = csv-multisig");
  assert.equal(decodeTapscript(claim).type, "multisig");
});

test("escrow : self-custody — un exitPath est présent, la feuille claim est localisable", async () => {
  const [b, p, s] = await Promise.all([xonly(BENEF), xonly(PLATFORM), xonly(SERVER)]);
  const { script, claim } = buildEscrowVtxoScript(b, p, s, EXPIRY, EXIT);
  assert.ok(script.exitPaths().length >= 1, "sortie unilatérale");
  assert.doesNotThrow(() => script.findLeaf(hex(claim)), "feuille de payout retrouvable");
});

test("escrow : déterministe — mêmes entrées -> même pkScript/adresse", async () => {
  const [b, p, s] = await Promise.all([xonly(BENEF), xonly(PLATFORM), xonly(SERVER)]);
  const a = buildEscrowVtxoScript(b, p, s, EXPIRY, EXIT);
  const c = buildEscrowVtxoScript(b, p, s, EXPIRY, EXIT);
  assert.equal(hex(a.script.pkScript), hex(c.script.pkScript));
  assert.equal(a.script.address("tark", s).encode(), c.script.address("tark", s).encode());
});

test("escrow : une expiry différente change le script", async () => {
  const [b, p, s] = await Promise.all([xonly(BENEF), xonly(PLATFORM), xonly(SERVER)]);
  const a = buildEscrowVtxoScript(b, p, s, EXPIRY, EXIT);
  const c = buildEscrowVtxoScript(b, p, s, EXPIRY + 1n, EXIT);
  assert.notEqual(hex(a.script.pkScript), hex(c.script.pkScript));
});
