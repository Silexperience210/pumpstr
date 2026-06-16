# Pumpstr — Prochaines étapes de développement

> Fichier de travail créé le 2026-06-16. Aucun `git push` effectué.
> Ce document regroupe le récapitulatif de la session en cours et le plan des travaux à venir.

---

## 1. Récap de la session en cours — Structure + Docker + spikes

### Fait
- ✅ Workspace npm créé à la racine (`package.json` + `package-lock.json`).
- ✅ `node/package.json` lié au workspace `@pumpstr/payment-rail`.
- ✅ `node/tsconfig.json` ajouté + script `typecheck`.
- ✅ Docker corrigé pour builder depuis la racine du workspace :
  - `node/Dockerfile` adapte le contexte de build.
  - `node/docker-compose.yml` utilise `context: ..` / `dockerfile: node/Dockerfile`.
  - `.dockerignore` racine ajouté.
- ✅ URLs mortes `master.mutinynet.arklabs.to` remplacées par `mutinynet.arkade.sh` dans `spike/smoke.ts` et `spike/ln-in.ts`.
- ✅ `AGENTS.md` mis à jour avec les nouvelles commandes de lancement.
- ✅ `node/README.md` actualisé (Lightning Address désormais réelle, tableau réel/stub corrigé).
- ✅ `npm run typecheck` et `npm run test` passent (9/9).

### Non testé
- ⚠️ Build Docker non testé localement car Docker Desktop n’est pas démarré sur la machine (`docker daemon` injoignable). La configuration est cependant structuralement correcte.

### Nouvelles commandes
```bash
npm install              # workspace entier
npm run start:node       # lance le node
npm run dev:node         # dev mode
npm run typecheck        # node + payment-rail
npm run test             # payment-rail + node
npm run test:rail        # payment-rail seul
npm run test:node        # node seul
npm run smoke:spike      # spike wallet Arkade
npm run lnin:spike       # spike LN-in
```

---

## 2. ✅ Fait — `PaymentRail.exit()` + refund des rewards

### Pourquoi c’était prioritaire
- C’était le seul trou dans l’abstraction money (`ADR-007`).
- Sans `exit()`, les fonds restaient bloqués côté plateforme au-delà de l’expiry, ce qui contredisait le principe de self-custody (`ADR-004`).

### Fichiers créés / modifiés
- ✅ `packages/payment-rail/src/escrow-spend.ts` — logique pure du VtxoScript 3 feuilles + encodage du `ClaimableRef` + helpers de construction d’inputs.
- ✅ `packages/payment-rail/src/index.ts` — ajout de `PaymentRail.refund(ref: ClaimableRef)`.
- ✅ `packages/payment-rail/src/arkade.ts` :
  - `refund()` : spend la feuille `refund` (CLTV expiry passé + co-sign serveur) vers le wallet plateforme.
  - `exit()` : sortie unilatérale L1 via `VtxoManager.recoverVtxos()` (tous les VTXO recoverables du wallet).
  - `escrowClaimable()` stocke désormais aussi `refundLeaf` dans le `ClaimableRef`.
  - `claim()` utilise les helpers de `escrow-spend.ts`.
- ✅ `packages/payment-rail/test/escrow-spend.test.ts` — tests des helpers purs.
- ✅ `packages/payment-rail/test/escrow.test.ts` — imports mis à jour vers `escrow-spend.ts`.

### Décisions prises
1. **Refund** : seule la plateforme (identité courante du rail) après expiry. La vérification de clé repose sur le fait que seul le bon wallet peut signer le spend ; on n’a pas stocké la clé plateforme dans le ref.
2. **Exit** : sortie unilatérale globale du wallet Arkade (tous les VTXO recoverables), pas d’un escrow spécifique.
3. **Frais** : gérés par le SDK Arkade dans `recoverVtxos` / `buildAndSubmitOffchainTx`.

### Vérifications
- ✅ `npm run typecheck` passe (node + payment-rail).
- ✅ `npm run test` passe (12/12).

### ⚠️ À valider avec de vrais sats de test
- `exit()` appelle `VtxoManager.recoverVtxos()` ; le format exact du txid retourné doit être confirmé live.
- `refund()` n’a pas encore été exécuté contre un opérateur Arkade réel.
- Le handler de contrat utilise `claimLeaf` comme feuille de forfeit aussi pour le refund ; c’est fonctionnellement équivalent (même tapTree), mais le nommage pourrait être affiné.

### Reste à faire côté node
- ✅ Exposer `POST /api/reward/refund` (admin) côté `node/server-core.ts`.
- [ ] Mettre à jour `AGENTS.md` / `DECISIONS.md` si nouvelle ADR nécessaire.

---

## 3. ✅ Fait — Tests + sécurité API + persistance SQLite

### Livrables
- ✅ Tests automatisés du handler HTTP (`node/server-core.ts`) avec `supertest` + `node:test`.
  - `node/test/server.test.ts` : 40 tests couvrant `/api/creator`, `/.well-known/lnurlp`, `/api/lnurlp/callback`, `/api/invoice`, `/api/reward`, `/api/rewards`, `/api/reward/claimed`, `/api/reward/refund`, `/api/simulate`, `/api/stream`, 404, rate-limiting et validation.
