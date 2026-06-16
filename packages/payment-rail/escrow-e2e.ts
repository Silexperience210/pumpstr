/**
 * E2E du reward réclamable — le round-trip COMPLET avec de vrais sats mutinynet.
 *
 *   funding (faucet → LN-in Boltz)  →  platform.escrowClaimable(benef)  →  benef.claim(ref)  →  vérif solde
 *
 * Tranche l'open question du spike #2 : **arkd co-signe-t-il le spend collaboratif d'un
 * VtxoScript bespoke ?** Si le claim crédite le bénéficiaire → 🟢 (le construct maison marche).
 * Sinon → pivot VHTLC (template prouvé).
 *
 * Clés persistées dans `.e2e-keys.json` (gitignoré) : re-run = réutilise le wallet déjà fundé
 * (évite de retaper le faucet, qui rate-limit par IP).
 *
 * Run : npm run e2e            (ARK_SERVER_URL=https://mutinynet.arkade.sh)
 */
import "fake-indexeddb/auto";
import { EventSource } from "eventsource";
(globalThis as any).EventSource ??= EventSource;
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SingleKey } from "@arkade-os/sdk";
import { ArkadeRail } from "./src/arkade.js";

const ARK = process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";
const FAUCET = process.env.FAUCET_URL ?? "https://faucet.mutinynet.com/api/lightning";
const FUND_SATS = Number(process.env.FUND_SATS ?? 100_000);
const ESCROW_SATS = Number(process.env.ESCROW_SATS ?? 50_000);
const WAIT_SEC = Number(process.env.FUND_WAIT_SEC ?? 600); // attente max du paiement manuel
const CLAIM_ONLY = process.env.CLAIM_ONLY === "1"; // re-tente le claim sur le ref persisté (gratuit)
const HERE = fileURLToPath(new URL(".", import.meta.url));
const KEYS_FILE = join(HERE, ".e2e-keys.json");
const REF_FILE = join(HERE, ".e2e-ref.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (b: bigint) => Number(b);
function randHex(): string {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return Buffer.from(b).toString("hex");
}
function loadKeys(): { platform: string; bene: string } {
  if (process.env.PLATFORM_HEX && process.env.BENE_HEX) {
    return { platform: process.env.PLATFORM_HEX, bene: process.env.BENE_HEX };
  }
  if (existsSync(KEYS_FILE)) return JSON.parse(readFileSync(KEYS_FILE, "utf8"));
  const k = { platform: randHex(), bene: randHex() };
  writeFileSync(KEYS_FILE, JSON.stringify(k));
  console.log("clés générées -> .e2e-keys.json (re-run réutilise le wallet fundé)\n");
  return k;
}

/** Fonde le wallet via faucet→LN-in. Renvoie true si fundé, false si funding manuel requis. */
async function ensureFunded(rail: ArkadeRail, minSats: number): Promise<boolean> {
  const bal = num(await rail.getBalance());
  if (bal >= minSats) {
    console.log(`[fund] déjà fundé : ${bal} sats (>= ${minSats}) — on saute le faucet`);
    return true;
  }
  console.log(`[fund] solde ${bal} < ${minSats} — création d'une facture LN-in ${FUND_SATS} sats…`);
  const { bolt11, settle } = await rail.createLnInvoiceWithSettle(BigInt(FUND_SATS), "pumpstr e2e fund");
  console.log("[fund] invoice:", bolt11);

  let autopaid = false;
  try {
    const r = await fetch(FAUCET, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bolt11 }),
    });
    const body = await r.text().catch(() => "");
    console.log(`[fund] faucet auto -> HTTP ${r.status} ${body.slice(0, 120)}`);
    autopaid = r.ok;
  } catch (e: any) {
    console.log("[fund] faucet injoignable :", e?.message ?? e);
  }

  if (!autopaid) {
    console.log("\n⚠️  Faucet auto KO (token requis). → PAIE CETTE FACTURE À LA MAIN :");
    console.log("    1) ouvre https://faucet.mutinynet.com   2) colle le bolt11 ci-dessus");
    console.log("    3) résous le captcha + submit  (le faucet paie, pas besoin de tes propres sats)");
  } else {
    console.log("[fund] faucet a payé — attente du claim Boltz…");
  }

  // Attend le règlement (waitAndClaim) — que le paiement vienne du faucet auto ou d'un humain.
  console.log(`[fund] j'attends le paiement (jusqu'à ${WAIT_SEC}s)…`);
  const settled = (await Promise.race([
    settle(),
    sleep(WAIT_SEC * 1000).then(() => null),
  ])) as { txid: string } | null;

  if (!settled) {
    console.log(`\n⏱️  Pas de paiement reçu à temps. Relance \`npm run e2e\` (clés persistées) et paie l'invoice.`);
    return false;
  }
  console.log(`[fund] ✅ VTXO crédité (txid ${settled.txid.slice(0, 16)}…). solde: ${num(await rail.getBalance())} sats`);
  return true;
}

