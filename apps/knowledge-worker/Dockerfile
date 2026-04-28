# syntax=docker/dockerfile:1.7
# KAN-707 PR B — Cloud Run job image for the knowledge ingestion worker.
# Cloud Run target: Node 20 on linux/amd64. Job (not service) — runs to
# completion, no HTTP listener.

FROM node:20-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# ─────────────────────────────────────────────
# deps: install workspace deps (cached layer)
# ─────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json turbo.json ./
COPY packages/db/package.json ./packages/db/
COPY apps/knowledge-worker/package.json ./apps/knowledge-worker/
RUN npm install --include=dev --no-audit --no-fund --ignore-scripts

# ─────────────────────────────────────────────
# build: TypeScript compilation
# ─────────────────────────────────────────────
FROM deps AS build
COPY tsconfig.json ./
COPY packages/db ./packages/db
COPY apps/knowledge-worker ./apps/knowledge-worker
RUN npx prisma generate --schema=./packages/db/prisma/schema.prisma
RUN npx turbo run build --filter=@growth-ai/knowledge-worker

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
COPY --from=build /app/apps/knowledge-worker/dist ./apps/knowledge-worker/dist
COPY --from=build /app/apps/knowledge-worker/package.json ./apps/knowledge-worker/package.json

USER app
# No EXPOSE — this is a Cloud Run job, not a service. Container runs to
# completion via INGESTION_ID env var override + exits.
CMD ["node", "apps/knowledge-worker/dist/index.js"]