- ✅ Validation stricte des montants (`parseSats`) et des npub/pubkey (`parsePubkey`, `requirePubkey`) sur toutes les routes publiques.
- ✅ Rate-limiting en mémoire (`RateLimiter`) sur `/api/simulate`, LNURL callback, `/api/invoice`, `/api/reward`, `/.well-known/lnurlp`.
- ✅ Route `POST /api/reward/refund` protégée par `ADMIN_TOKEN`.
- ✅ Persistance SQLite (`node/db.ts`) remplace `recentTips` en mémoire et `.rewards.json`.
- ✅ Tests de persistance `node/test/db.test.ts`.
- 🟡 Gestion fine des erreurs Boltz/Arkade : les erreurs sont propagées au client mais pas encore classifiées proprement.

### Fichiers créés / modifiés
- ✅ `node/validation.ts` — `parseSats`, `parsePubkey`, `requirePubkey`, `parseName`, `parseComment`, `parseLnAddressUser`.
- ✅ `node/rate-limit.ts` — `RateLimiter`, `rateLimitKey`.
- ✅ `node/http-helpers.ts` — `sendJson`, `readBody`, `parseJson`, `parseUrl`.
- ✅ `node/server-core.ts` — handler HTTP extrait de `server.ts`, injectable et testable.
- ✅ `node/server.ts` — simplifié : crée le rail, l'état, puis delegue au handler.
- ✅ `node/test/validation.test.ts`, `node/test/rate-limit.test.ts`, `node/test/server.test.ts`.
- ✅ `node/package.json` — ajout de `supertest`, `@types/supertest`, script `test`.
- ✅ `package.json` racine — ajout de `test:node`.

### Vérifications
- ✅ `npm run typecheck` passe (rail + node + portal).
- ✅ `npm run test` passe : 12 (rail) + 40 (node) + 8 (portal) = **60/60**.

### Décisions
- Les routes publiques restent publiques mais rate-limitées.
- Les routes admin (`/api/reward`, `/api/reward/refund`) restent protégées par `ADMIN_TOKEN`.
- Le rate-limiting est en mémoire (pas de Redis) pour rester auto-hébergeable.

---

## 4. ✅ Fait — Portail fédéré (v0)

### Livrables
- ✅ Redirection viewer corrigée dans `portal/index.html` : le lien « Regarder & tipper » pointe désormais vers le `nodeUrl` publié dans le tag `r` de l’événement NIP-53.
- ✅ Indexer backend optionnel (`portal/indexer.ts`) :
  - Souscrit aux événements NIP-53 (`kind:30311 #t=pumpstr`).
  - Cache en mémoire avec endpoints REST `/api/lives`, `/api/live`, `/health`.
  - Extrait le `nodeUrl` du tag `r`.
- ✅ `portal/tsconfig.json` ajouté et intégré à `npm run typecheck`.
- ✅ Tests portail (`portal/test/indexer.test.ts`) : 8/8 passent.

### Décisions
- Le portail reste un **lens remplaçable** au-dessus de Nostr ; l’indexer est un confort, pas un chokepoint.
- La curation / allowlist / réputation est volontairement reportée à une phase ultérieure.

---

## 5. Prochaines étapes recommandées

1. **Tests live contre Arkade mutinynet** :
   - Valider `refund()` et `exit()` avec de vrais sats de test.
   - Valider le rate-limiting et la validation sous charge réelle.
   - Un script de test live est fourni dans `spike/live-exit-refund.ts`.

2. **Build Docker** :
   - Démarrer Docker Desktop et vérifier `docker compose -f node/docker-compose.yml up --build`.

3. **Curation et réputation du portail** :
   - allowlist de pubkeys de confiance,
   - scoring social / web-of-trust,
   - modération communautaire.

4. **Gestion fine des erreurs** :
   - classifier les erreurs Arkade/Boltz (fonds insuffisants, invoice expirée, etc.).

---

## 6. Questions ouvertes globales

- **Sémantique de « la review »** : modération-avant-payout (hypothèse v0) vs curation-to-earn.
- **% du zap-split par défaut** (`PLATFORM_SPLIT_BPS`).
- **Version Node cible** : la machine actuelle tourne Node 25, mais le projet exige `>=22.12 <25`. Faut-il abaisser la contrainte ou rester strict ?

---

## 7. Récapitulatif de la session

- ✅ Workspace + Docker structurés.
- ✅ `PaymentRail` complet : `send`, `createLnInvoice`, `escrowClaimable`, `claim`, `refund`, `exit`.
- ✅ Node API durci : validation, rate-limiting, persistance SQLite, tests HTTP.
- ✅ Portail fédéré v0 : redirection corrigée, indexer backend optionnel, tests.
- ✅ Tests : **60/60** passent.
- ⚠️ Docker build non testé (daemon injoignable).
- ⚠️ Pas de `git push` effectué.

Commandes utiles :
```bash
npm install
npm run typecheck
npm run test
npm run start:node
npm run start:portal   # indexer backend optionnel
```
