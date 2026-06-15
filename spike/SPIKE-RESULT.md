# Spike A — Arkade RN + LN-in — RÉSULTAT

**Date :** 2026-06-15 · **Verdict : 🟢 FAISABLE (vert, bout en bout).**
Le risque n°1 du projet (cf. `../DECISIONS.md` ADR-001) est **retiré**.

Validé avec du code qui tourne (`smoke.ts`, `ln-in.ts`) contre l'opérateur **live MutinyNet**.

---

## Question 1 — Arkade tourne-t-il en React Native ?

**Réponse : OUI, première classe.** Preuves (pas des promesses) :

- **0 WASM, 0 binaire natif** dans tout l'arbre (`@arkade-os/sdk@0.4.35`, 31 paquets).
- Deps **100 % JS pur** : `@noble/curves`, `@noble/secp256k1`, `@scure/*`, `ws-electrumx-client`.
- **Adapters Expo/RN livrés par le SDK** : `./adapters/asyncStorage`, `./repositories/sqlite`,
  `./wallet/expo`, `./wallet/expo/background`, `./worker/expo`. **peerDep `expo >=54.0.0`**
  (= la stack 21pay-wallet).
- `SingleKey.fromHex()` (création d'identité, crypto) **tourne offline en Node** → `[1] PASS`.

### ⚠️ Le seul piège (et sa solution RN)
Le SDK **défaute sur un stockage IndexedDB** (API navigateur). En **Node** → `IndexedDB is not
available`. En **React Native**, on n'utilise PAS IndexedDB : on câble `./repositories/sqlite`
(expo-sqlite) ou `./adapters/asyncStorage`. Pour ce spike Node, on a polyfillé avec
`fake-indexeddb/auto` (cf. les imports). Le SDK exporte aussi `InMemoryWalletRepository` /
`InMemoryContractRepository` (injectables).

---

## Question 2 — Le LN-in (tip Lightning externe → fonds Arkade) marche-t-il ?

**Réponse : OUI.** Mécanisme = **reverse submarine swap Boltz** (VHTLC).

Flux validé live (`ln-in.ts`) :
```
Wallet.create  →  new BoltzSwapProvider({ network: 'mutinynet' })  →  new ArkadeSwaps({ wallet, swapProvider, swapManager:true })
              →  swaps.createLightningInvoice({ amount })  →  BOLT11 payable  →  waitAndClaim(pendingSwap)  →  VTXO crédité
```

- `BoltzSwapProvider` a résolu seul la vraie API : `https://api.boltz.mutinynet.arkade.sh`.
- **Facture réelle produite** (preuve du chemin, 50 000 sats signet) :
  `lntbs500u1p4rqfd3pp5tuhshy02ustve7rz9v4hg3d2cc7cegmv60nzjn4w4ynca8h67yd...45cp5cqqhehux`
- Payer cette facture crédite un VTXO via `waitAndClaim` / auto-claim du SwapManager.

---

## Gotchas découverts (à retenir pour l'implémentation)

1. **URLs opérateur — le blog est périmé.** `master.mutinynet.arklabs.to` est **MORT** (DNS
   introuvable). Endpoints **actuels** :
   - MutinyNet (test) : opérateur `https://mutinynet.arkade.sh` · Boltz `https://api.boltz.mutinynet.arkade.sh`
   - Mainnet : opérateur `https://arkade.computer` (v0.9.7) · Boltz `https://api.boltz.exchange`
   - Boltz `network` valides : `bitcoin` | `mutinynet` | `regtest`.
2. **Node engine** : le SDK veut `>=22.12.0 <25`. Tourne sur Node 25 mais **non supporté** → dev sur **Node 22 LTS**.
3. **Cycle de vie** : `Wallet.create` lance un `VtxoManager` avec une **souscription WebSocket** qui
   garde le process vivant. En RN c'est voulu (temps réel) ; en script Node il faut `process.exit()`
   ou gérer l'arrêt. → mappe bien sur un overlay de tips temps réel.
4. **Identité** : c'est `SingleKey.fromHex(hex)` (pas `InMemoryKey` — ça c'était l'ancien `@arklabs/wallet-sdk`).

---

## Impact Pumpstr

- **ADR-001 (Arkade) VALIDÉ.** Pas de bascule vers Spark.
- `PaymentRail.createLnInvoice()` ⟶ `ArkadeSwaps.createLightningInvoice()`. Mapping direct.
- **Reste à dériver** : `PaymentRail.escrowClaimable()` (VTXO réclamable via Arkade Script) = **spike #2**,
  non couvert ici. Le LN-in, lui, est réglé.
- **Feu vert** pour construire la tranche magique (compte → live → tip in-app + overlay).

## Reproduire
```bash
cd spike && npm install
export ARK_SERVER_URL=https://mutinynet.arkade.sh BOLTZ_NETWORK=mutinynet   # PowerShell: $env:ARK_SERVER_URL=...
npm run smoke      # wallet + adresse + solde
npm run lnin       # produit une facture LN-in payable
# Node 22 LTS recommandé.
```
