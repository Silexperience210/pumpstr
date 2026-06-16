/**
 * PaymentRail — l'abstraction money de Pumpstr.
 *
 * Garde tout le produit agnostique du rail sats. Implémentation par défaut : Arkade.
 * Décision : voir DECISIONS.md (ADR-001, ADR-007). Aucun appel SDK rail en dur ailleurs.
 *
 * Les montants sont en satoshis (bigint pour éviter les pièges de précision flottante —
 * cf. les crashs BigInt déjà rencontrés sur d'autres projets de l'auteur).
 */

export type Sats = bigint;

export interface PaymentResult {
  /** Identifiant interne de l'opération. */
  id: string;
  status: "settled" | "pending";
}

export interface ClaimableOpts {
  /** Timestamp UNIX d'expiration de l'escrow réclamable. */
  expiresAt?: number;
  /** Split plateforme en basis points (ADR-006, zap-split par défaut). 100 bps = 1%. */
  splitToPlatformBps?: number;
}

export interface ClaimableRef {
  id: string;
}

export interface PaymentRail {
  /** Adresse de réception stable de ce compte (ex. adresse Arkade / VTXO). */
  getAddress(): Promise<string>;

  /** Solde dépensable, en sats. */
  getBalance(): Promise<Sats>;

  /**
   * Envoie des sats à une autre adresse du rail.
   * Cas nominal : tip in-app P2P, créateur online (transfert VTXO co-signé, instant).
   */
  send(toAddress: string, amount: Sats, memo?: string): Promise<PaymentResult>;

  /**
   * Crée une facture Lightning pour qu'un wallet LN externe paie en entrée.
   * Sur Arkade : honoré par la gateway LN-in (ex. le LND de l'Umbrel) qui bridge
   * le HTLC en VTXO.
   *
   * SPIKE #1 — l'ergonomie de ce bridge est le risque n°1 à dérisquer.
   */
  createLnInvoice(amount: Sats, memo?: string): Promise<{ bolt11: string }>;

  /**
   * Reward async (bénéficiaire potentiellement offline). Les fonds sont parqués dans
   * un construct *réclamable* (Arkade Script : dépensable par la pubkey `beneficiary`)
   * et se matérialisent dans le wallet du bénéficiaire au `claim()`. Sidestep la
   * réception-offline immature.
   *
   * SPIKE #2 — la faisabilité exacte du VTXO réclamable scripté.
   */
  escrowClaimable(
    beneficiary: string,
    amount: Sats,
    opts?: ClaimableOpts,
  ): Promise<ClaimableRef>;

  /** Réclame une récompense préalablement mise en escrow, vers ce wallet. */
  claim(ref: ClaimableRef): Promise<PaymentResult>;

  /**
   * Reprend une récompense non réclamée par le bénéficiaire après expiration.
   * Seule la clé qui a créé l'escrow (plateforme) peut déclencher ce refund.
   */
  refund(ref: ClaimableRef): Promise<PaymentResult>;

  /**
   * Sortie unilatérale vers Bitcoin L1 — la garantie self-custody.
   * Toujours disponible, sans coopération de l'opérateur.
   */
  exit(): Promise<{ txid: string }>;
}

/** Fabrique du rail — branche l'implémentation concrète ici (défaut : Arkade). */
export interface PaymentRailFactory {
  /** Restaure/ouvre un rail depuis une seed BIP39 (la même qui dérive le npub Nostr). */
  fromSeed(seed: string): Promise<PaymentRail>;
}
