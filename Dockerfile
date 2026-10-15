# syntax=docker/dockerfile:1

# Debian 13 (trixie): uWebSockets.js needs glibc 2.38+, which bookworm lacks.
FROM node:22-trixie-slim AS build
WORKDIR /app
RUN corepack enable
# better-sqlite3 compiles from source; these are needed only at build time.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && pnpm prune --prod

FROM node:22-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Runs as the image's existing non-root user. The database lives on a volume
# at /data so word stats, player-invented words and reports survive restarts;
# the directory is created here so the volume inherits node's ownership.
RUN mkdir -p /data /run/vmock && chown node:node /data /run/vmock
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./
USER node
ENV DATABASE_URL=/data/game.db
ENV PORT=3001
EXPOSE 3001
# Process 0, over its Unix socket when SOCKET_PATH is set (deploy/), else the TCP port;
# HTTPS when the server has a certificate (it is this server's own socket,
# so the certificate is not checked).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD node -e "const e=process.env,p=e.SOCKET_PATH&&e.SOCKET_PATH.replace('{shard}','0');require(e.TLS_DOMAIN&&e.TLS_CERT_DIR?'https':'http').get({path:'/api/health',rejectUnauthorized:false,...(p?{socketPath:p}:{port:e.PORT})},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"
CMD ["node", "dist/index.js"]
