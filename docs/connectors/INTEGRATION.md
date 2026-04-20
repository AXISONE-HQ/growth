# Connectors Service — Integration Guide

This archive scaffolds the Foundation epic (KAN-470) of the Connectors Service
per ADR-007. It's designed to drop into `AXISONE-HQ/growth` with minimal
friction.

## What's Inside

```
growth-connectors/
├── apps/
│   └── connectors/                  → drop into repo's apps/
│       ├── src/                     Hono service source
│       ├── package.json             @growth-ai/connectors
│       ├── tsconfig.json
│       ├── Dockerfile               matches apps/api pattern
│       ├── .dockerignore
│       └── .env.example
├── packages/
│   └── connector-contracts/         → drop into repo's packages/
│       ├── src/                     Types, Zod schemas, tRPC I/O
│       ├── package.json             @growth/connector-contracts
│       └── tsconfig.json
├── prisma/
│   └── schema-additions.prisma      → APPEND to packages/db/prisma/schema.prisma
├── infra/
│   └── cloudbuild-connectors.yaml   → drop into repo root alongside existing cloudbuild.yaml
├── INTEGRATION.md                   ← this file
└── README.md                        Service-level README
```

## Integration Steps (engineer checklist)

### 1. Merge the scaffold into the repo

```bash
# From the AXISONE-HQ/growth repo root:
cp -R <unzipped>/growth-connectors/apps/connectors ./apps/
cp -R <unzipped>/growth-connectors/packages/connector-contracts ./packages/
cp <unzipped>/growth-connectors/infra/cloudbuild-connectors.yaml ./
```

### 2. Extend the Prisma schema

Open `packages/db/prisma/schema.prisma` and append the contents of
`prisma/schema-additions.prisma` (ChannelConnection model, two enums).

Then inside the existing `model Tenant { ... }` relations block, add:

```prisma
channelConnections ChannelConnection[]
```

### 3. Install + generate

```bash
npm install
npm run -w @growth/db generate
npm run -w @growth/db push   # dev — use `prisma migrate dev` for committed migrations
```

### 4. Boot the service locally

```bash
cp apps/connectors/.env.example apps/connectors/.env
# Edit apps/connectors/.env — set GCP_PROJECT_ID and INTERNAL_TRPC_AUTH_TOKEN

npm run -w @growth-ai/connectors dev
# → @growth-ai/connectors listening on :8081

# Smoke test
curl http://localhost:8081/healthz
# → {"status":"ok","service":"@growth-ai/connectors"}
```

### 5. Set up GCP resources (one-time)

Run these or add to Terraform:

```bash
PROJECT_ID=<your-gcp-project>

# Pub/Sub topics (KAN-479, KAN-527)
for topic in action.send action.executed inbound.raw connection.health.changed; do
  gcloud pubsub topics create "$topic" --project=$PROJECT_ID
  gcloud pubsub topics create "${topic}.dlq" --project=$PROJECT_ID
done

# Service account with scoped IAM (KAN-478, KAN-524)
gcloud iam service-accounts create connectors-sa \
  --display-name="Connectors Service" \
  --project=$PROJECT_ID

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:connectors-sa@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:connectors-sa@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

gcloud projects add-iam-policy-binding $PROJECT_ID \
  --member="serviceAccount:connectors-sa@$PROJECT_ID.iam.gserviceaccount.com" \
  --role="roles/pubsub.subscriber"

# Secrets (KAN-478)
echo -n "<32+ char random>" | gcloud secrets create connectors-internal-trpc-token \
  --data-file=- --project=$PROJECT_ID
```

### 6. Set up the Cloud Build trigger

In the GCP Console → Cloud Build → Triggers:
- New trigger pointing at `AXISONE-HQ/growth`
- Branch: `main`
- Included files: `apps/connectors/**`, `packages/connector-contracts/**`, `packages/db/**`
- Build config: `cloudbuild-connectors.yaml`

### 7. Verify the deploy

```bash
gcloud run services describe growth-connectors --region=us-central1
curl -H "Authorization: Bearer $(gcloud auth print-identity-token)" \
  https://growth-connectors-<hash>-uc.a.run.app/healthz
```

## Jira Ticket Coverage

This scaffolding closes or substantially advances the following tickets in
Epic KAN-470 (Foundation) and KAN-471 (Adapter Framework):

| Ticket  | Status                                            |
| ------- | ------------------------------------------------- |
| KAN-475 | ✅ Cloud Run service bootstrap                    |
| KAN-476 | ✅ @growth/connector-contracts package            |
| KAN-477 | ✅ channel_connections schema (ready to merge)    |
| KAN-478 | 🟡 Secret Manager wrapper (stub + IAM guide)      |
| KAN-479 | 🟡 Pub/Sub topics (Cloud Build + gcloud commands) |
| KAN-480 | 🟡 Webhook ingress (router + verifier framework)  |
| KAN-481 | 🟡 Observability (pino structured logging)        |
| KAN-482 | ✅ CI/CD (Cloud Build pipeline)                   |
| KAN-483 | ✅ ChannelAdapter interface                       |
| KAN-484 | ✅ Adapter registry with DI                       |
| KAN-485 | 🟡 action.send consumer (Pub/Sub push stub)       |
| KAN-486 | 🟡 inbound normalizer (webhook router stub)       |
| KAN-489 | 🟡 Connection Manager tRPC (router + NOT_IMPLEMENTED stubs) |

Real implementation of each channel (Twilio KAN-472, SendGrid KAN-473,
Messenger KAN-474) plugs into this scaffolding — each adapter is ~300 LOC
against the interface.

## Contact for Questions

The ADR, architecture, and ticket-by-ticket breakdown live in Jira project KAN.
Epic KAN-470 holds all Foundation stories; KAN-471 holds framework stories.