async function main() {
  console.log("== Pumpstr E2E : escrowClaimable -> claim (vrais sats) ==\noperator:", ARK, "\n");
  const keys = loadKeys();
  const cfg = { arkServerUrl: ARK, boltzNetwork: "mutinynet" as const, lnAutoClaim: false };

  const platform = await ArkadeRail.fromSeed(keys.platform, cfg);
  const bene = await ArkadeRail.fromSeed(keys.bene, cfg);
  const beneX = Buffer.from(await SingleKey.fromHex(keys.bene).xOnlyPublicKey()).toString("hex");
  console.log("platform   :", await platform.getAddress());
  console.log("beneficiary:", await bene.getAddress(), "\n            x-only:", beneX, "\n");

  // 1+2) FUNDING + ESCROW  (sauté en CLAIM_ONLY : on rejoue le claim sur le ref persisté)
  let ref: { id: string };
  if (CLAIM_ONLY && existsSync(REF_FILE)) {
    ref = JSON.parse(readFileSync(REF_FILE, "utf8"));
    console.log("[claim-only] ref rechargé depuis .e2e-ref.json — re-tente le claim\n");
  } else {
    if (!(await ensureFunded(platform, ESCROW_SATS + 5_000))) return;
    console.log(`\n[escrow] escrowClaimable(benef, ${ESCROW_SATS} sats)…`);
    ref = await platform.escrowClaimable(beneX, BigInt(ESCROW_SATS));
    writeFileSync(REF_FILE, JSON.stringify(ref));
    console.log("[escrow] ✅ VTXO réclamable créé (ref persisté). ref:", ref.id.slice(0, 88), "…");
    console.log("\n[claim] attente indexation du VTXO d'escrow…");
    await sleep(4_000);
  }
  const before = num(await bene.getBalance());
  console.log(`[claim] solde bénéficiaire avant: ${before} sats — claim…`);
  let claimErr: any = null;
  let arkTxid = "";
  try {
    const res = await bene.claim(ref);
    arkTxid = res.id;
    console.log(`[claim] soumis. arkTxid: ${arkTxid} (${res.status})`);
  } catch (e: any) {
    claimErr = e;
    console.log("[claim] ❌ erreur:", e?.message ?? e);
  }

  // 4) VÉRIF
  await sleep(4_000);
  const after = num(await bene.getBalance());
  console.log(`\n[verify] solde bénéficiaire: ${before} -> ${after} sats`);

  if (!claimErr && after > before) {
    console.log("\n🟢 E2E VERT — arkd a CO-SIGNÉ le claim d'un VtxoScript bespoke.");
    console.log("   Le reward réclamable maison fonctionne bout-en-bout (ADR-004).");
  } else if (claimErr) {
    const m = String(claimErr?.message ?? claimErr);
    const signingGap = /sig|psbt|sign|witness/i.test(m);
    if (signingGap) {
      console.log("\n🟡 SCRIPT ACCEPTÉ par arkd, mais SIGNATURE manquante côté claim (bug client à corriger).");
      console.log("   → arkd ne rejette PAS le construct bespoke ; il faut juste attacher la sig tapscript");
      console.log("     du bénéficiaire sur l'input (comme le claim VHTLC de boltz-swap). Détail:", m.slice(0, 140));
    } else {
      console.log("\n🔴 CLAIM REJETÉ par arkd (script bespoke non co-signable).");
      console.log("   → pivot VHTLC (template prouvé). Détail:", m.slice(0, 140));
    }
  } else {
    console.log("\n🟠 Claim soumis sans erreur mais solde inchangé — délai d'indexation probable, relance la vérif.");
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("E2E CRASH:", e?.stack ?? e);
    process.exit(1);
  });
