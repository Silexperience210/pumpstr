# Pumpstr — portal

Le « site » qui agrège tous les lives. **Un client Nostr + un indexer. Jamais un chokepoint.**

## Principe (ADR-003)

Le portail **ne tient pas de registre des nodes**. Il s'abonne aux events NIP-53 `kind:30311`
sur les relays et rend la vue : grille des lives, trending, leaderboard (le pump-feel).
N'importe qui peut lancer un autre portail sur les mêmes events → le portail est une **lentille
remplaçable**.

## Responsabilités

1. **Indexer** : cache + classe les `kind:30311` (trending, anti-spam, ranking). Confort UX, pas
   contrôle — events ré-indexables par tous.
2. **Player** : au clic, joue le stream depuis l'URL publiée par le node.
3. **Tip** : route le tip **viewer → wallet du node en P2P** (in-app VTXO ou LN address). Le portail
   ne touche **jamais** l'argent. Applique le zap-split optionnel (ADR-006).
4. **Curation / modération** (ADR-007 légal) : choisit ce qu'**il** affiche (allowlist/réputation).
   Son exposition = ce qu'il surface, comme un moteur de recherche.

## À ne PAS faire

- ❌ Crawler les nodes dans une base centrale (= recentralisation).
- ❌ Custodier ou router les fonds.
- ❌ Prétendre être la seule porte d'entrée.

## Prior art

S'inspirer de **zap.stream** (v0l) — même socle Nostr/NIP-53/zaps. L'edge de Pumpstr est ailleurs
(node souverain, Arkade, pump-mechanics, export). Cf. `../ARCHITECTURE.md` §8.
