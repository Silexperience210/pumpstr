# AGENTS.md — Pumpstr

> **Contexte de reprise pour tout agent IA.** Lis ce fichier en entier avant d'agir.
> Il est **auto-suffisant** : il ne dépend d'aucune mémoire externe. Les détails sont dans
> `ARCHITECTURE.md` (le blueprint) et `DECISIONS.md` (le *pourquoi*, format ADR).

## En une phrase
Pumpstr = streaming vidéo « façon pump.fun » mais **sur Bitcoin uniquement, sats-only,
self-custodial et fédéré**. Le pump-feel vient de la **vélocité des sats en direct**
(tips, goals, leaderboards), pas d'un token. Conçu le 2026-06-15.

## Statut (2026-06-15)
- ✅ Architecture **verrouillée** (`ARCHITECTURE.md`, `DECISIONS.md`).
- ✅ **Spike A — rail Arkade (React Native + LN-in) = VERT**, validé avec du code qui tourne
  contre l'opérateur live. Détails + preuves : `spike/SPIKE-RESULT.md`.
- ✅ **Tranche magique** construite et runnable : `magic/` — vrai wallet créateur Arkade +
  overlay de tips sats temps réel (WebSocket).
- ⏳ **Spike #2 OUVERT** : `escrowClaimable()` = VTXO réclamable via Arkade Script (rewards async).
- ⏳ Scaffold seulement : Nostr (NIP-53), vidéo (Cloudflare/origine), node Docker, portail fédéré.

## Principes non négociables
1. Bitcoin uniquement, **sats only** — pas de token, pas d'AMM, pas de stablecoin.
2. **Self-custody par défaut** — le compte EST un wallet ; on ne tient jamais les fonds des users.
3. **Fédéré** — node auto-hébergeable ; l'agrégation est le réseau Nostr (NIP-53), pas une base centrale.

## Décisions verrouillées (rationale complet dans DECISIONS.md)
| ADR | Décision |
|---|---|
| 001 | **Rail = Arkade** (pas Spark : Spark ne fait aucun smart contract → cul-de-sac pour le DLC) |
| 002 | **Sats-only, pas de token/AMM** (être market maker = custodial ou lent → tue la thèse). Spéculation v2 = DLC |
| 003 | **Fédération via Nostr** ; le portail = client Nostr + indexer = lentille remplaçable, **jamais** un crawler central |
| 004 | **Compte = wallet** ; Lightning Address auto-émise (jamais forcée) ; rewards = VTXO réclamable |
| 005 | **Vidéo** : Cloudflare Stream v0 → Umbrel-origine + CDN ; export MP4/clips = funnel viral |
| 006 | **Revenu** : (a) zap-split par défaut + (c) infra premium |
| 007 | **Abstraction `PaymentRail`** : aucun appel SDK de rail en dur en dehors d'une implémentation |

## Carte du repo
```
Pumpstr/
├── AGENTS.md            ← CE FICHIER (point d'entrée agent)
├── ARCHITECTURE.md      ← blueprint complet (stack, flux, schéma fédéré, coûts)
├── DECISIONS.md         ← les 7 ADR (le pourquoi)
├── README.md            ← pitch + quickstart
├── packages/payment-rail/  ← interface PaymentRail VERROUILLÉE (défaut : Arkade)
├── node/                ← scaffold de l'instance auto-hébergeable (Docker/Umbrel) — pas encore implémenté
├── portal/              ← le « site » = client Nostr + indexer (spec dans le README)
├── spike/               ← Spike A : preuve Arkade RN + LN-in (smoke.ts, ln-in.ts, SPIKE-RESULT.md)
└── magic/               ← LA TRANCHE MAGIQUE, runnable : server.ts + public/overlay.html + public/tip.html
```

