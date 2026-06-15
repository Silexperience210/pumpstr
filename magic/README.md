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
- **Overlay** (à mettre en *source navigateur* dans OBS, par-dessus ton live) : http://localhost:4242/overlay.html
- **Page tip** (la surface viewer) : http://localhost:4242/tip.html

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
| Wallet créateur Arkade (adresse `tark1…`, solde live) | Détection tip = poll du solde toutes les 4 s (→ subscription VTXO temps réel ensuite) |
| Facture LN-in via Boltz (`createLightningInvoice`) | Pas encore de Lightning Address `user@host` (LUD-16) — facture à la demande |
| Overlay + page tip temps réel (WebSocket) | Identité Nostr / NIP-53 live (couche suivante) |
| `simulate` pour démo instantanée | Vidéo (Cloudflare Stream / origine) — l'overlay se pose dessus dans OBS |

## Config (env)

| Var | Défaut | Note |
|---|---|---|
| `PORT` | `4242` | |
| `ARK_SERVER_URL` | `https://mutinynet.arkade.sh` | opérateur (mainnet : `https://arkade.computer`) |
| `BOLTZ_NETWORK` | `mutinynet` | `bitcoin` \| `mutinynet` \| `regtest` |

La clé privée du wallet créateur est générée au 1er boot dans `.creator-key` (gitignoré).
En RN, le stockage passera par `./adapters/asyncStorage` (ici : polyfill `fake-indexeddb` pour Node).
