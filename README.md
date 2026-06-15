# Pumpstr

**Le streaming façon pump.fun, mais sur Bitcoin uniquement, self-custodial et fédéré.**

Chaque créateur reçoit des sats en direct (tips, goals, challenges), depuis un compte
qui *est* un wallet self-custodial — sans gestion de canal Lightning. Le tout est
auto-hébergeable : un **node** se déploie en 1 clic sur un Umbrel, et un **portail**
agrège tous les lives via Nostr. Pas de token, pas d'AMM, pas de custody.

> Statut : **conception verrouillée, scaffold en cours.** Voir [`ARCHITECTURE.md`](./ARCHITECTURE.md)
> pour le blueprint complet et [`DECISIONS.md`](./DECISIONS.md) pour le *pourquoi* de chaque choix.

## La stack en une ligne

`Nostr` (identité + live NIP-53 + découverte) · `Arkade` (sats self-custody + rewards réclamables + DLC-ready) · `Cloudflare Stream` → `Umbrel-origine + CDN` (vidéo + export) · le tout derrière une interface `PaymentRail`.

## Les deux briques

| Brique | C'est quoi | Où ça tourne |
|---|---|---|
| **`node/`** | L'instance auto-hébergeable : wallet Arkade, Lightning Address, origine vidéo, publisher NIP-53, panel de contrôle | App Docker / Umbrel (1 clic) |
| **`portal/`** | Le « site » qui agrège tous les lives : client Nostr + indexer. **Lentille remplaçable, jamais un chokepoint.** | Cloud / Umbrel / n'importe où |
| **`packages/payment-rail/`** | L'abstraction money — garde Pumpstr agnostique du rail (défaut : Arkade) | Lib partagée |

## Le premier build (le moment magique)

> Compte (1 seed → Nostr + Arkade + LN address) → 1 live → **tip in-app + overlay sats temps réel.**

Si ce moment claque, le produit existe. Tout le reste (challenges, review, export, claim) se greffe dessus.

## Les 2 spikes à dérisquer avant d'aller à fond

1. **Arkade RN SDK + LN-in** — accepter un tip depuis un wallet Lightning externe.
2. **Pattern claimable-VTXO** — reward async/offline via Arkade Script.

## Démarrer le node (cible)

```bash
cd node
cp .env.example .env   # règle ton split, ton relay, ton endpoint Arkade, ton CDN
docker compose up -d
```

---
**Licence : [AGPL-3.0-only](./LICENSE)** — copyleft réseau : tout node/portail (même modifié, même opéré en service) doit publier sa source → la fédération reste ouverte, anti-custodian par construction.

Conçu le 2026-06-15. Sats only. No KYC. No custody.
