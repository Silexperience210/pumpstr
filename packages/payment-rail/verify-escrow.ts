/**
 * Vérif runtime (sans sats) de l'ArkadeRail — prouve que la classe se câble bout-en-bout
 * contre l'opérateur live, dérive une vraie adresse d'escrow, et que `escrowClaimable`
 * traverse bien construct + dérivation et ne bute QUE sur le funding (pas de sats).
 *
 * Run : npm run verify   (ARK_SERVER_URL=https://mutinynet.arkade.sh)
 */
import "fake-indexeddb/auto";
import { EventSource } from "eventsource"; // le ContractWatcher du SDK fait du SSE en Node
(globalThis as any).EventSource ??= EventSource;
import { SingleKey } from "@arkade-os/sdk";
import { ArkadeRail } from "./src/arkade.js";

const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";
const ok = (l: string) => console.log(`${l} `.padEnd(52, ".") + " PASS");
const ko = (l: string, e: any) => console.log(`${l} `.padEnd(52, ".") + " FAIL — " + (e?.message ?? e));

function randHex(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return Buffer.from(b).toString("hex");
}

async function main() {
  console.log("== Vérif ArkadeRail (escrowClaimable/claim) ==\noperator:", ARK_SERVER_URL, "\n");

  let rail: ArkadeRail;
  try {
    rail = await ArkadeRail.fromSeed(randHex(), { arkServerUrl: ARK_SERVER_URL, boltzNetwork: "mutinynet" });
    ok("[1] ArkadeRail.fromSeed -> wallet créateur connecté");
    console.log("      address:", await rail.getAddress(), "| balance:", (await rail.getBalance()).toString(), "sats");
  } catch (e: any) {
    ko("[1] fromSeed", e);
    return;
  }

  // bénéficiaire = pubkey x-only (= un pubkey Nostr, ADR-004)
  const beneficiary = Buffer.from(await SingleKey.fromHex(randHex()).xOnlyPublicKey()).toString("hex");

  let escrowAddr = "";
  try {
    const preview = await rail.previewEscrow(beneficiary, { expiresAt: Math.floor(Date.now() / 1000) + 86_400 });
    escrowAddr = preview.address;
    if (!escrowAddr.startsWith("tark1")) throw new Error("préfixe adresse inattendu: " + escrowAddr);
    ok("[2] previewEscrow -> vraie adresse d'escrow dérivée (sans funder)");
    console.log("      escrow:", escrowAddr);
    // déterminisme : re-dériver donne la même adresse
    const again = await rail.previewEscrow(beneficiary, { expiresAt: preview.expiry });
    if (again.address !== escrowAddr) throw new Error("non déterministe");
    ok("[2b] déterminisme (mêmes params -> même adresse)");
  } catch (e: any) {
    ko("[2] previewEscrow", e);
    return;
  }

  // escrowClaimable doit TRAVERSER le construct et ne buter que sur le funding (0 sats)
  try {
    await rail.escrowClaimable(beneficiary, 1000n);
    ok("[3] escrowClaimable a fundé (inattendu sans sats, mais OK)");
  } catch (e: any) {
    const msg = String(e?.message ?? e).toLowerCase();
    const fundingStage = /fund|insufficient|balance|amount|utxo|vtxo|select|enough|solde/.test(msg);
    if (fundingStage) {
      ok("[3] escrowClaimable -> construct OK, échoue au funding (attendu, 0 sat)");
      console.log("      (erreur funding:", (e?.message ?? e).toString().slice(0, 90), ")");
    } else {
      ko("[3] escrowClaimable échoue AVANT le funding (bug construct)", e);
    }
  }

  // claim sur un ref bidon : doit refuser proprement (wallet != bénéficiaire)
  try {
    await rail.claim({ id: "pumpstr-claim&net=mutinynet&tapTree=00&claimLeaf=00&beneficiary=" + "ab".repeat(32) + "&expiry=0&amount=1000&tx=x" });
    ko("[4] claim aurait dû refuser un ref d'un autre bénéficiaire", new Error("pas d'erreur"));
  } catch (e: any) {
    if (/bénéficiaire|beneficiair/i.test(String(e?.message ?? e))) {
      ok("[4] claim refuse un escrow dont on n'est pas le bénéficiaire");
    } else {
      ko("[4] claim — erreur inattendue", e);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("VERIFY CRASH:", e?.stack ?? e);
    process.exit(1);
  });
