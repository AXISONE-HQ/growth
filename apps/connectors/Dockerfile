# syntax=docker/dockerfile:1.7
# Multi-stage build for @growth-ai/connectors — matches apps/api conventions.
# Cloud Run target: Node 20 on linux/amd64.

FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ─────────────────────────────────────────────
# deps: install workspace deps (cached layer)
# ─────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY packages/connector-contracts/package.json ./packages/connector-contracts/
COPY packages/db/package.json ./packages/db/
COPY packages/shared/package.json ./packages/shared/
COPY apps/connectors/package.json ./apps/connectors/
# --ignore-scripts: source isn't here yet, so postinstall hooks (tsc in
# connector-contracts; prisma generate in packages/db) would fail. They're
# re-run explicitly in the build stage once source is available.
RUN npm install --include=dev --no-audit --no-fund --ignore-scripts

# ─────────────────────────────────────────────
# build: TypeScript compilation
# ─────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY packages/connector-contracts ./packages/connector-contracts
COPY packages/db ./packages/db
COPY packages/shared ./packages/shared
COPY apps/connectors ./apps/connectors
RUN npx prisma generate --schema=./packages/db/prisma/schema.prisma
RUN npx turbo run build --filter=@growth-ai/connectors

# ─────────────────────────────────────────────
# runtime: minimal production image
# ─────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# openssl is required by Prisma's query engine and is not in node:20-slim by
# default. Without this, Prisma logs "Prisma failed to detect the libssl/openssl
# version to use, and may not work as expected. Defaulting to openssl-1.1.x"
# and then crashes at runtime trying to require the 1.1.x engine.
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
# Non-root user for security
RUN groupadd -r app && useradd -r -g app app

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/connectors/dist ./apps/connectors/dist
COPY --from=build /app/apps/connectors/package.json ./apps/connectors/package.json

USER app
EXPOSE 8081
CMD ["node", "apps/connectors/dist/index.js"]
