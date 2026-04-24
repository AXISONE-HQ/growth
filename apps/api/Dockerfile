# syntax=docker/dockerfile:1.7
# Multi-stage build for @growth-ai/api — modeled on apps/connectors/Dockerfile.
# Cloud Run target: Node 20 on linux/amd64.
#
# Differs from connectors in one way: apps/api uses npx tsx at runtime (not a
# compiled dist/), because tsc fails on the workspace-relative imports it picks
# up from packages/api (rootDir cascade — see docs/CLAUDE.md gotcha #3). The
# runtime stage therefore copies source for both apps/api and packages/api.
#
# Build context MUST be the repo root (`docker build -f apps/api/Dockerfile .`).
# Old Dockerfile assumed context = apps/api/, which is why /packages/ was missing
# from the image and every Cloud Run revision since KAN-655 has failed to start
# with ERR_MODULE_NOT_FOUND on workspace-relative imports.

FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ─────────────────────────────────────────────
# deps: install workspace deps (cached layer)
# ─────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY apps/api/package.json ./apps/api/
COPY apps/connectors/package.json ./apps/connectors/
COPY apps/web/package.json ./apps/web/
COPY packages/connector-contracts/package.json ./packages/connector-contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
# --ignore-scripts: source isn't here yet, so postinstall hooks (tsc in
# connector-contracts; prisma generate in packages/db) would fail. They're
# re-run explicitly in the build stage once source is available.
RUN npm install --include=dev --no-audit --no-fund --ignore-scripts

# ─────────────────────────────────────────────
# build: copy source + generate Prisma client
# ─────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY packages/connector-contracts ./packages/connector-contracts
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY packages/api ./packages/api
COPY apps/api ./apps/api
RUN npx prisma generate --schema=./packages/db/prisma/schema.prisma

# ─────────────────────────────────────────────
# runtime: minimal production image
# ─────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN groupadd -r app && useradd -r -g app app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/api ./apps/api

USER app
WORKDIR /app/apps/api
EXPOSE 8080
ENV PORT=8080
CMD ["npx", "tsx", "src/index.ts"]
