# Pumpstr node — backend du créateur (wallet Arkade + Nostr + tips + NIP-53 + watch/overlay/tip).
# Node 22 LTS : le SDK Arkade exige >=22.12 <25 — le conteneur fige la bonne version
# (et évite le piège Node 25 de la machine hôte).
FROM node:22-alpine

WORKDIR /app

# Deps d'abord (cache de couche). On utilise `npm install` (PAS `npm ci`) : le lock est
# généré sous Windows/npm 11 et les binaires esbuild/tsx sont platform-specific -> install
# re-résout pour linux (le `npm ci` casserait sur le lock cross-plateforme).
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

COPY . .

ENV PORT=4242
ENV KEY_FILE=/data/.creator-key
EXPOSE 4242
VOLUME ["/data"]

# tsx exécute le TypeScript directement (pas d'étape de build).
CMD ["npx", "tsx", "server.ts"]
