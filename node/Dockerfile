# Pumpstr node — backend du créateur (wallet Arkade + Nostr + tips + NIP-53 + watch/overlay/tip).
# Node 22 LTS : le SDK Arkade exige >=22.12 <25 — le conteneur fige la bonne version
# (et évite le piège Node 25 de la machine hôte).
FROM node:22-alpine

WORKDIR /app

# Contexte de build = racine du repo (workspace npm). On copie d'abord les manifests
# pour bénéficier du cache de couche, puis on installe l'ensemble du workspace.
COPY package.json package-lock.json* ./
COPY node/package.json ./node/
COPY packages/payment-rail/package.json ./packages/payment-rail/
COPY spike/package.json ./spike/

RUN npm ci --no-audit --no-fund

# Puis on copie le code source de tous les workspaces.
COPY . .

ENV PORT=4242
ENV KEY_FILE=/data/.creator-key
EXPOSE 4242
VOLUME ["/data"]

# Le point d'entrée du node reste son propre serveur.
CMD ["npm", "run", "start", "--workspace=node"]
