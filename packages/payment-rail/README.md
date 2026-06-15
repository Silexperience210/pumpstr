# @pumpstr/payment-rail

L'abstraction money qui garde Pumpstr agnostique du rail. **Implémentation par défaut : Arkade.**

- Contrat : [`src/index.ts`](./src/index.ts)
- Décisions : `../../DECISIONS.md` → ADR-001 (Arkade), ADR-007 (abstraction)

## Règle d'or

Aucun appel SDK de rail (Arkade, Spark, LND…) **en dehors** d'une implémentation de `PaymentRail`.
Le produit ne connaît que cette interface. Changer de rail = écrire une nouvelle implémentation,
zéro touche au produit.

## Implémentations

| Impl | Statut | Note |
|---|---|---|
| `ArkadeRail` | à écrire (spike) | défaut · DLC-ready · SPIKE : RN SDK + LN-in |
| `SparkRail` | repli documenté | seulement si le spike Arkade échoue (ADR-001) |

## Les 2 spikes portés par cette interface

1. **`createLnInvoice`** — bridge LN-in (HTLC → VTXO) via la gateway (LND Umbrel).
2. **`escrowClaimable` / `claim`** — VTXO réclamable scripté (reward async/offline).
