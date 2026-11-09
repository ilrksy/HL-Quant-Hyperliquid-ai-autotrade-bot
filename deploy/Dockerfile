# syntax=docker/dockerfile:1
# HL Quant self-hosted server image. Build context is the repository root:
#   docker build -f deploy/Dockerfile -t hl-quant .
# or, from deploy/: docker compose up -d --build
# deploy/Dockerfile.dockerignore keeps node_modules, .env and local data out of the build context (BuildKit).

# ---- build: dashboard (vite) + single-file server bundle (esbuild) ----
FROM node:24-slim AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npx vite build \
 && npm i --no-save --no-audit --no-fund esbuild@^0.28.2 \
 && node desktop/scripts/bundle-server.mjs /src /app/server.mjs

# ---- runtime: plain node, no node_modules needed ----
FROM node:24-slim
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    WEB_DIST=/app/web
WORKDIR /app
COPY --from=build /app/server.mjs ./server.mjs
COPY --from=build /src/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
# slim images have no curl, so the probe uses node's built-in fetch
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 8787) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.mjs"]
