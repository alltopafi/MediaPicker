# syntax=docker/dockerfile:1

# ---- deps: install the whole workspace once (dev deps included, for building/testing)
# Build stages run on the builder's native platform: their output (JS/CSS/HTML) is
# platform-independent, so multi-arch builds only emulate the small runtime stage.
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci

# ---- web-build: vite build -> web/dist
FROM deps AS web-build
COPY tsconfig.base.json ./
COPY web web
RUN npm run build -w web

# ---- server-build: tsc -> server/dist
FROM deps AS server-build
COPY tsconfig.base.json ./
COPY server server
RUN npm run build -w server

# ---- test: full source + dev deps; run with `docker compose run --rm test`
FROM deps AS test
COPY . .
CMD ["npm", "test"]

# ---- runtime: production deps only, non-root
FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false \
    && npm cache clean --force
COPY --from=server-build /app/server/dist server/dist
COPY server/migrations server/migrations
COPY --from=web-build /app/web/dist web/dist
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
CMD ["node", "server/dist/index.js"]
