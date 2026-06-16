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
| `ArkadeRail` ([`src/arkade.ts`](./src/arkade.ts)) | ✅ écrite | défaut · `escrowClaimable`/`claim` (spike #2) + `send`/`getBalance`/`createLnInvoice` · typecheck + `npm run verify` live |
| `SparkRail` | repli documenté | seulement si le spike Arkade échoue (ADR-001) |

`src/index.ts` reste **sans dépendance** (interface pure) ; l'implémentation vit dans `@pumpstr/payment-rail/arkade`.
Le host polyfille avant `Wallet.create` — Node : `fake-indexeddb/auto` + global `EventSource` (paquet `eventsource`).

```bash
npm install && npm run typecheck      # typecheck contre les vrais types SDK
ARK_SERVER_URL=https://mutinynet.arkade.sh npm run verify   # vérif live sans sats (escrow dérivé, garde-fous)
```

## Les 2 spikes portés par cette interface

1. **`createLnInvoice`** — bridge LN-in (HTLC → VTXO) via la gateway (LND Umbrel).
2. **`escrowClaimable` / `claim`** — VTXO réclamable scripté (reward async/offline).
