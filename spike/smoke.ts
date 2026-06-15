/**
 * Pumpstr spike — Arkade wallet smoke test.
 *
 * Valide, contre l'opérateur public MutinyNet, que le SDK Arkade :
 *   [1] crée une identité en JS pur (offline) — pertinent RN
 *   [2] se connecte à un opérateur
 *   [3] dérive une adresse de réception
 *   [4] lit un solde
 *
 * Run : npm run smoke
 */
import "fake-indexeddb/auto"; // Node n'a pas IndexedDB. En RN : ./adapters/asyncStorage ou ./repositories/sqlite
import { SingleKey, Wallet } from "@arkade-os/sdk";

const ARK_SERVER_URL =
  process.env.ARK_SERVER_URL ?? "https://master.mutinynet.arklabs.to";

function randomPrivateKeyHex(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

const json = (v: unknown) =>
  JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val));

async function main() {
  console.log("== Pumpstr spike : Arkade wallet smoke ==");
  console.log("operator:", ARK_SERVER_URL, "\n");

  // [1] Identité — JS pur, AUCUN réseau. Prouve que la crypto tourne sans natif/WASM.
  let identity;
  try {
    const hex = process.env.PRIV_HEX ?? randomPrivateKeyHex();
    identity = SingleKey.fromHex(hex);
    console.log("[1] SingleKey.fromHex (offline, JS pur) ........ PASS");
  } catch (e: any) {
    console.log("[1] SingleKey.fromHex ......................... FAIL —", e?.message ?? e);
    return;
  }

  // [2-4] Réseau : connexion opérateur, adresse, solde.
  try {
    const wallet = await Wallet.create({ identity, arkServerUrl: ARK_SERVER_URL });
    console.log("[2] Wallet.create -> opérateur connecté ........ PASS");

    const address = await wallet.getAddress();
    console.log("[3] getAddress() .............................. PASS");
    console.log("      ", address);

    const balance = await wallet.getBalance();
    console.log("[4] getBalance() .............................. PASS");
    console.log("      ", json(balance));
  } catch (e: any) {
    console.log("[2-4] étape réseau ............................ FAIL —", e?.message ?? e);
    console.log("      (souvent : réseau sortant bloqué OU opérateur mutinynet down — l'API reste valide)");
  }
}

main()
  .then(() => process.exit(0)) // le VtxoManager ouvre une souscription WS qui garde Node vivant
  .catch((e) => {
    console.error("SMOKE CRASH:", e?.stack ?? e);
    process.exit(1);
  });
