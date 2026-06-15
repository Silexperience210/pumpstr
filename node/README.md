# Pumpstr — node

L'instance auto-hébergeable. Tout ce qui porte **valeur + identité** tourne ici (souverain) ;
seule la vidéo lourde sort vers un CDN (cf. `../ARCHITECTURE.md` §5, ADR-005).

## Services (`docker-compose.yml`)

| Service | Image | Rôle |
|---|---|---|
| `db` | postgres:16 | état applicatif |
| `relay` | strfry | relay Nostr local (souveraineté sociale) |
| `video` | owncast | origine vidéo (ingest OBS + HLS) — le CDN se met en **pull devant** |
| `api` | `./api` (custom) | wallet Arkade, LNURL/Lightning Address, publisher NIP-53, reward/claimable, API panel |

## Démarrer

```bash
cp .env.example .env     # règle DB_PASSWORD, ARKADE_OPERATOR_URL, LN gateway, split…
docker compose up -d
```

Sur **Umbrel** : déployable en 1 clic via `umbrel-app.yml` (community app store). Dépend de l'app
`lightning` (le LND sert de **gateway LN-in** pour les tips Lightning externes).

## Ce que fait `api/` (à implémenter)

1. **Onboarding** : 1 seed → npub Nostr + wallet Arkade + Lightning Address `pseudo@domain`.
2. **Wallet** : solde, send P2P (tip in-app), via `@pumpstr/payment-rail` (jamais d'appel Arkade en dur).
3. **LN-in** : sert `/.well-known/lnurlp/<user>` ; bridge le HTLC entrant en VTXO (SPIKE #1).
4. **Publisher NIP-53** : émet `kind:30311` au passage en live (URL stream, npub, LN address, statut).
5. **Reward/claimable** : escrow VTXO réclamable → claim (SPIKE #2).
6. **Zap-split** : applique `PLATFORM_SPLIT_BPS` (ADR-006), désactivable.
7. **Panel** : UI locale de contrôle (mes streams, mes sats, withdraw/sweep).

## ⚠️ Limite physique

Ne sers **jamais** les viewers directement depuis l'upload résidentiel (~6-8 viewers max sur 20 Mbps).
À l'échelle : `VIDEO_MODE=origin-cdn` → Bunny/Cloudflare tire depuis l'origine Owncast. Le box n'upload
qu'**une** copie. Reste limité par le CPU de transcoding = nombre de streams *simultanés*.
