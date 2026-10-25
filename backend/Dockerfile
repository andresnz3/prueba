FROM node:22.23.4-bookworm-slim AS dependencies
WORKDIR /app/backend
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

FROM node:22.23.4-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 tar \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/lib/pos/product-images \
    && chown -R node:node /var/lib/pos
COPY --from=dependencies --chown=node:node /app/backend/node_modules ./backend/node_modules
COPY --chown=node:node backend/package.json backend/server.js ./backend/
COPY --chown=node:node backend/src ./backend/src
COPY --chown=node:node backend/scripts/migrate-all.cjs backend/scripts/init-business.cjs backend/scripts/docker-image-manifest.cjs backend/scripts/docker-database-manifest.cjs ./backend/scripts/
COPY --chown=node:node database/schema.sql ./database/schema.sql
COPY --chown=node:node database/migrations/ ./database/migrations/
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=4s --start-period=25s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/server.js"]
