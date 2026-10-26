# syntax=docker/dockerfile:1
# ---- Stage 1: install production dependencies (build tools only live here) ----
FROM node:22-bookworm-slim AS deps
WORKDIR /app
# python3/make/g++ are only needed if better-sqlite3 has no prebuilt binary for the platform
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: slim runtime ----
FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/app/data/flags.db \
    STAGING_DIR=/tmp/flaglab-staging
# The orchestrator drives Docker through the CLI; copy just the static binary.
COPY --from=docker:27-cli /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Runs as root on purpose: access to /var/run/docker.sock is required, and
# that socket is root-equivalent on the host whichever user holds it.
CMD ["node", "src/server.js"]
