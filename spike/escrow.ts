/**
 * Pumpstr spike #2 — VTXO réclamable (escrow scripté Arkade) pour rewards async/offline.
 *
 * Le problème : récompenser un bénéficiaire qui peut être OFFLINE (curation-to-earn,
 * challenge gagné plus tard). On ne peut pas juste `send()` vers son wallet : la
 * réception Ark demande qu'il participe à un round. On parque donc les sats dans un
 * VTXO *scripté* que LUI SEUL peut réclamer quand il revient — et que la plateforme
 * peut reprendre si jamais réclamé (pas de fonds bloqués).
 *
 * Construct = VtxoScript à 3 feuilles (un VHTLC SANS le hashlock) :
 *   [claim ]  multisig(bénéficiaire, serveur)             -> payout collaboratif, instantané (off-chain)
 *   [refund]  CLTV(expiry) + multisig(plateforme, serveur) -> reprise des rewards non réclamés
 *   [exit  ]  CSV(unilateralExitDelay) + (bénéficiaire)    -> sortie unilatérale L1 = self-custody
 *
 * Ce harness PROUVE le construct (offline, JS pur) PUIS dérive la VRAIE adresse
 * d'escrow `tark1…` contre l'opérateur live (clé serveur + dust + delay réels).
 * Le funding + le claim effectif demandent des sats de test (cf. SPIKE-2-RESULT.md).
 *
 * Run : npm run escrow
 */
import "fake-indexeddb/auto"; // Node n'a pas IndexedDB. En RN : ./adapters/asyncStorage
import {
  SingleKey,
  RestArkProvider,
  VtxoScript,
  MultisigTapscript,
  CSVMultisigTapscript,
  CLTVMultisigTapscript,
  decodeTapscript,
  toXOnlySignerHex,
  networks,
  VHTLC,
  type RelativeTimelock,
} from "@arkade-os/sdk";

const ARK_SERVER_URL = process.env.ARK_SERVER_URL ?? "https://mutinynet.arkade.sh";

function randomKey(): SingleKey {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  return SingleKey.fromHex(Buffer.from(b).toString("hex"));
}
const hexN = (n: number) => {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
};
const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const ok = (label: string) => console.log(`${label} `.padEnd(54, ".") + " PASS");
const ko = (label: string, e: any) => console.log(`${label} `.padEnd(54, ".") + " FAIL — " + (e?.message ?? e));

