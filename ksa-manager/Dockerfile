# syntax=docker/dockerfile:1
# KSA Manager – Produktionsimage (ein Prozess, persistentes Datenverzeichnis /app/data)
ARG NODE_IMAGE=node:24-bookworm-slim

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    DATABASE_PATH=/app/data/ksa.sqlite \
    PROOF_STORAGE_DIR=/app/data/proofs
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
VOLUME ["/app/data"]
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 CMD ["node", "dist/scripts/healthcheck.js"]
STOPSIGNAL SIGTERM
CMD ["node", "dist/src/index.js"]
