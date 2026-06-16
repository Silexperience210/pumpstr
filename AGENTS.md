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
- ✅ **Node** construit et runnable : `node/` — vrai wallet créateur Arkade +
  overlay de tips sats temps réel (WebSocket).
- 🟢 **Spike #2 — PROUVÉ BOUT-EN-BOUT (vrais sats)** : `escrowClaimable→claim` = VTXO réclamable scripté
  (VtxoScript 3 feuilles claim/refund/exit) validé **E2E live mutinynet** (bénéficiaire +15 000 sats, `arkTxid`
  settled). arkd co-signe le bespoke. Preuves : `spike/SPIKE-2-RESULT.md` + `packages/payment-rail/escrow-e2e.ts`.
- ✅ **MVP fédéré complet** dans `node/` : identité Nostr (tippeur + créateur), NIP-53 publisher + zap
  receipts (9735), portail fédéré, page watch (vidéo HLS), node **dockerisé** (Node 22, clé sur volume).

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
├── node/                ← LE NODE runnable (Docker/Umbrel) : server.ts + public/{overlay,tip,watch}.html (sert /portal)
├── portal/              ← portail fédéré : index.html = client Nostr (kind:30311 #t=pumpstr), servi à /portal
└── spike/               ← Spike A : Arkade RN + LN-in (smoke.ts, ln-in.ts, SPIKE-RESULT.md)
                            Spike #2 : VTXO réclamable (escrow.ts, SPIKE-2-RESULT.md)
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
- **Temps réel** : `await wallet.notifyIncomingFunds(cb)` → retourne un `unsub()`. `cb` reçoit
  `{type:'vtxo', newVtxos, spentVtxos}` (off-chain) ou `{type:'utxo', coins}` (on-chain) ; chaque coin a
  `.value` (sats). Compter le **net = Σnew − Σspent** pour ignorer renouvellements/change. ⚠️ démarre aussi un
  **watcher on-chain** (Electrum WS + Esplora) qui, sur mutinynet, boucle en reconnexion **ET peut throw**
  (fetch/TLS, p.ex. `CERT_NOT_YET_VALID`) → **plante le process sans garde**. Off-chain non affecté ;
  `node/server.ts` filtre le bruit + ajoute un guard `uncaughtException`/`unhandledRejection`. API trouvée par
  **introspection runtime** (types bundlés en chunks).

## Comment lancer
```bash
# Le node (lancer le backend)
cd node && npm install && npm start
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
1. 🟢 **Spike #2 fait + RAIL IMPLÉMENTÉ** — VTXO réclamable scripté (`spike/escrow.ts`, `spike/SPIKE-2-RESULT.md`)
   **ET** `ArkadeRail` écrit dans `packages/payment-rail/src/arkade.ts` (ADR-007) : `escrowClaimable` (construit
   l'escrow 3 feuilles → `wallet.send` funding → `ClaimableRef` portable) + `claim` (indexer `getVtxos` →
   `wallet.buildAndSubmitOffchainTx` sur la feuille claim, co-sign serveur) + `previewEscrow` + `send`/`getBalance`/
   `createLnInvoice`. **Typecheck OK** vs SDK 0.4.36, **`npm run verify` vert** live (escrow dérivé, garde-fous).
   ✅ **(b) node branché sur `ArkadeRail`** : `node/server.ts` n'importe plus le SDK ; tout le money passe par le
   rail. Identité `.creator-key` préservée. ADR-007 bouclé côté produit.
   ✅ **(a) CLAIM E2E PROUVÉ (vrais sats)** : `escrowClaimable→claim` validé live mutinynet (`packages/payment-rail/
   escrow-e2e.ts`), bénéficiaire +15 000 sats, `arkTxid` settled. **Open Q tranchée : arkd co-signe un VtxoScript
   bespoke.** Fix clé dans `claim()` : enregistrer l'escrow comme contrat (`wallet.contractRepository.saveContract`,
   type custom → signer identité) + un `contractHandlers.register` minimal (sinon la sync de solde crashe).
   ✅ **Flux reward produit câblé (node)** : `POST /api/reward {to:npub, amount, reason}` → `rail.escrowClaimable`
   → persiste `.rewards.json` + **note Nostr** (kind:1 taguant le bénéficiaire) + renvoie ref+claimUrl ;
   `GET /api/rewards?to=npub` liste les refs ; `/claim.html` les affiche (claim = côté wallet bénéficiaire). Gate
   `ADMIN_TOKEN`, split `PLATFORM_SPLIT_BPS`. Reste : **(c)** `exit()` via Unroll (stub) ; claim in-browser dans `claim.html`.
2. ✅ **Fait** — détection des tips **temps réel** (`wallet.notifyIncomingFunds`, filtre net) **+ identité Nostr
   du tippeur** : il signe une **zap request NIP-57 (kind 9734)**, le backend la **vérifie** (`verifyEvent`) et
   résout son profil (kind 0 : nom + avatar). Corrélation identité↔paiement LN via `waitAndClaim` (dédup par txid).
3. ✅ **Fait** — Lightning Address **LUD-16** `pay@host` (`.well-known/lnurlp/<user>` + callback Boltz LN-in)
   avec **zaps NIP-57** (LUD-21 `allowsNostr`/`nostrPubkey`, reçu 9735). Payable depuis tout wallet LN /
   client Nostr. Prod : `LN_ADDRESS_BASE_URL=https://domaine` (via CF Tunnel). Limite : Boltz ne pose pas de
   `description_hash` strict → vérif NIP-57 stricte best-effort.
4. ✅ **Fait** — créateur 1 clé → npub + wallet ; **publisher NIP-53** (`kind:30311`, signé clé créateur,
   publié + **round-trip relais vérifié**) ; **zap receipts NIP-57 (9735)** publiés sur paiement LN réglé.
5. ✅ **Portail fédéré** (`portal/index.html`, client Nostr `kind:30311 #t=pumpstr`, servi à `/portal`)
   **+ vidéo** : page `/watch.html` (HLS via hls.js + tips superposés + flow de tip Nostr ; flux démo Mux si
   non configuré) ; provisionnement **Cloudflare Stream** creds-gated (live input → ingest RTMPS + URL HLS →
   tag `streaming` NIP-53 ; `CLOUDFLARE_STREAM_ACCOUNT_ID`/`_API_TOKEN`/`_CUSTOMER_CODE`).
   ✅ **Node dockerisé** : `node/Dockerfile` + `node/docker-compose.yml` (Node 22, clé persistée sur volume
   `/data`) → `cd node && docker compose up -d`. **MVP fédéré complet.** Prochains : relay Nostr local embarqué
   dans le node, décomposition multi-services (`node/`), **spike #2** (claimable-VTXO), durcissement + tests.

## Questions ouvertes (à trancher avec le porteur)
- Sémantique de « **la review** » : modération-avant-payout (hypothèse retenue) vs curation-to-earn.
- **% du zap-split** par défaut (`PLATFORM_SPLIT_BPS`).

## Style & conventions
TypeScript + ESM. Montants en **`bigint` (sats)**. Tout passage money via **`PaymentRail`** (jamais
d'appel SDK rail en dur ailleurs). Commentaires/UX en français (langue du porteur). Pas de secret en clair.
Prior art à copier (pas réinventer) : **zap.stream** (Nostr + NIP-53 + zaps).
