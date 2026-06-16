/**
 * Tests de validation.ts — logique pure, sans réseau.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSats, parsePubkey, requirePubkey, parseName, parseComment, parseLnAddressUser } from "../validation.js";
import { nip19 } from "nostr-tools";

const VALID_PUBKEY = "0".repeat(63) + "1";
const VALID_NPUB = nip19.npubEncode(VALID_PUBKEY);

test("parseSats accepte un entier positif", () => {
  assert.equal(parseSats(1000), 1000n);
  assert.equal(parseSats("5000"), 5000n);
  assert.equal(parseSats(1n), 1n);
});

test("parseSats rejette les montants invalides", () => {
  assert.throws(() => parseSats(0), /positif/);
  assert.throws(() => parseSats(-10), /positif/);
  assert.throws(() => parseSats(1.5), /montant invalide|entier/);
  assert.throws(() => parseSats("abc"), /montant invalide/);
  assert.throws(() => parseSats(null as any), /montant manquant/);
  assert.throws(() => parseSats(100_000_000_001), /trop élevé/);
});

test("parseSats respecte min/max custom", () => {
  assert.throws(() => parseSats(100, { min: 200n }), /trop faible/);
  assert.throws(() => parseSats(1000, { max: 500n }), /trop élevé/);
});

test("parsePubkey accepte pubkey hex et npub", () => {
  assert.equal(parsePubkey(VALID_PUBKEY), VALID_PUBKEY);
  const fromNpub = parsePubkey(VALID_NPUB);
  assert.ok(fromNpub && /^[0-9a-f]{64}$/.test(fromNpub));
});

test("parsePubkey rejette les entrées invalides", () => {
  assert.equal(parsePubkey(""), null);
  assert.equal(parsePubkey("npub1invalid"), null);
  assert.equal(parsePubkey("zz".repeat(32)), null);
});

test("requirePubkey lance sur entrée invalide", () => {
  assert.throws(() => requirePubkey(""), /pubkey\/npub invalide/);
});

test("parseName tronque et fallback", () => {
  assert.equal(parseName("  alice  "), "alice");
  assert.equal(parseName(""), "anon");
  assert.equal(parseName("x".repeat(50)).length, 24);
});

test("parseComment tronque à 140 caractères", () => {
  assert.equal(parseComment("hello"), "hello");
  assert.equal(parseComment("x".repeat(200)).length, 140);
});

test("parseLnAddressUser valide le format", () => {
  assert.equal(parseLnAddressUser("pay"), "pay");
  assert.equal(parseLnAddressUser("Pay-21_"), "pay-21_");
  assert.throws(() => parseLnAddressUser("pay@domain"), /identifiant lightning address invalide/);
  assert.throws(() => parseLnAddressUser(""), /identifiant lightning address invalide/);
});
