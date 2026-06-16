/**
 * Pumpstr spike — LN-in : recevoir un paiement Lightning DANS un wallet Arkade.
 *
 * Le flux exact qu'un viewer utiliserait pour tip depuis n'importe quel wallet LN :
 *   wallet Arkade -> BoltzSwapProvider -> ArkadeSwaps.createLightningInvoice()
 *   -> BOLT11 payable -> (paiement externe) -> waitAndClaim() -> VTXO crédité.
 *
 * Ce harness va jusqu'à PRODUIRE LA FACTURE (la preuve que le chemin LN-in existe
 * et répond). Le paiement effectif + claim demande des sats de test.
 *
 * Run : npm run lnin
 */
import "fake-indexeddb/auto"; // Node n'a pas IndexedDB. En RN : ./adapters/asyncStorage ou ./repositories/sqlite
import { SingleKey, Wallet } from "@arkade-os/sdk";
import { ArkadeSwaps, BoltzSwapProvider } from "@arkade-os/boltz-swap";

const ARK_SERVER_URL =
  process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";
const NETWORK = process.env.BOLTZ_NETWORK ?? "mutinynet";
const AMOUNT = Number(process.env.AMOUNT ?? 50000);

function randomPrivateKeyHex(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("hex");
}

async function main() {
  console.log("== Pumpstr spike : LN-in (Lightning -> VTXO) ==");
  console.log("operator:", ARK_SERVER_URL, "| boltz network:", NETWORK, "| amount:", AMOUNT, "\n");

  const identity = SingleKey.fromHex(process.env.PRIV_HEX ?? randomPrivateKeyHex());

  let wallet;
  try {
    wallet = await Wallet.create({ identity, arkServerUrl: ARK_SERVER_URL });
    console.log("[1] Wallet.create ............................. PASS");
  } catch (e: any) {
    console.log("[1] Wallet.create ............................. FAIL —", e?.message ?? e);
    return;
  }

  try {
    const swapProvider = new BoltzSwapProvider({ network: NETWORK as any });
    console.log("[2] BoltzSwapProvider (apiUrl auto) ........... PASS  ->", swapProvider.getApiUrl?.() ?? "(url interne)");

    const swaps = new ArkadeSwaps({ wallet, swapProvider, swapManager: true });
    console.log("[3] ArkadeSwaps assemblé ...................... PASS");

    const result: any = await swaps.createLightningInvoice({ amount: AMOUNT });
    const invoice = result?.invoice ?? result?.bolt11 ?? result?.paymentRequest;
    console.log("[4] createLightningInvoice() .................. PASS");
    console.log("\n  >>> FACTURE LN-in PAYABLE (preuve du chemin) :\n");
    console.log("  ", invoice ?? JSON.stringify(result));
    console.log("\n  (payer cette facture créditerait un VTXO via waitAndClaim / SwapManager auto-claim)");
  } catch (e: any) {
    console.log("[2-4] chemin LN-in ............................ FAIL —", e?.message ?? e);
    console.log("      (si 'network'/apiUrl : ajuste BOLTZ_NETWORK ou passe un apiUrl Boltz testnet explicite)");
  }
}

main()
  .then(() => process.exit(0)) // idem : on coupe la souscription WS après impression
  .catch((e) => {
    console.error("LN-IN CRASH:", e?.stack ?? e);
    process.exit(1);
  });
