# Pumpstr — Architecture (blueprint)

> Document de référence. Consolidé le 2026-06-15. Décisions verrouillées : voir `DECISIONS.md`.

## 1. Vision

pump.fun a une boucle : **le live est le catalyseur d'un actif spéculatif en temps réel**,
et la spéculation est le divertissement. Pumpstr reprend la boucle mais **sans token et sans
custody** : le catalyseur c'est la *vélocité des sats en direct* (tips, goals, leaderboards),
et la valeur va directement, en P2P, du viewer au créateur.

Trois principes non négociables :

1. **Bitcoin uniquement, sats only.** Pas de token, pas de stablecoin, pas d'AMM.
2. **Self-custody par défaut.** Le compte *est* un wallet ; personne ne tient les fonds des users.
3. **Fédéré.** Chaque node est auto-hébergeable ; l'agrégation est le réseau Nostr, pas une base centrale.

## 2. La stack

| Couche | Choix | Rôle |
|---|---|---|
| Identité / social / découverte | **Nostr** | `npub` = compte · NIP-53 `kind:30311` = live · l'agrégation = le réseau |
| Money | **Arkade** (derrière `PaymentRail`) | sats self-custody sans canaux · reward = VTXO réclamable scripté · DLC-ready (v2) |
| Lightning | LN address `user@host` auto-émise | inbound sans friction · gateway LN-in via le LND de l'Umbrel · sweep externe optionnel |
| Vidéo | Cloudflare Stream (v0) → Umbrel-origine + Bunny CDN | encoding + scan CSAM gratuits · export MP4 + clips = funnel viral |
| Hébergement | node = app Docker / Umbrel (1 clic) | wallet + LN + origine + publisher NIP-53 + panel |
| Découverte agrégée | portail = client Nostr + indexer | lentille remplaçable, jamais un chokepoint |
| Revenu | (a) zap-split par défaut + (c) infra premium | finance le réseau sans trahir la fédération |
| Modération | au niveau **vue** (curation portail) | expo légale de moteur de recherche, pas d'hébergeur du réseau |

## 3. Le modèle fédéré (le cœur)

```
  Créateur A (Umbrel)      Créateur B (Umbrel)      Communauté C (VPS)
   ┌──────────────┐         ┌──────────────┐         ┌──────────────┐
   │  node Pumpstr │         │  node Pumpstr │         │  node Pumpstr │
   │  wallet+LN    │         │  wallet+LN    │         │  wallet+LN    │
   │  origine vidéo│         │  origine vidéo│         │  origine vidéo│
   │  publisher ───┼────┐    │  publisher ───┼────┐    │  publisher ───┼───┐
   └──────────────┘    │    └──────────────┘    │    └──────────────┘   │
                       ▼                        ▼                       ▼
                 ┌───────────────────── RELAYS NOSTR ─────────────────────┐
                 │   events kind:30311 (live) · profils · zaps · chat     │
                 └───────────────────────────┬────────────────────────────┘
                                             │  (lecture seule)
                       ┌─────────────────────┴─────────────────────┐
                       │   PORTAIL  =  client Nostr + indexer       │
                       │   grille des lives · trending · leaderboard│
                       └─────────────────────┬─────────────────────┘
                                             │  au clic
                          viewer ── tip P2P ─┴──►  wallet du node  (le portail n'y touche jamais)
```

**Façon juste vs piège.** Le portail NE crawl PAS les nodes dans sa propre base (= recentralisation,
single point of failure/censure). Il **lit les events NIP-53** que les nodes publient sur les relays.
Conséquence : n'importe qui peut lancer un autre portail sur les mêmes events. Le portail est une vue.

**L'indexer.** Pour une UX correcte (trending, anti-spam, ranking), le portail fait tourner un indexer
qui cache/classe les events. C'est une couche de **confort, pas de contrôle** : les events restent
ouverts et ré-indexables. Pas un chokepoint sur la money ni sur l'existence du contenu.

## 4. Les flux

### Onboarding
1 seed (BIP39) → dérive **clé Nostr (npub)** + **wallet Arkade** + **Lightning Address** `pseudo@host`.
Zéro champ externe. La LN address est *donnée*, pas réclamée (cf. DECISIONS ADR-004).

### Live
OBS / WebRTC → **origine** (Cloudflare Stream v0, ou Owncast self-host) → CDN → viewers.
Le **publisher** émet un event NIP-53 `kind:30311` (titre, URL du stream, npub, LN address, statut).
Overlay **sats temps réel** à l'écran = le pump-feel.

### Tip
- **In-app** : viewer → node en P2P (transfert VTXO Arkade, instant, créateur online).
- **LN externe** : viewer paie la LN address depuis n'importe quel wallet → **gateway LN-in** (LND Umbrel)
  bridge le HTLC en VTXO. *(SPIKE : ergonomie à valider.)*
- Le portail ne touche jamais l'argent. Un **zap-split** optionnel (défaut activé) route X bps vers le
  npub plateforme (cf. ADR-006).

