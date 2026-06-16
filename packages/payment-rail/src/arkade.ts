/**
 * ArkadeRail — implémentation **Arkade** de `PaymentRail` (ADR-001, ADR-007).
 *
 * Le cœur de ce fichier est le couple **escrowClaimable / claim** (spike #2,
 * cf. `spike/SPIKE-2-RESULT.md`) : parquer des sats dans un VTXO scripté qu'un
 * bénéficiaire potentiellement offline réclame plus tard, sans jamais bloquer
 * les fonds (la plateforme peut reprendre après expiry).
 *
 * Le construct = un VtxoScript à 3 feuilles (un VHTLC sans le hashlock) :
 *   claim  = multisig(bénéficiaire, serveur)              → payout collaboratif, instantané
 *   refund = CLTV(expiry) + multisig(plateforme, serveur) → reprise des rewards non réclamés
 *   exit   = CSV(unilateralExitDelay) + (bénéficiaire)    → sortie unilatérale L1 (self-custody)
 *
 * ⚠️ Point à confirmer avec des sats de test (open Q du spike #2) : qu'arkd
 * **co-signe** le spend collaboratif d'un VtxoScript *bespoke* (≠ type de contrat
 * enregistré). Les feuilles sont toutes des closures reconnues et la feuille
 * `claim` inclut la clé serveur (donc le serveur est signataire requis), comme
 * pour un VHTLC — qui, lui, est prouvé co-signable. `claim()` le tranchera live.
 *
 * Le host (node ou RN) fournit les polyfills avant d'appeler `Wallet.create` :
 *   - Node : `import "fake-indexeddb/auto"` (stockage) **et** `globalThis.EventSource ??= …`
 *            depuis `eventsource` (le ContractWatcher du SDK fait du SSE) — sinon spam
 *            `ReferenceError: EventSource is not defined`.
 *   - RN   : adapters `@arkade-os/sdk/adapters/asyncStorage` / `/repositories/sqlite` + `react-native-sse`.
 */
import {
  Wallet,
  SingleKey,
  MnemonicIdentity,
  RestArkProvider,
  RestIndexerProvider,
  VtxoScript,
  ArkAddress,
  MultisigTapscript,
  CSVMultisigTapscript,
  CLTVMultisigTapscript,
  toXOnlySignerHex,
} from "@arkade-os/sdk";
import type {
  ArkInfo,
  ExtendedVirtualCoin,
  TapLeafScript,
  Identity,
  IncomingFunds,
} from "@arkade-os/sdk";
import { ArkadeSwaps, BoltzSwapProvider } from "@arkade-os/boltz-swap";
import type {
  PaymentRail,
  PaymentRailFactory,
  PaymentResult,
  ClaimableOpts,
  ClaimableRef,
  Sats,
} from "./index.js";

const toHex = (u: Uint8Array) => Buffer.from(u).toString("hex");
const fromHex = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));

// Types dérivés de la signature SDK — évite d'importer @scure/btc-signer ici.
type OffchainOutput = Parameters<Wallet["buildAndSubmitOffchainTx"]>[1][number];

const DEFAULTS = {
  arkServerUrl: "https://mutinynet.arkade.sh",
  boltzNetwork: "mutinynet" as const,
  defaultEscrowTtlSec: 30 * 24 * 3600, // 30 jours
  lnAutoClaim: true,
};

export interface ArkadeRailConfig {
  /** Opérateur Arkade. Défaut : MutinyNet. Mainnet : `https://arkade.computer`. */
  arkServerUrl?: string;
  /** Indexer (recherche des VTXO d'escrow). Défaut : `arkServerUrl`. */
  indexerUrl?: string;
  /** Réseau Boltz pour le LN-in. */
  boltzNetwork?: "bitcoin" | "mutinynet" | "regtest";
  /** TTL d'escrow par défaut (s) si `opts.expiresAt` absent. */
  defaultEscrowTtlSec?: number;
  /**
   * `true` (défaut) : Boltz auto-claim le LN-in (les fonds tombent seuls — usage générique).
   * `false` : pas d'auto-claim ; le caller règle explicitement via `createLnInvoiceWithSettle().settle()`
   * (ce dont le node a besoin pour corréler identité↔paiement).
   */
  lnAutoClaim?: boolean;
}

