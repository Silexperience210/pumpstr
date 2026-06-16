# Spike #2 — VTXO réclamable (escrow scripté) — RÉSULTAT

**Date :** 2026-06-16 · **Verdict : 🟢 PROUVÉ BOUT-EN-BOUT (vrais sats).**
Le *reward async/offline* (`PaymentRail.escrowClaimable`/`claim`, cf. `../DECISIONS.md` ADR-004) tourne
**end-to-end sur MutinyNet** : `escrowClaimable(15000)` → `claim` → solde bénéficiaire **+15 000 sats**,
`arkTxid` settled. **L'open question est tranchée : arkd CO-SIGNE le claim d'un VtxoScript bespoke.**
Pas de pivot VHTLC nécessaire.

> ✅ **MAJ E2E (`packages/payment-rail/escrow-e2e.ts`, funding faucet→LN-in)** : le claim échouait d'abord
> sur `missing tapscript spend sig` — **pas un rejet du script** mais un détail client : le signer router du
> wallet **ignore tout input dont le script n'est pas un contrat enregistré** dans son `contractRepository`.
> Fix dans `ArkadeRail.claim()` : (1) `wallet.contractRepository.saveContract({type:"pumpstr-escrow", …})`
> (type custom → routé vers le signer identité) + (2) enregistrer un **handler** minimal (`contractHandlers.register`)
> qui reconstruit le script depuis le `tapTree` (sinon la sync de solde crashe `No handler for type`). Après ça : VERT.

Construct validé offline + funding/escrow/claim validés live contre **`https://mutinynet.arkade.sh`**.

---

## La question du spike

Comment récompenser un bénéficiaire **potentiellement offline** (curation-to-earn, challenge gagné
plus tard, payout différé) ? On ne peut pas juste `send()` vers son wallet : la réception Arkade
demande qu'il **participe à un round**. Il faut **parquer les sats** dans un construct que **lui seul**
peut réclamer à son retour — et que la plateforme peut **reprendre si jamais réclamé** (zéro fonds bloqué).

## La réponse : un VtxoScript à 3 feuilles (un VHTLC sans le hashlock)

```
escrow réclamable = VtxoScript([ claim, refund, exit ])
  [claim ]  multisig(bénéficiaire, serveur)              → payout collaboratif, instantané, off-chain
  [refund]  CLTV(expiry) + multisig(plateforme, serveur) → reprise des rewards non réclamés après expiry
  [exit  ]  CSV(unilateralExitDelay) + (bénéficiaire)    → sortie unilatérale L1 = self-custody (ADR : self-custody par défaut)
```

C'est **exactement la forme d'un VHTLC** (claim = receiver+server, refundWithoutReceiver = sender+server
après CLTV) **moins le verrou de hash** : ici le secret qui protège le payout, c'est **la clé du
bénéficiaire** (chemin `claim` multisig), pas un préimage. Les 3 feuilles sont des **closures standard
qu'arkd reconnaît** (`MultisigTapscript`, `CLTVMultisigTapscript`, `CSVMultisigTapscript`).

### Preuves (`escrow.ts`, tout PASS)
```
[1] clés plateforme + bénéficiaire (x-only, JS pur) ........... PASS
[2] construct 3 feuilles (claim/refund/exit) + round-trip decode  PASS
      claim = multisig | refund = cltv-multisig | exit = csv-multisig
[2b] exitPaths() -> sortie unilatérale self-custody présente ... PASS
[2c] findLeaf(claim) -> feuille de payout localisable .......... PASS
[3] cross-check VHTLC (template prouvé) ........................ PASS
[4] opérateur connecté + escrow dérivé (vraie clé serveur) ..... PASS
      network: mutinynet | dust(min claimable): 330 sats | unilateralExit: 172544 s (~2 j)
      >>> tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf855955e7x4dxsjntrhlk69jc58rp8zj8js4nvhurpf72ht7fxkdhjpmqzwc
```

- **Round-trip** : chaque feuille `encode()` → `VtxoScript` → `decodeTapscript()` retombe sur sa closure
  typée (`MultisigTapscript.is` / `CLTVMultisigTapscript.is` / `CSVMultisigTapscript.is`). Donc arkd
  parse et reconnaît le script.