### Reward (async / créateur offline)
Les gains/récompenses s'accumulent en **VTXO réclamable** (Arkade Script : spendable par la pubkey du
bénéficiaire). Matérialisé dans le wallet au **claim** (prochain login). Sidestep la réception-offline.

### Review (modération avant payout — hypothèse v0)
Les sats gagnés restent en escrow réclamable jusqu'à ce que la revue de contenu passe (anti-CSAM/DMCA).
*À confirmer : si « review » = curation-to-earn, le flux devient « reviewers payés pour noter ».*

### Withdraw
Garder in-app (souverain) **ou** auto-sweep optionnel vers une LN address externe (profil, jamais forcé).

### Export vidéo
- **MP4 download** (API Cloudflare Stream) → ownership, anti-lock-in, échappatoire qui rend l'hébergement
  centralisé acceptable.
- **Clips** → export vers X / TikTok / Nostr avec deep-link retour = **funnel viral d'acquisition**.
- **IPFS / Arweave** (v2) → archivage souverain.

## 5. Vidéo : la seule couche qui ne tient pas sur un Umbrel à l'échelle

Limite physique = **upload résidentiel** (~3 Mbps/viewer en 720p → ~6-8 viewers sur 20 Mbps up).
Échappatoire : **Umbrel = origine, CDN = distribution en pull.** Le box n'upload qu'une copie vers le
CDN, qui fan-out vers des milliers. Reste limité par le CPU de transcoding (nb de streams *simultanés*).

- **v0** : Cloudflare Stream (managé, encoding gratuit, scan CSAM gratuit, ~0,055 €/viewer-heure).
- **Souveraineté** : Umbrel-origine (Owncast) + Bunny pull-CDN (~0,01 €/GB).
- **v2** : transcoding décentralisé (Livepeer) + stockage IPFS/Arweave.

### Ordres de grandeur (delivery 720p, hors hébergement app)
| Échelle | Cloudflare Stream | Self-managed (Bunny+Livepeer) |
|---|---|---|
| MVP (200 viewers simult., 4h/j) | ~1 650 €/mois | ~1 100 €/mois |
| Traction (5 000 simult., 6h/j) | ~55 000 €/mois | ~16 700 €/mois |
| 1 stream viral (10 000 viewers, 3h) | ~1 650 €/event | ~390 €/event |

> Règle de poche : `coût ≈ viewers simultanés moyens × heures live/jour × 30 × ~0,055 €`.
> Le danger n'est pas le pic viral (bon marché) mais le **volume concurrent soutenu**.

## 6. Revenu

P2P pur = le portail est *hors* du flux d'argent. Modèle retenu (ADR-006) : **(a) + (c)**.
- **(a) Zap-split par défaut** dans le node : X bps de chaque tip → npub plateforme. Overridable (souveraineté), activé par défaut.
- **(c) Infra premium** : portail officiel + indexer + CDN + placement featured, payants. Les nodes gratuits restent 100 % libres.

## 7. Modération & légal

- Rien ne se supprime du réseau ; **chaque portail cure sa fenêtre** (allowlist / réputation).
- Exposition légale du portail = ce qu'**il affiche** (comme un moteur de recherche), pas ce qui existe.
- Scan CSAM côté origine (gratuit sur Cloudflare). DMCA géré au node-host + portal-curation.
- Pattern « no US, no KYC » (cohérent avec le reste de l'écosystème de l'auteur).

## 8. Prior art

**zap.stream** (v0l) fait déjà la base : Nostr + NIP-53 + zaps Lightning, open source, no censorship,
fee 21 sats/min. **On copie la base, on ne la réinvente pas.** L'edge de Pumpstr = ce que zap.stream
n'a pas : node auto-hébergeable Umbrel, rail Arkade (self-custody sans canaux), pump-mechanics
(goals/leaderboards/DLC), AR/challenges, export vidéo, fédération.

## 9. Roadmap

- **v0 — la magie** : compte (seed→Nostr+Arkade+LN) + 1 live (Cloudflare) + tip in-app + overlay sats.
- **v1 — la boucle** : goals/challenges/leaderboards · review/claim · LN-in externe · export MP4+clips · zap-split.
- **v2 — la souveraineté** : node Umbrel 1-clic + portail fédéré · Umbrel-origine+CDN · DLC speculation (Arkade Script) · AR challenges (ARCore) · IPFS/Arweave.

## 10. Risques ouverts (à dérisquer)

1. Maturité **SDK Arkade en React Native** + ergonomie **LN-in**. → spike.
2. Pattern **claimable-VTXO** réellement exprimable en Arkade Script. → spike.
3. Sémantique exacte de **« review »** (modération vs curation-to-earn). → à confirmer avec le porteur.
4. Latence des **rounds Arkade** vs feel temps réel du tip (mitigée : le tip est co-signé instant, le round = refresh).
