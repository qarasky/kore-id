# syntax=docker/dockerfile:1

# Kore ID: one Node process serving the OIDC endpoints, the JSON API and the web UI.

# 1. The web UI (React + kore-ui) -> web/dist.
FROM node:26-slim AS web
WORKDIR /src/web
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY web/package.json web/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --no-audit --no-fund
COPY web/ ./
RUN npm run build

# 2. Server dependencies only (no TypeScript: Node strips the types itself).
FROM node:26-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --no-audit --no-fund

# 3. Runtime.
FROM node:26-slim
# Links the package to the repository on ghcr.io (the workflow adds the rest of the OCI labels).
LABEL org.opencontainers.image.source="https://github.com/qarasky/kore-id" \
      org.opencontainers.image.title="kore-id" \
      org.opencontainers.image.description="Kore ID: single sign-on for the Kore apps"
ENV NODE_ENV=production \
    PORT=4000 \
    DATA_DIR=/data \
    CLIENTS_FILE=/data/clients.json \
    WEB_DIR=/app/web/dist
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY scripts ./scripts
COPY sdk ./sdk
COPY --from=web /src/web/dist ./web/dist
# /data holds the SQLite DB, the signing keys and clients.json. Back it up.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
# No curl in the image; Node checks itself.
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "src/server.ts"]
