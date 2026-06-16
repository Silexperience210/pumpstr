/**
 * Pumpstr — test live de `refund()` et `exit()` sur Arkade mutinynet.
 *
 * ⚠️ Ce script bouge de vrais sats de test. Utilisez uniquement sur mutinynet.
 *
 * Prérequis :
 *   - une seed plateforme avec des VTXO spendables (créateur du node ou wallet de test)
 *   - pour refund : une `ClaimableRef` existante (récupérée après `POST /api/reward`)
 *
 * Usage :
 *   # Exit unilatéral L1 (récupère tous les VTXO recoverables du wallet)
 *   ARK_SERVER_URL=https://mutinynet.arkade.sh \
 *   PLATFORM_SEED="abandon abandon abandon ..." \
 *   ACTION=exit npm run live:exit-refund
 *
 *   # Refund d'une reward non réclamée (après expiry)
 *   ARK_SERVER_URL=https://mutinynet.arkade.sh \
 *   PLATFORM_SEED="abandon abandon abandon ..." \
 *   ACTION=refund \
 *   REF="pumpstr-claim&..." \
 *   npm run live:exit-refund
 */
import "fake-indexeddb/auto";
import { EventSource } from "eventsource";
(globalThis as any).EventSource ??= EventSource;

import { ArkadeRail } from "@pumpstr/payment-rail/arkade";

const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";
const PLATFORM_SEED = process.env.PLATFORM_SEED;
const ACTION = process.env.ACTION ?? "exit";
const REF = process.env.REF;

function bail(msg: string) {
  console.error("❌ " + msg);
  process.exit(1);
}

async function main() {
  if (!PLATFORM_SEED) bail("PLATFORM_SEED manquant (mnémonique BIP39 ou clé hex 64)");
  if (!["exit", "refund"].includes(ACTION)) bail("ACTION doit être 'exit' ou 'refund'");
  if (ACTION === "refund" && !REF) bail("REF manquant pour refund");

  console.log("== Pumpstr live test :", ACTION, "==");
  console.log("operator:", ARK_SERVER_URL);

  const rail = await ArkadeRail.fromSeed(PLATFORM_SEED!, {
    arkServerUrl: ARK_SERVER_URL,
    boltzNetwork: "mutinynet",
  });

  const address = await rail.getAddress();
  const balance = await rail.getBalance();
  console.log("plateforme address:", address);
  console.log("plateforme balance  :", balance.toString(), "sats");

  if (ACTION === "exit") {
    console.log("\n=> Lancement de exit() — sortie unilatérale L1");
    console.log("   (peut prendre du temps selon le CSV de l'opérateur)\n");
    const result = await rail.exit();
    console.log("✅ exit() terminé");
    console.log("   txid:", result.txid);
  } else {
    console.log("\n=> Lancement de refund() — récupération de la reward après expiry");
    const result = await rail.refund({ id: REF! });
    console.log("✅ refund() terminé");
    console.log("   id    :", result.id);
    console.log("   status:", result.status);
  }

  const after = await rail.getBalance();
  console.log("\nbalance après :", after.toString(), "sats");
  process.exit(0);
}

main().catch((e) => {
  console.error("\nLIVE TEST CRASH:", e?.stack ?? e?.message ?? e);
  process.exit(1);
});