/** Bénéficiaire attendu en **pubkey x-only hex (32 o)** — c'est aussi le pubkey Nostr (ADR-004). */
function parseBeneficiary(b: string): Uint8Array {
  const t = b.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return fromHex(t);
  throw new Error(
    "escrowClaimable: 'beneficiary' attendu en pubkey x-only hex 32o " +
      "(un npub se décode en hex côté appelant — p.ex. nostr-tools nip19.decode).",
  );
}

// --- Sérialisation du ClaimableRef.id (portable, sans base64 : RN-safe) ---
interface EscrowRef {
  net: string;
  tapTree: string; // hex de VtxoScript.encode()
  claimLeaf: string; // hex du script de la feuille claim (pour findLeaf)
  beneficiary: string; // x-only hex
  expiry: string; // bigint -> string
  amount: string; // sats escrow -> string
  tx: string; // txid de funding (informatif)
}
const REF_TAG = "pumpstr-claim&";
function encodeRef(r: EscrowRef): string {
  return REF_TAG + Object.entries(r).map(([k, v]) => `${k}=${v}`).join("&");
}
function decodeRef(id: string): EscrowRef {
  if (!id.startsWith(REF_TAG)) throw new Error("claim(): ClaimableRef invalide");
  const out: Record<string, string> = {};
  for (const part of id.slice(REF_TAG.length).split("&")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  for (const k of ["net", "tapTree", "claimLeaf", "beneficiary", "expiry", "amount", "tx"]) {
    if (!(k in out)) throw new Error(`claim(): ClaimableRef — champ manquant '${k}'`);
  }
  return out as unknown as EscrowRef;
}

export class ArkadeRail implements PaymentRail {
  private info?: ArkInfo;
  private swaps?: ArkadeSwaps; // instance Boltz unique, paresseuse

  private constructor(
    private readonly wallet: Wallet,
    private readonly ark: RestArkProvider,
    private readonly indexer: RestIndexerProvider,
    private readonly cfg: Required<ArkadeRailConfig>,
  ) {}

  /** Ouvre un rail depuis une identité Arkade déjà construite. */
  static async fromIdentity(identity: Identity, cfg: ArkadeRailConfig = {}): Promise<ArkadeRail> {
    const full: Required<ArkadeRailConfig> = {
      arkServerUrl: cfg.arkServerUrl ?? DEFAULTS.arkServerUrl,
      indexerUrl: cfg.indexerUrl ?? cfg.arkServerUrl ?? DEFAULTS.arkServerUrl,
      boltzNetwork: cfg.boltzNetwork ?? DEFAULTS.boltzNetwork,
      defaultEscrowTtlSec: cfg.defaultEscrowTtlSec ?? DEFAULTS.defaultEscrowTtlSec,
      lnAutoClaim: cfg.lnAutoClaim ?? DEFAULTS.lnAutoClaim,
    };
    const wallet = await Wallet.create({ identity, arkServerUrl: full.arkServerUrl });
    return new ArkadeRail(wallet, new RestArkProvider(full.arkServerUrl), new RestIndexerProvider(full.indexerUrl), full);
  }

  /** `PaymentRailFactory.fromSeed` : accepte un mnémonique BIP39 OU une clé brute 64-hex (ADR-004). */
  static async fromSeed(seed: string, cfg: ArkadeRailConfig = {}): Promise<ArkadeRail> {
    const t = seed.trim();
    const identity: Identity = /^[0-9a-fA-F]{64}$/.test(t)
      ? SingleKey.fromHex(t)
      : MnemonicIdentity.fromMnemonic(t, { isMainnet: (cfg.boltzNetwork ?? DEFAULTS.boltzNetwork) === "bitcoin" });
    return ArkadeRail.fromIdentity(identity, cfg);
  }

  // ---- helpers réseau ----
  private async getInfo(): Promise<ArkInfo> {
    return (this.info ??= await this.ark.getInfo());
  }
  private async serverXOnly(): Promise<Uint8Array> {
    return fromHex(toXOnlySignerHex((await this.getInfo()).signerPubkey));
  }
  private async addressPrefix(): Promise<string> {
    return (await this.getInfo()).network === "bitcoin" ? "ark" : "tark";
  }

  // ---- PaymentRail : surface validée au spike A ----
  getAddress(): Promise<string> {
    return this.wallet.getAddress();
  }
  async getBalance(): Promise<Sats> {
    const b = (await this.wallet.getBalance()) as { available?: number; total?: number };
    return BigInt(b.available ?? b.total ?? 0); // soldes Arkade en sats (number) -> bigint
  }
  async send(toAddress: string, amount: Sats, _memo?: string): Promise<PaymentResult> {
    const id = await this.wallet.send({ address: toAddress, amount: Number(amount) });
    return { id, status: "settled" };
  }
  /** Instance Boltz unique (réutilisée). `swapManager` suit `cfg.lnAutoClaim`. */
  private getSwaps(): ArkadeSwaps {
    return (this.swaps ??= new ArkadeSwaps({
      wallet: this.wallet,
      swapProvider: new BoltzSwapProvider({ network: this.cfg.boltzNetwork }),
      swapManager: this.cfg.lnAutoClaim,
    }));
  }

  async createLnInvoice(amount: Sats, memo?: string): Promise<{ bolt11: string }> {
    const { bolt11 } = await this.createLnInvoiceWithSettle(amount, memo);
    return { bolt11 };
  }

  /**
   * LN-in avec **poignée de règlement** : renvoie la facture ET `settle()` qui attend le
   * paiement puis claim le VTXO (`waitAndClaim`) → `{ txid }`. Garde Boltz encapsulé. À utiliser
   * avec `lnAutoClaim:false` (sinon l'auto-claim et `settle()` se marchent dessus). Le node s'en
   * sert pour corréler identité↔paiement (qui a payé quelle facture) avant de créditer le tip.
   */
  async createLnInvoiceWithSettle(
    amount: Sats,
    description?: string,
  ): Promise<{ bolt11: string; settle: () => Promise<{ txid: string }> }> {
    const swaps = this.getSwaps();
    const res = (await swaps.createLightningInvoice({ amount: Number(amount), description } as any)) as any;
    const bolt11 = res?.invoice ?? res?.bolt11 ?? res?.paymentRequest;
    if (!bolt11) throw new Error("createLnInvoice: pas de BOLT11 retourné par Boltz");
    const pendingSwap = res?.pendingSwap ?? res;
    const settle = async () => {
      const cl = (await (swaps as any).waitAndClaim(pendingSwap)) as { txid?: string };
      return { txid: cl?.txid ?? "" };
    };
    return { bolt11, settle };
  }

  /**
   * S'abonne aux **fonds entrants temps réel** (tips). Le callback reçoit `{newVtxos, spentVtxos}`
   * (off-chain) ou `{coins}` (on-chain) ; compter le net = Σnew − Σspent. Renvoie un `unsub()`.
   * Hors `PaymentRail` (orchestration spécifique Arkade) — utilisé par le host node.
   */
  onIncomingFunds(cb: (funds: IncomingFunds) => void): Promise<() => void> {
    return this.wallet.notifyIncomingFunds(cb);
  }

  // ================== SPIKE #2 : reward réclamable ==================

  /** Construit le VtxoScript d'escrow à 3 feuilles (claim/refund/exit). */
  private async buildEscrowScript(beneficiaryX: Uint8Array, expiry: bigint) {
    const info = await this.getInfo();
    const serverX = await this.serverXOnly();
    const platformX = await this.wallet.identity.xOnlyPublicKey();

    const claim = MultisigTapscript.encode({ pubkeys: [beneficiaryX, serverX] }).script;
    const refund = CLTVMultisigTapscript.encode({ absoluteTimelock: expiry, pubkeys: [platformX, serverX] }).script;
    const exit = CSVMultisigTapscript.encode({
      timelock: { type: "seconds", value: info.unilateralExitDelay },
      pubkeys: [beneficiaryX],
    }).script;
    return { script: new VtxoScript([claim, refund, exit]), claim };
  }

  /**
   * Parque `amount` sats dans un escrow réclamable par `beneficiary` (pubkey x-only hex).
   * Applique le zap-split ADR-006 si `opts.splitToPlatformBps` (la plateforme garde sa part,
   * on n'escrow que le reste). Le funding crée le VTXO ; le `ClaimableRef.id` porte tout le
   * nécessaire pour réclamer (script + feuille claim + expiry + bénéficiaire).
   */
  async escrowClaimable(beneficiary: string, amount: Sats, opts?: ClaimableOpts): Promise<ClaimableRef> {
    const info = await this.getInfo();
    const beneficiaryX = parseBeneficiary(beneficiary);

    const bps = BigInt(opts?.splitToPlatformBps ?? 0);
    const escrowAmount = amount - (amount * bps) / 10_000n;
    if (escrowAmount < info.dust) {
      throw new Error(`escrowClaimable: montant escrow ${escrowAmount} < dust (${info.dust} sats)`);
    }

    const expiry = BigInt(opts?.expiresAt ?? Math.floor(Date.now() / 1000) + this.cfg.defaultEscrowTtlSec);
    const { script, claim } = await this.buildEscrowScript(beneficiaryX, expiry);
    const address = script.address(await this.addressPrefix(), await this.serverXOnly()).encode();

    const tx = await this.wallet.send({ address, amount: Number(escrowAmount) });

    return {
      id: encodeRef({
        net: info.network,
        tapTree: toHex(script.encode()),
        claimLeaf: toHex(claim),
        beneficiary: toHex(beneficiaryX),
        expiry: expiry.toString(),
        amount: escrowAmount.toString(),
        tx,
      }),
    };
  }

  /**
   * Dérive l'adresse d'escrow **sans funder** (preview UI / vérification hors-ligne).
   * Déterministe : mêmes (bénéficiaire, expiry, serveur) → même adresse.
   */
  async previewEscrow(beneficiary: string, opts?: ClaimableOpts): Promise<{ address: string; expiry: bigint }> {
    const beneficiaryX = parseBeneficiary(beneficiary);
    const expiry = BigInt(opts?.expiresAt ?? Math.floor(Date.now() / 1000) + this.cfg.defaultEscrowTtlSec);
    const { script } = await this.buildEscrowScript(beneficiaryX, expiry);
    const address = script.address(await this.addressPrefix(), await this.serverXOnly()).encode();
    return { address, expiry };
  }

  /**
   * Réclame un escrow vers CE wallet. Exige que l'identité courante soit le bénéficiaire
   * (la feuille `claim` est un multisig bénéficiaire+serveur). Localise le VTXO via l'indexer,
   * puis dépense la feuille claim — le serveur co-signe au submit/finalize.
   */
  async claim(ref: ClaimableRef): Promise<PaymentResult> {
    const r = decodeRef(ref.id);

    const meX = toHex(await this.wallet.identity.xOnlyPublicKey());
    if (meX !== r.beneficiary) {
      throw new Error("claim(): ce wallet n'est pas le bénéficiaire de l'escrow");
    }

    const script = VtxoScript.decode(fromHex(r.tapTree));
    const claimLeaf: TapLeafScript = script.findLeaf(r.claimLeaf); // feuille de payout
    const pkScript = toHex(script.pkScript);

    // localise le(s) VTXO(s) parqué(s) à l'adresse d'escrow
    const { vtxos } = await this.indexer.getVtxos({ scripts: [pkScript] });
    const spendable = vtxos.filter((v) => !v.isSpent && !v.spentBy && !v.isUnrolled && v.value > 0);
    if (spendable.length === 0) {
      throw new Error("claim(): aucun VTXO réclamable (déjà réclamé, ou funding pas encore confirmé)");
    }

    const tapTree = script.encode();
    const inputs: ExtendedVirtualCoin[] = spendable.map((v) => ({
      ...(v as ExtendedVirtualCoin),
      tapTree,
      forfeitTapLeafScript: claimLeaf, // chemin co-signé serveur
      intentTapLeafScript: claimLeaf,
    }));

    const total = spendable.reduce((s, v) => s + v.value, 0);
    const myPkScript = ArkAddress.decode(await this.wallet.getAddress()).pkScript;
    const outputs: OffchainOutput[] = [{ script: myPkScript, amount: BigInt(total) } as OffchainOutput];

    // signe (bénéficiaire) -> submit -> finalize (co-signature serveur)
    const { arkTxid } = await this.wallet.buildAndSubmitOffchainTx(inputs, outputs);
    return { id: arkTxid, status: "settled" };
  }

  /**
   * Sortie unilatérale L1 (self-custody). Hors scope du spike #2 : à câbler via le flow
   * `Unroll` du SDK (broadcast du checkpoint + exit CSV). Volontairement non simulé.
   */
  async exit(): Promise<{ txid: string }> {
    throw new Error("exit(): non implémenté ici — câbler via le flow Unroll du SDK (hors scope spike #2)");
  }
}

/** Fabrique du rail Arkade (défaut du projet). */
export function arkadeRailFactory(cfg: ArkadeRailConfig = {}): PaymentRailFactory {
  return { fromSeed: (seed: string) => ArkadeRail.fromSeed(seed, cfg) };
}
