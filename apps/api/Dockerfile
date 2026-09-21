FROM node:22-alpine AS build
WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/game-engine/package.json packages/game-engine/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
COPY packages/aetherius-sdk/package.json packages/aetherius-sdk/package.json
RUN npm install
COPY apps/api apps/api
COPY packages packages
RUN npm run build -w @ledgerlands/shared-types && npm run build -w @ledgerlands/game-engine && npm run build -w @ledgerlands/aetherius-sdk && npm run build -w @ledgerlands/api
EXPOSE 8787
CMD ["node", "apps/api/dist/server.js"]
