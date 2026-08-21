FROM node:26.7.0-bookworm-slim AS build

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/sdk/package.json packages/sdk/package.json
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:26.7.0-bookworm-slim AS runtime

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4319
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/dist-server ./dist-server
COPY --from=build --chown=node:node /app/server/demo-application.ts ./server/demo-application.ts

USER node
EXPOSE 4319
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4319/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", "dist-server/server/index.js"]
