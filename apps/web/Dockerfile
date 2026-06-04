# syntax=docker/dockerfile:1.7
# Multi-stage build for @growth/web — extends the apps/api fix-forward
# pattern (PR #62) to handle the @growth/shared workspace symlink.
#
# Build context MUST be the repo root:
#   docker build -f apps/web/Dockerfile .
#   gcloud builds submit --tag <...> . --config <...>  (run from repo root)
#
# Why the previous single-stage shape failed: the old Dockerfile copied
# only `apps/web/package*.json` and ran `npm install` standalone. That
# tries to resolve `@growth/shared` from npmjs.org and 404s — it's a
# workspace symlink, not a published package. Same KAN-737-era gap that
# bit apps/api on KAN-737 + KAN-738 deploys (fixed in PR #62 for api +
# knowledge-worker Dockerfiles; apps/web not redeployed until now so the
# breakage stayed hidden).

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json turbo.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
# --legacy-peer-deps preserves the existing monorepo's peer-dep posture
# (matches root npm config). --ignore-scripts skips postinstall hooks
# (re-run later when source is present).
RUN npm install --legacy-peer-deps --ignore-scripts

FROM deps AS build
WORKDIR /app
COPY tsconfig.json ./
COPY packages/shared ./packages/shared
COPY apps/web ./apps/web
# Build @growth/shared dist FIRST so apps/web's Next.js bundler resolves
# imports against the compiled output (matches KAN-737 PR #62 pattern).
RUN npm run build --workspace=@growth/shared
# Build apps/web's Next.js production bundle.
ENV NEXT_PUBLIC_API_URL=https://growth-api-1086551891973.us-central1.run.app
# KAN-997 — Campaign Layer Slice 1 internal demo gate. Founder OK'd
# flag-on in prod: no nav entry, no commit button, read-only,
# direct-URL only at /settings/campaign-demo. Slice 2 retires the flag.
ENV NEXT_PUBLIC_CAMPAIGN_LAYER_DEMO=true
# KAN-1088 — client-side admin allowlist (mirrors server-side ADMIN_EMAILS
# at apps/api Cloud Run env var). AuthContext.tsx parses comma-separated
# with split/lowercase/trim. NEXT_PUBLIC_* are inlined at build time —
# Cloud Run env var alone is non-functional. Adding a new admin = update
# this line + redeploy.
ENV NEXT_PUBLIC_ADMIN_EMAILS=fred@axisone.ca
RUN npm run build --workspace=@growth/web

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
RUN addgroup -S app && adduser -S -G app app
# Next.js standalone output (next.config.mjs has output: 'standalone')
# bundles the production-required deps automatically. Copy:
#   - .next/standalone (server.js + minimal node_modules)
#   - .next/static (compiled assets — standalone doesn't include these)
#   - public (static files)
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
# apps/web/public doesn't exist in this repo — Next.js handles missing
# public/ gracefully. Create the dir so Next.js startup doesn't error.
RUN mkdir -p ./apps/web/public

USER app
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