- **Adresse réelle** dérivée avec la **vraie clé serveur** de l'opérateur (`info.signerPubkey` → x-only via
  `toXOnlySignerHex`). Le préfixe serveur de l'adresse correspond à celui du node Pumpstr qui tourne =
  même opérateur. **Fundable dès maintenant.**

---

## Mapping `PaymentRail` (ce que ça câble)

| Méthode | Mécanisme validé |
|---|---|
| `escrowClaimable(beneficiary, amount, opts)` | construit ce VtxoScript (bénéf x-only + serveur + `opts.expiresAt`→CLTV), dérive l'adresse, **`wallet.sendBitcoin(addr, amount)`** crée le VTXO. `ClaimableRef` = `{ tapTree, expiry, beneficiary, txid:vout }` (rejouable, encodable en `arkcontract=…`). |
| `claim(ref)` | le wallet du bénéficiaire dépense le VTXO via la feuille **`claim`** (`findLeaf`), **co-signé serveur** (spend collaboratif off-chain → `submitTx`/`finalizeTx`, comme le claim VHTLC de boltz-swap). |
| reprise plateforme | après `expiry`, feuille **`refund`** (CLTV + plateforme/serveur). |
| filet self-custody | feuille **`exit`** (CSV + bénéficiaire) → sortie L1 unilatérale même si serveur muet. |

---

## Ce qui est PROUVÉ vs ce qui demande des sats de test

| Prouvé | Comment |
|---|---|
| Le construct s'assemble depuis des closures reconnues | `escrow.ts` (offline + adresse live) |
| arkd **co-signe le spend collaboratif** de la feuille `claim` d'un VtxoScript **bespoke** | `escrow-e2e.ts` — `arkTxid` settled |
| Le **funding** réel crée un VTXO spendable | E2E : faucet→LN-in→`wallet.send` vers l'adresse escrow |
| Le **claim** réel crédite le bénéficiaire | E2E : solde **+15 000 sats** vérifié |

> **Décision :** `escrowClaimable`/`claim` câblés sur la **forme bespoke** (cleaner, pas de préimage). VHTLC
> n'est **plus nécessaire** (reste dispo dans `escrow.ts` comme cross-check). Implémenté : `ArkadeRail` dans
> `packages/payment-rail/src/arkade.ts`.

---

## Gotchas découverts

1. **x-only obligatoire & validé.** `MultisigTapscript`/`VHTLC` veulent des pubkeys **x-only 32 B**.
   `@scure/btc-signer` **valide que c'est un vrai point de courbe au decode** : une clé serveur factice
   en bytes aléatoires fait planter `Reader(): OutScript/tr_ns: wrong pubkey`. → toujours dériver d'une
   vraie clé (`SingleKey.xOnlyPublicKey()`), et normaliser `info.signerPubkey` (33 B compressé) en x-only
   via l'export **`toXOnlySignerHex`**.
2. **CSV en secondes, multiple de 512 (BIP68).** `info.unilateralExitDelay` est en **secondes** (live :
   `172544` ≈ 2 j) et déjà valide. Pour des delays custom : multiple de 512.
3. **Dust = 330 sats** sur MutinyNet (montant réclamable minimum) — à garder comme plancher d'`escrowClaimable`.
4. **CLTV** : `absoluteTimelock` accepte un **timestamp** (≥ 5e8) ou une **hauteur**. Le spike utilise un
   timestamp (+30 j) — encode sans toucher au chain tip.
5. **`RestArkProvider(url).getInfo()`** suffit pour tirer clé serveur + dust + delay **sans** créer de
   wallet (donc sans souscription WebSocket à fermer).

---

## Impact Pumpstr

- **ADR-004 (rewards = VTXO réclamable) dé-risqué** : le construct existe, est arkd-reconnu, et adressable
  live. Le payout async (curation-to-earn / challenges / chaînes de streaming) a un rail.
- **Reste (demande des sats de test)** : prouver le **claim collaboratif** bout-en-bout, puis implémenter
  `ArkadeRail.escrowClaimable()`/`claim()` dans `packages/payment-rail` (aujourd'hui le node appelle le SDK
  en direct ; ADR-007).

## Reproduire
```bash
cd spike && npm install
export ARK_SERVER_URL=https://mutinynet.arkade.sh   # PowerShell: $env:ARK_SERVER_URL=...
npm run escrow      # construct + round-trip + vraie adresse escrow live
# Node 22 LTS recommandé.
```
