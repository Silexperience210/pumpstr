#!/bin/bash
set -e

# =============================================================================
# Pumpstr — Script de déploiement VPS (Ubuntu 22.04+ / Debian 12+)
# =============================================================================
# Usage : curl -fsSL https://raw.githubusercontent.com/Silexperience210/pumpstr/main/deploy.sh | bash
# Ou    : wget -qO- https://raw.githubusercontent.com/Silexperience210/pumpstr/main/deploy.sh | bash
# =============================================================================

PUMPSTR_DIR="${PUMPSTR_DIR:-$HOME/pumpstr}"
DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-}"

log() { echo "[$(date +%H:%M:%S)] $1"; }
error() { echo "[$(date +%H:%M:%S)] ❌ $1" >&2; exit 1; }

# --- Prérequis ---
log "Vérification des prérequis..."
command -v docker >/dev/null 2>&1 || error "Docker n'est pas installé. Installe-le : https://docs.docker.com/engine/install/"
command -v docker-compose >/dev/null 2>&1 || command -v docker compose >/dev/null 2>&1 || error "Docker Compose n'est pas installé."

# --- Clone ---
if [ -d "$PUMPSTR_DIR/.git" ]; then
    log "Mise à jour du repo existant..."
    cd "$PUMPSTR_DIR"
    git pull origin main
else
    log "Clone du repo Pumpstr..."
    git clone https://github.com/Silexperience210/pumpstr.git "$PUMPSTR_DIR"
    cd "$PUMPSTR_DIR"
fi

# --- Environnement ---
if [ ! -f .env ]; then
    log "Création du fichier .env..."
    cat > .env << 'EOF'
# === Pumpstr — Configuration Production ===
PORT=4242
HTTPS_PORT=4243

# Arkade (mutinynet = testnet, mainnet = production)
ARK_SERVER_URL=https://mutinynet.arkade.sh
BOLTZ_NETWORK=mutinynet

# Nostr
NOSTR_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.primal.net

# Stream (laisse vide pour mode demo)
STREAM_D=pumpstr-live
STREAM_TITLE=🔴 Pumpstr Live
STREAM_SUMMARY=Streaming souverain sur Bitcoin — tips en sats, en direct.
STREAM_URL=
STREAM_IMAGE=

# Lightning Address
LN_ADDRESS_USER=pay
LN_ADDRESS_BASE_URL=

# Sécurité (change ces valeurs !)
ADMIN_TOKEN=change-me-now-$(openssl rand -hex 16)
PLATFORM_SPLIT_BPS=0

# Cloudflare Stream (optionnel)
# CLOUDFLARE_STREAM_ACCOUNT_ID=
# CLOUDFLARE_STREAM_API_TOKEN=
# CLOUDFLARE_STREAM_CUSTOMER_CODE=

# Clé persistante (auto-générée si absente)
# KEY_FILE=./node/.creator-key
EOF
    log "⚠️  Édite .env et change au minimum ADMIN_TOKEN et LN_ADDRESS_BASE_URL"
fi

# --- Build & Run ---
log "Build Docker..."
docker compose -f docker-compose.prod.yml build --no-cache

log "Démarrage des services..."
docker compose -f docker-compose.prod.yml up -d

# --- Healthcheck ---
log "Attente du healthcheck (15s)..."
sleep 15

if curl -sf http://localhost:4242/api/creator >/dev/null 2>&1; then
    log "✅ Pumpstr node est en ligne !"
    log "   Dashboard : http://localhost:4242/dashboard.html"
    log "   Overlay   : http://localhost:4242/overlay.html"
    log "   Tip       : http://localhost:4242/tip.html"
    log "   Relay     : ws://localhost:4242/relay"
else
    error "Le node ne répond pas. Vérifie les logs : docker logs pumpstr-node"
fi

# --- Caddy (HTTPS) si domaine fourni ---
if [ -n "$DOMAIN" ]; then
    log "Configuration HTTPS avec Caddy pour $DOMAIN..."
    cat > Caddyfile << EOF
$DOMAIN {
    reverse_proxy pumpstr-node:4242
    tls $EMAIL
}
EOF
    docker compose -f docker-compose.prod.yml restart caddy
    log "✅ HTTPS configuré : https://$DOMAIN"
fi

log ""
log "🚀 Déploiement terminé !"
log "Pour voir les logs : docker logs -f pumpstr-node"
log "Pour arrêter      : docker compose -f docker-compose.prod.yml down"
