# Pumpstr — la tranche magique

Le moment qui fait le produit : **un viewer envoie des sats, le compteur explose à l'écran, en direct.**
Branché sur un **vrai wallet créateur Arkade** (rail validé au spike A).

```
viewer (tip.html) ──tip──▶ wallet Arkade créateur ──poll/diff──▶ WebSocket ──▶ overlay.html (OBS)
                   └─ ⚡ facture LN-in réelle (Boltz)            └─ ▶ "simulate" (démo sans sats)
```

## Lancer

```bash
npm install
npm start            # Node 22 LTS recommandé ; réseau réel requis (opérateur Arkade)
```

Puis ouvre :
- **Watch** (l'expérience viewer : vidéo + tips superposés + tip Nostr) : http://localhost:4242/watch.html
- **Portail fédéré** (la grille des lives, agrégée via Nostr) : http://localhost:4242/portal
- **Overlay** (source navigateur OBS, par-dessus ton live) : http://localhost:4242/overlay.html
- **Page tip** (surface tip standalone) : http://localhost:4242/tip.html

## Voir la magie en 5 secondes

1. Ouvre l'overlay dans un onglet, la page tip dans un autre.
2. Sur la page tip : choisis un montant → **▶ Simuler (démo)**.
3. L'overlay explose : compteur qui grimpe, montant qui monte, pluie de ⚡, hype-bar.

Pour un **vrai** tip Lightning : **⚡ Payer en Lightning** → scanne/colle la facture dans un wallet
LN de test MutinyNet. Au paiement, le SwapManager Boltz auto-claim → le solde monte → l'overlay réagit
exactement pareil.

## Ce qui est réel vs stub

| Réel | Stub / à venir |
|---|---|
| Identité Nostr tippeur (zap NIP-57) + live NIP-53 + zap receipts 9735 + npub créateur + portail fédéré + **page watch (vidéo HLS + tips superposés)** + provision Cloudflare (creds-gated) | **Packaging node Docker/Umbrel** (1-clic) ; vidéo réelle = brancher tes creds CF (sinon flux démo Mux) |
| Facture LN-in via Boltz (`createLightningInvoice`) | Pas encore de Lightning Address `user@host` (LUD-16) — facture à la demande |
| Overlay + page tip temps réel (WebSocket) | Identité Nostr / NIP-53 live (couche suivante) |
| `simulate` pour démo instantanée | Vidéo (Cloudflare Stream / origine) — l'overlay se pose dessus dans OBS |

## Déployer le node (Docker / Umbrel)

```bash
docker compose up -d   # Node 22 figé, clé persistée sur le volume pumpstr-data
```

Le node publie son live sur Nostr (NIP-53) et sert overlay/tip/watch. La clé `/data/.creator-key` =
**npub + wallet du node** : le volume la persiste — **ne le perds pas** (sinon perte du wallet + identité).
Sur Umbrel : packager via `../node/umbrel-app.yml`. Le portail fédéré se déploie séparément (c'est une
lentille Nostr, pas une dépendance du node).

## Config (env)

| Var | Défaut | Note |
|---|---|---|
| `PORT` | `4242` | |
| `ARK_SERVER_URL` | `https://mutinynet.arkade.sh` | opérateur (mainnet : `https://arkade.computer`) |
| `BOLTZ_NETWORK` | `mutinynet` | `bitcoin` \| `mutinynet` \| `regtest` |
| `NOSTR_RELAYS` | damus, nos.lol, primal | relais (profil tippeur + publication NIP-53/9735) |
| `STREAM_TITLE` / `STREAM_SUMMARY` | défauts | métadonnées du live NIP-53 (`kind:30311`) |
| `STREAM_URL` / `STREAM_IMAGE` | vide | URL HLS + miniature ; vide → `/watch` utilise un flux démo |
| `CLOUDFLARE_STREAM_ACCOUNT_ID` | — | active le provisionnement d'un live input Cloudflare |
| `CLOUDFLARE_STREAM_API_TOKEN` | — | token API Cloudflare Stream |
| `CLOUDFLARE_STREAM_CUSTOMER_CODE` | — | sous-domaine `customer-<CODE>` pour l'URL HLS de lecture |

La clé privée du wallet créateur est générée au 1er boot dans `.creator-key` (gitignoré).
En RN, le stockage passera par `./adapters/asyncStorage` (ici : polyfill `fake-indexeddb` pour Node).