## ⚠️ Faits vérifiés & pièges (issus du spike — NON dérivables, critiques)
- **Packages réels** :
  - `@arkade-os/sdk` — identité `SingleKey.fromHex(hex)` (PAS `InMemoryKey`, ça c'était l'ancien SDK) ;
    `await Wallet.create({ identity, arkServerUrl })` ; `wallet.getAddress()` → `tark1…` ;
    `wallet.getBalance()` → `{ total, available, settled, boarding, recoverable, assets }` (sats).
  - `@arkade-os/boltz-swap` — `new BoltzSwapProvider({ network })` ;
    `new ArkadeSwaps({ wallet, swapProvider, swapManager: true })` ;
    `swaps.createLightningInvoice({ amount })` → BOLT11 ; `swaps.waitAndClaim(pendingSwap)` → VTXO.
- **Endpoints actuels** (⚠️ le blog `master.mutinynet.arklabs.to` est **MORT**) :
  - Opérateur : test `https://mutinynet.arkade.sh` · mainnet `https://arkade.computer` (v0.9.7).
  - Boltz : test `https://api.boltz.mutinynet.arkade.sh` · mainnet `https://api.boltz.exchange`.
  - `BOLTZ_NETWORK` ∈ `{ bitcoin, mutinynet, regtest }`.
- **React Native** : SDK 100 % JS (noble/scure), **0 WASM / 0 binaire natif**, adapters Expo fournis
  (`@arkade-os/sdk/adapters/asyncStorage`, `/repositories/sqlite`), peerDep **`expo>=54`**.
  En **Node**, le SDK attend deux globals navigateur → polyfiller : **IndexedDB** (`fake-indexeddb/auto`,
  pour le stockage) **et `EventSource`** (paquet `eventsource`, pour la subscription temps réel SSE du
  watcher de contrats — sinon spam `ReferenceError: EventSource is not defined`). En RN : `./adapters/asyncStorage` + `react-native-sse`.
- **Node 22 LTS** requis (engine `>=22.12 <25`). `Wallet.create` ouvre une **souscription WebSocket**
  qui garde le process vivant (→ `process.exit()` dans un script ; comportement voulu dans un serveur).

## Comment lancer
```bash
# La tranche magique (le moment qui vend le produit)
cd magic && npm install && npm start
#   overlay (source OBS) : http://localhost:4242/overlay.html
#   page tip (viewer)    : http://localhost:4242/tip.html
#   démo instantanée     : bouton "▶ Simuler" sur la page tip

# Re-valider le rail (spike A)
cd spike && npm install
ARK_SERVER_URL=https://mutinynet.arkade.sh npm run smoke   # wallet + adresse + solde
ARK_SERVER_URL=https://mutinynet.arkade.sh BOLTZ_NETWORK=mutinynet npm run lnin  # facture LN-in
```
> Node 22 LTS. Réseau réel requis (opérateur Arkade). Secrets jamais commités (`.creator-key`, `.env` gitignorés).

## Prochaines étapes (ordre suggéré)
1. **Spike #2** : `PaymentRail.escrowClaimable()` — VTXO réclamable via Arkade Script (rewards async/offline).
2. Détection des tips : remplacer le poll du solde (`magic/server.ts`) par la **subscription VTXO temps réel** du SDK.
3. **Lightning Address (LUD-16)** `pseudo@host` adossée au wallet (`.well-known/lnurlp/...`).
4. **Identité Nostr** : 1 seed → npub + wallet Arkade ; publisher **NIP-53** (`kind:30311`) au passage live.
5. **Vidéo** sous l'overlay (Cloudflare Stream) ; puis **node Docker** + **portail fédéré** (client Nostr + indexer).

## Questions ouvertes (à trancher avec le porteur)
- Sémantique de « **la review** » : modération-avant-payout (hypothèse retenue) vs curation-to-earn.
- **% du zap-split** par défaut (`PLATFORM_SPLIT_BPS`).

## Style & conventions
TypeScript + ESM. Montants en **`bigint` (sats)**. Tout passage money via **`PaymentRail`** (jamais
d'appel SDK rail en dur ailleurs). Commentaires/UX en français (langue du porteur). Pas de secret en clair.
Prior art à copier (pas réinventer) : **zap.stream** (Nostr + NIP-53 + zaps).
