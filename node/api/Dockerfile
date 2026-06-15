# Pumpstr node API — placeholder.
# Backend : wallet Arkade, LNURL/Lightning Address, publisher NIP-53, reward/claimable, panel.
# Remplacer par l'implémentation réelle (Node/Bun + @pumpstr/payment-rail).

FROM node:22-alpine
WORKDIR /app

# COPY package.json package-lock.json ./
# RUN npm ci --omit=dev
# COPY . .

EXPOSE 3000

# Stub tant que l'API n'est pas écrite : garde le container vivant sans planter le compose.
CMD ["node", "-e", "require('http').createServer((_,r)=>r.end('pumpstr node api: not implemented yet')).listen(3000, ()=>console.log('pumpstr api stub on :3000'))"]
