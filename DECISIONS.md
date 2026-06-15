# Pumpstr — Décisions (ADR log)

Décisions verrouillées le 2026-06-15. Chacune est *vetoable* mais a un coût de revirement.

---

## ADR-001 — Rail = Arkade (pas Spark)

**Décision.** Le rail sats est **Arkade**, derrière l'abstraction `PaymentRail`.

**Pourquoi.**
- Le futur modulable de Pumpstr inclut la **spéculation DLC** (la seule façon propre d'avoir un
  pump-feel sans redevenir custodial). **Arkade fait le DLC nativement** (Arkade Script) ;
  **Spark ne fait aucun smart contract** → cul-de-sac permanent + migration de rail forcée.
- **Sats-only par conviction** → la killer-feature de Spark (tokens/stablecoins LRC-20) est inutile,
  voire off-brand.
- Le use-case **tip en live neutralise** la faiblesse d'Arkade : un créateur qui reçoit un tip est en
  train de streamer = online, exactement quand le modèle de réception/confiance d'Ark est le plus fort.
- Modèle de confiance (exit pré-signé) + backing Tether collent mieux à la thèse souveraine que le
  statechain de Spark (confiance dans la suppression des vieilles clés par les opérateurs).

**Le point « reward async » qui penchait Spark se dissout** : Arkade Script exprime un VTXO réclamable.

**Coût accepté.** SDK RN + LN-in à valider (spike). Repli documenté : Spark, si le spike montre
qu'Arkade RN/LN-in est trop rugueux — l'abstraction `PaymentRail` rend le switch contenu.

---

## ADR-002 — Sats-only, pas de token ni d'AMM

**Décision.** Aucun token créateur, aucune bonding curve, aucun market maker. Le « pump » vient de la
**vélocité des sats en direct** (tips, goals, leaderboards). La spéculation viendra (v2) via **DLC**.

**Pourquoi.** Émettre un token est facile ; **être le market maker ne l'est pas** — Bitcoin n'offre pas
de liquidité native. Les deux issues sont mauvaises : soit P2P lent (pas de feel pump), soit on
centralise la courbe et on custodie tout (= casino custodial qui **tue la thèse self-custody** +
risque d'inventaire + exposition valeurs mobilières/jeu). Le DLC donne le frisson **sans maker**.

---

## ADR-003 — Fédération via Nostr (portail = vue, pas crawler)

**Décision.** Les nodes publient des events NIP-53 `kind:30311`. Le portail est un **client Nostr +
indexer** qui lit ces events. Il ne tient **pas** de registre central des nodes.

**Pourquoi.** Un site qui crawl/stocke les nodes recentralise la découverte (single point of
failure/censure). En lisant Nostr, l'agrégation devient le réseau ; le portail est une lentille
remplaçable. L'indexer est une couche de confort (UX), pas de contrôle — events ré-indexables par tous.

---

## ADR-004 — Le compte EST le wallet ; LN address donnée, pas réclamée

**Décision.**
- 1 seed → npub + wallet Arkade + **Lightning Address auto-émise** (`pseudo@host`), adossée au wallet.
- **Ne jamais forcer** une LN address externe à l'inscription.
- LN address sortante = **optionnelle** dans le profil (auto-sweep pour ceux qui veulent sortir).
- Rewards async = **VTXO réclamable**, matérialisé au claim.

**Pourquoi.** Forcer une LN address externe = friction au pire moment + renvoie les fonds chez un
custodian tiers (anti-thèse) + fait de la plateforme un payeur sortant (surface AML). Le wallet in-app
est la destination par construction : pas de « où j'envoie ».

---

## ADR-005 — Vidéo : Cloudflare Stream (v0) → Umbrel-origine + CDN ; export = funnel

**Décision.** v0 sur Cloudflare Stream (managé). Migration vers Umbrel-origine + Bunny pull-CDN quand
la souveraineté prime. Export MP4 + clips traités comme **canal d'acquisition viral**, pas archivage.

**Pourquoi.** La vidéo est la seule couche qui ne tient pas sur Umbrel à l'échelle (upload résidentiel).
Le CDN en pull résout le fan-out (le box n'upload qu'une copie). L'export rend le départ centralisé
acceptable (anti-lock-in) et les clips ramènent des viewers + des tips.

---

## ADR-006 — Revenu = (a) zap-split par défaut + (c) infra premium

**Décision.** Pas de modèle (b) seul (fee/minute). On combine **(a)** un zap-split activé par défaut
dans le node (overridable) et **(c)** une infra premium payante (portail officiel, indexer, CDN, featured).

**Pourquoi.** En P2P pur, la plateforme est hors du flux d'argent. (a) finance le réseau de façon
compatible souveraineté (désactivable), (c) finance la qualité. Les puristes restent 100 % libres.

---

## ADR-007 — Abstraction `PaymentRail`

**Décision.** Tout le code money passe par l'interface `packages/payment-rail`. Implémentation par
défaut : Arkade. Aucun appel SDK rail en dur ailleurs.

**Pourquoi.** « Modulable pour ajouter d'autres choses ensuite. » Rend le rail swappable (repli Spark,
ou multi-rail) sans réécrire le produit.

---

## En suspens (non verrouillé)

- **Sémantique de « review »** : modération-avant-payout (hypothèse retenue) vs curation-to-earn. À confirmer.
- **% exact du zap-split** par défaut (ex. 100–200 bps ?).
- **Cible du premier spike** : Arkade RN + LN-in.
