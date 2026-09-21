FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/web/package.json apps/web/package.json
COPY packages/shared-types/package.json packages/shared-types/package.json
RUN npm install
COPY apps/web apps/web
COPY packages/shared-types packages/shared-types
RUN npm run build -w @ledgerlands/shared-types && npm run build -w @ledgerlands/web
EXPOSE 5173
CMD ["npm", "run", "dev", "-w", "@ledgerlands/web"]