async function main() {
  console.log("== Pumpstr spike #2 : VTXO réclamable (escrow scripté) ==");
  console.log("operator:", ARK_SERVER_URL, "\n");

  // [1] Identités — JS pur, AUCUN réseau. plateforme (sender) + bénéficiaire (receiver).
  let platformX: Uint8Array, beneficiaryX: Uint8Array;
  try {
    const platform = randomKey();
    const beneficiary = randomKey();
    platformX = await platform.xOnlyPublicKey(); // 32B x-only
    beneficiaryX = await beneficiary.xOnlyPublicKey();
    ok("[1] clés plateforme + bénéficiaire (x-only, JS pur)");
  } catch (e: any) {
    ko("[1] clés", e);
    return;
  }

  // On a besoin de la clé SERVEUR pour fermer le script. Hors-ligne d'abord avec une
  // clé serveur factice (prouve le construct), puis on re-dérive avec la vraie en [4].
  // NB: doit être un VRAI point de courbe x-only — @scure valide la clé au decode.
  const dummyServerX = await randomKey().xOnlyPublicKey();

  // [2] LE CONSTRUCT — 3 feuilles depuis les closures reconnues par arkd.
  //     Prouvé offline : encode -> VtxoScript -> re-decode chaque feuille.
  const buildClaimable = (serverX: Uint8Array, expiry: bigint, exitDelay: RelativeTimelock) => {
    const claim = MultisigTapscript.encode({ pubkeys: [beneficiaryX, serverX] }).script;
    const refund = CLTVMultisigTapscript.encode({
      absoluteTimelock: expiry,
      pubkeys: [platformX, serverX],
    }).script;
    const exit = CSVMultisigTapscript.encode({
      timelock: exitDelay,
      pubkeys: [beneficiaryX],
    }).script;
    return { script: new VtxoScript([claim, refund, exit]), claim, refund, exit };
  };

  const EXPIRY = BigInt(Math.floor(Date.now() / 1000) + 30 * 24 * 3600); // +30j (timestamp CLTV)
  const EXIT_DELAY: RelativeTimelock = { type: "seconds", value: 86_016n }; // ~1j, multiple de 512 (BIP68)

  let bespoke: ReturnType<typeof buildClaimable>;
  try {
    bespoke = buildClaimable(dummyServerX, EXPIRY, EXIT_DELAY);

    // round-trip : chaque feuille redevient sa closure typée -> arkd la reconnaît
    const tClaim = decodeTapscript(bespoke.claim).type;
    const tRefund = decodeTapscript(bespoke.refund).type;
    const tExit = decodeTapscript(bespoke.exit).type;
    if (!MultisigTapscript.is(decodeTapscript(bespoke.claim))) throw new Error("claim != multisig");
    if (!CLTVMultisigTapscript.is(decodeTapscript(bespoke.refund))) throw new Error("refund != cltv");
    if (!CSVMultisigTapscript.is(decodeTapscript(bespoke.exit))) throw new Error("exit != csv");
    ok("[2] construct 3 feuilles (claim/refund/exit) + round-trip decode");
    console.log("      claim =", tClaim, "| refund =", tRefund, "| exit =", tExit);

    // self-custody : le script DOIT exposer un chemin de sortie unilatéral
    const exits = bespoke.script.exitPaths();
    if (exits.length < 1) throw new Error("aucun exitPath détecté");
    ok("[2b] exitPaths() -> sortie unilatérale self-custody présente");

    // on doit pouvoir RETROUVER la feuille claim par son hex (nécessaire au claim réel)
    bespoke.script.findLeaf(hex(bespoke.claim));
    ok("[2c] findLeaf(claim) -> feuille de payout localisable pour le spend");
  } catch (e: any) {
    ko("[2] construct", e);
    return;
  }

  // [3] CROSS-CHECK — VHTLC, le template équivalent éprouvé en prod (Boltz). Même
  //     parties ; si arkd refusait de co-signer le bespoke, on retombe sur VHTLC.
  try {
    const vhtlc = new VHTLC.Script({
      sender: platformX,
      receiver: beneficiaryX,
      server: dummyServerX,
      preimageHash: hexN(20), // hash160 (valeur publique : le secret, c'est la clé receiver)
      refundLocktime: EXPIRY,
      unilateralClaimDelay: EXIT_DELAY,
      unilateralRefundDelay: { type: "seconds", value: 86_528n },
      unilateralRefundWithoutReceiverDelay: { type: "seconds", value: 87_040n },
    });
    // VHTLC expose claim (receiver+server) et refundWithoutReceiver (sender+server après CLTV)
    vhtlc.claim();
    vhtlc.refundWithoutReceiver();
    ok("[3] cross-check VHTLC (template prouvé) construit + chemins claim/refund");
  } catch (e: any) {
    ko("[3] VHTLC cross-check", e);
  }

  // [4] RÉSEAU — vraie clé serveur + params depuis l'opérateur, vraie adresse tark1.
  try {
    const info = await new RestArkProvider(ARK_SERVER_URL).getInfo();
    const serverX = Buffer.from(toXOnlySignerHex(info.signerPubkey), "hex"); // 33B -> x-only 32B
    const prefix =
      (networks as any)[info.network]?.hrp ?? (info.network === "bitcoin" ? "ark" : "tark");

    // CSV exit = le délai de sortie unilatérale RÉEL de l'opérateur (secondes)
    const realExit: RelativeTimelock = { type: "seconds", value: info.unilateralExitDelay };
    const real = buildClaimable(serverX, EXPIRY, realExit);
    const address = real.script.address(prefix, serverX).encode();

    ok("[4] opérateur connecté + escrow dérivé avec la vraie clé serveur");
    console.log("      network         :", info.network, "| dust(min claimable):", info.dust.toString(), "sats");
    console.log("      unilateralExit  :", info.unilateralExitDelay.toString(), "s");
    console.log("\n  >>> ADRESSE D'ESCROW RÉCLAMABLE (réelle, fundable) :\n");
    console.log("     ", address);
    console.log("\n  (un send() vers cette adresse crée le VTXO réclamable ;");
    console.log("   le bénéficiaire le claim via la feuille multisig(bénéf,serveur))");
  } catch (e: any) {
    ko("[4] étape réseau", e);
    console.log("      (opérateur down OU réseau bloqué — le construct [1-3] reste valide)");
  }
}

main()
  .then(() => process.exit(0)) // pas de wallet ici, mais on coupe net par cohérence
  .catch((e) => {
    console.error("ESCROW SPIKE CRASH:", e?.stack ?? e);
    process.exit(1);
  });
