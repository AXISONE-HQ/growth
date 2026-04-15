# growth  AI Revenue System

> Built by AxisOne

## Architecture

Turborepo monorepo  TypeScript end-to-end  GCP (Cloud Run, Cloud SQL, Pub/Sub, BigQuery, Vertex AI)

## Structure

```
apps/
  api/           Express + tRPC API (Cloud Run)
  web/           Next.js frontend (Cloud Run)
packages/
  shared/        Shared types, utils, constants
  db/            Prisma schema + client
infra/
  docker/        Dockerfiles
```

## Getting Started

```bash
npm install
npm run dev
```

## License

Proprietary  AxisOne Inc.
