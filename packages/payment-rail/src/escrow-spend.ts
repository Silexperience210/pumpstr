/**
 * escrow-spend.ts — logique pure du VTXO d'escrow réclamable.
 *
 * Séparé de `arkade.ts` pour rester testable sans réseau et réutilisable
 * si d'autres rails implémentent le même pattern claim/refund/exit.
 *
 * Le construct = un VtxoScript à 3 feuilles (un VHTLC sans le hashlock) :
 *   claim  = multisig(bénéficiaire, serveur)              → payout collaboratif
 *   refund = CLTV(expiry) + multisig(plateforme, serveur) → reprise si non réclamé
 *   exit   = CSV(exitDelay) + (bénéficiaire)              → sortie unilatérale L1
 */
import {
  VtxoScript,
  MultisigTapscript,
  CSVMultisigTapscript,
  CLTVMultisigTapscript,
} from "@arkade-os/sdk";
import type {
  ExtendedVirtualCoin,
  TapLeafScript,
  RelativeTimelock,
} from "@arkade-os/sdk";

export const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");
export const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

/**
 * Référence portable d'un escrow réclamable.
 * Encode tout ce qui est nécessaire pour `claim()` ou `refund()` sans base de données.
 */
export interface EscrowRef {
  net: string;
  tapTree: string; // hex de VtxoScript.encode()
  claimLeaf: string; // hex du script de la feuille claim
  refundLeaf: string; // hex du script de la feuille refund
  beneficiary: string; // x-only hex
  expiry: string; // bigint -> string
  amount: string; // sats escrow -> string
  tx: string; // txid de funding (informatif)
}

const REF_TAG = "pumpstr-claim&";

export function encodeRef(r: EscrowRef): string {
  return REF_TAG + Object.entries(r).map(([k, v]) => `${k}=${v}`).join("&");
}

export function decodeRef(id: string): EscrowRef {
  if (!id.startsWith(REF_TAG)) throw new Error("escrow ref: ClaimableRef invalide");
  const out: Record<string, string> = {};
  for (const part of id.slice(REF_TAG.length).split("&")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  for (const k of ["net", "tapTree", "claimLeaf", "refundLeaf", "beneficiary", "expiry", "amount", "tx"]) {
    if (!(k in out)) throw new Error(`escrow ref: champ manquant '${k}'`);
  }
  return out as unknown as EscrowRef;
}

/** Bénéficiaire attendu en pubkey x-only hex (32 o) — c'est aussi le pubkey Nostr. */
export function parseBeneficiary(b: string): Uint8Array {
  const t = b.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return fromHex(t);
  throw new Error(
    "escrow: 'beneficiary' attendu en pubkey x-only hex 32o " +
      "(un npub se décode en hex côté appelant).",
  );
}

/**
 * Construit le VtxoScript d'escrow à 3 feuilles.
 * Déterministe : mêmes entrées → même script/adresse.
 */
export function buildEscrowVtxoScript(
  beneficiaryX: Uint8Array,
  platformX: Uint8Array,
  serverX: Uint8Array,
  expiry: bigint,
  exitDelay: RelativeTimelock,
): { script: VtxoScript; claim: Uint8Array; refund: Uint8Array } {
  const claim = MultisigTapscript.encode({ pubkeys: [beneficiaryX, serverX] }).script;
  const refund = CLTVMultisigTapscript.encode({ absoluteTimelock: expiry, pubkeys: [platformX, serverX] }).script;
  const exit = CSVMultisigTapscript.encode({ timelock: exitDelay, pubkeys: [beneficiaryX] }).script;
  return { script: new VtxoScript([claim, refund, exit]), claim, refund };
}

/**
 * Filtre les VTXO dépensables (non spendus, non unrolled, valeur > 0)
 * depuis la réponse brute de l'indexer.
 */
export function filterSpendableVtxos(vtxos: ExtendedVirtualCoin[]): ExtendedVirtualCoin[] {
  return vtxos.filter((v) => !v.isSpent && !v.spentBy && !v.isUnrolled && v.value > 0);
}

/**
 * Construit les inputs d'une transaction off-chain qui dépense un escrow
 * via la feuille choisie (claim ou refund).
 */
export function buildEscrowInputs(
  script: VtxoScript,
  leafScript: TapLeafScript,
  vtxos: ExtendedVirtualCoin[],
): ExtendedVirtualCoin[] {
  const tapTree = script.encode();
  return vtxos.map((v) => ({
    ...v,
    tapTree,
    forfeitTapLeafScript: leafScript,
    intentTapLeafScript: leafScript,
  }));
}
