# Déploiement Pumpstr

## Option 1 — VPS Cloud (recommandé)

### Prérequis
- Ubuntu 22.04+ ou Debian 12+
- Docker + Docker Compose
- 1 CPU, 1 GB RAM, 10 GB SSD (minimum)
- Port 4242 ouvert (TCP)

### One-liner
```bash
curl -fsSL https://raw.githubusercontent.com/Silexperience210/pumpstr/main/deploy.sh | bash
```

### Manuel
```bash
git clone https://github.com/Silexperience210/pumpstr.git
cd pumpstr
cp .env.example .env
# Édite .env (change ADMIN_TOKEN et LN_ADDRESS_BASE_URL)
docker compose -f docker-compose.prod.yml up -d
```

### Avec HTTPS (Caddy)
```bash
export DOMAIN=live.tondomaine.com
export EMAIL=ton@email.com
curl -fsSL https://raw.githubusercontent.com/Silexperience210/pumpstr/main/deploy.sh | bash
```

## Option 2 — Umbrel (auto-hébergé)

```bash
# Sur ton Umbrel
umbrel app install pumpstr
# Ou manuel :
cd ~/umbrel/app-data
mkdir -p pumpstr
cp -r /chemin/vers/pumpstr/node/* pumpstr/
# Édite pumpstr/umbrel-app.yml puis :
~/umbrel/scripts/app install pumpstr
```

## Option 3 — Local (dev)

```bash
cd node
npm install
npm start
```

## Variables d'environnement

| Variable | Description | Défaut |
|----------|-------------|--------|
| `PORT` | Port HTTP | 4242 |
| `HTTPS_PORT` | Port HTTPS auto-signé | 4243 |
| `ARK_SERVER_URL` | Endpoint Arkade | `https://mutinynet.arkade.sh` |
| `BOLTZ_NETWORK` | Réseau Boltz | `mutinynet` |
| `NOSTR_RELAYS` | Relais Nostr (CSV) | `wss://relay.damus.io,...` |
| `ADMIN_TOKEN` | Token admin dashboard | **OBLIGATOIRE** |
| `LN_ADDRESS_BASE_URL` | URL publique du node | **OBLIGATOIRE** |
| `PLATFORM_SPLIT_BPS` | Split plateforme (bps) | 0 |

## Backup

```bash
# Backup la clé créateur et la DB
docker cp pumpstr-node:/app/data/pumpstr.db ./backup-$(date +%Y%m%d).db
docker cp pumpstr-node:/app/.creator-key ./backup-$(date +%Y%m%d).key
```

## Mise à jour

```bash
cd ~/pumpstr
git pull origin main
docker compose -f docker-compose.prod.yml up -d --build
```
