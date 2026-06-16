# Portal — Portail fédéré Pumpstr

Le portail est une **lentille remplaçable** au-dessus de Nostr. Il agrège les lives publiés par les nodes sous le tag `pumpstr` (`kind:30311`, tag `t=pumpstr`) sans jamais devenir un chokepoint.

## Architecture

- **`portal/index.html`** — client Nostr pur. Se connecte aux relais publics, récupère les événements NIP-53 et affiche la grille des lives. Aucun backend requis.
- **`portal/indexer.ts`** — backend optionnel. Souscrit aux mêmes événements, les met en cache et expose une API REST légère (`/api/lives`, `/api/live`, `/health`).
- **Tag `r`** — chaque événement NIP-53 publie l'URL du node (`nodeUrl`) dans un tag `r`. Le lien « Regarder & tipper » redirige le viewer vers le bon node, pas vers une page locale.

## Lancer le client seul

Le fichier `index.html` est servi par le node à la route `/portal` :

```bash
npm run start:node
# puis ouvrir http://localhost:4242/portal
```

## Lancer l'indexer backend (optionnel)

```bash
npm run start:portal
# écoute sur http://localhost:4243 par défaut
```

Variables d'environnement :

| Variable | Défaut | Description |
|----------|--------|-------------|
| `PORT` | `4243` | Port HTTP de l'indexer |
| `RELAYS` | `wss://relay.damus.io,wss://relay.nostr.band` | Relais Nostr séparés par des virgules |

Endpoints :

- `GET /health` — état du service et nombre d'événements en cache.
- `GET /api/lives?status=live` — liste des lives (optionnellement filtrés par statut).
- `GET /api/live?id=<event-id>` — détail d'un live.

## Tests

```bash
npm run test:portal
```

## Fédération

N'importe qui peut héberger son propre portail en pointant sur les mêmes relais. L'indexer officiel n'est qu'une commodité ; le client Nostr reste la source de vérité.
