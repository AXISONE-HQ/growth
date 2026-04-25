# Claude Code — Working Memory for growth.

This document is committed context that helps Claude Code work effectively in this repo across sessions. Per-session conversation state persists separately at `~/.claude/projects/-Users-fredericbinette-growth/memory/`; this file is the shared, reviewable complement.

## Current sprint — KAN-656 path

Parent story: **[KAN-656](https://axisone-team.atlassian.net/browse/KAN-656)** — "Launch sends real email end-to-end — close the wedge's demo gap" (To Do, Highest).

Subtasks ladder up to KAN-656. Run this to see the current list:

```sh
scripts/jira.sh search 'parent = KAN-656' | jq -r '.issues[] | "\(.key)  \(.fields.status.name)  \(.fields.summary)"'
```

Known subtask in flight at time of writing:
- **[KAN-658](https://axisone-team.atlassian.net/browse/KAN-658)** — Provision GCP Pub/Sub topics (`action.decided`, `action.send`, `action.executed`) + pull subscriptions + DLQ in project `growth-493400`. Labeled `claude-ready` `gcp` `infra`.

Upstream work that unblocks the wedge flow:
- **PR #3** (`feat/kan-655-wedge-ui`) — Day-1 Wedge UI + `wedge` tRPC router + Decision Engine adapter mode (`playbookStepContext`). Unmerged. Ships the `/opportunities` page and the Launch button. Demo gap documented in its PR description: the button writes Decision rows but no email fires — KAN-656's job.

## scripts/jira.sh — Atlassian REST API wrapper

Why it exists: the MCP Jira tools cover in-session Claude Code use. This wrapper handles everything else — humans running `jira.sh` from Terminal, CI pipelines, future Claude sessions on machines without the MCP wired.

### Setup (one time)

```sh
# Put your API token in Keychain (service name is fixed):
security add-generic-password -s axisone-jira-token -a "$ATLASSIAN_EMAIL" -w
# paste token from id.atlassian.com/manage-profile/security/api-tokens

# Add to ~/.zshrc:
export ATLASSIAN_EMAIL=you@axisone.ca
```

`ATLASSIAN_CLOUD_URL` defaults to `https://axisone-team.atlassian.net` — override only when that changes.

### Subcommands

```sh
scripts/jira.sh get KAN-658
scripts/jira.sh comment KAN-658 "Provisioning complete — topics created, subs attached."
scripts/jira.sh transition KAN-658 "In Progress"
scripts/jira.sh search 'project = KAN AND labels = claude-ready AND status = "To Do"'
```

Output is JSON. Pipe to `jq` for field extraction:

```sh
scripts/jira.sh get KAN-658 | jq -r '.fields.status.name'
scripts/jira.sh search 'project = KAN AND labels = claude-ready' | jq -r '.issues[].key'
```

The `transition` subcommand resolves state names against the issue's *available* transitions (Jira workflows are per-project). If the name doesn't match, it prints the list of valid transitions and exits non-zero.

## Architectural gotchas (surfaced in PR #3)

Three quirks a fresh Claude Code session will trip over without this heads-up.

### 1. Package manager is npm, not pnpm

Root `package.json` declares `"packageManager": "npm@10.0.0"` and `"workspaces": ["apps/*", "packages/*"]`. Turbo orchestrates tasks. Do not default to `pnpm`:

```sh
# Right
npm install
npm run dev -w @growth/web
npm -w @growth-ai/api run build

# Wrong (will create a pnpm lockfile + diverge from CI)
pnpm install
```

### 2. The `@growth/api` alias is broken

The alias appears in `apps/api/scripts/backfill-decisions.ts:18` and in docstrings as if it were a working path mapping. It isn't:

- `packages/api/` has **no `package.json`** — it's source-only, not a workspace package, so `npm` never creates a `node_modules/@growth/api` symlink.
- There's **no `paths` mapping** for `@growth/api` in any `tsconfig.json`.
- `apps/api/tsconfig.json` has `include: ["src"]`, which excludes the `scripts/` dir, so tsc never flags the broken import on that file.

At runtime, `tsx` would fail to resolve `@growth/api/...`. The backfill script has never actually been runnable in its current form.

**What to use instead** when importing from `packages/api` inside `apps/api`: relative paths with `.js` extensions (matching the existing ESM convention, since `apps/api` is `"type": "module"` and `router.ts` already uses `./trpc.js`, `./llm.js`):

```ts
import { runDecisionForContact } from "../../../packages/api/src/services/run-decision-for-contact.js";
```

### 3. `apps/api/tsconfig.json` has `rootDir: "src"` — cross-package imports TS6059 cascade

With `rootDir` pinned to `apps/api/src`, any `.ts` file outside that directory triggers `TS6059: File '...' is not under 'rootDir'` when tsc walks the import graph.

In practice this means:

- Importing even one file from `packages/api/src/services/` surfaces 10+ `TS6059` violations (the imported file + everything it transitively imports).
- The runtime is fine — `tsx`/`node` resolve modules independently of tsc's rootDir check. It's only `tsc --noEmit` that complains.
- These errors are **config, not code**. Don't try to "fix" them by moving files into `apps/api/src/` — that would break the package boundary.

PR #3 surfaced 12 of these cascading violations because it was the first PR to import from `packages/api/src/services/`. A proper fix requires either restructuring `packages/api` as a real workspace package (with its own `package.json` and `tsconfig.json`), or using TypeScript project references. That's a separate epic.

**For now:** treat `TS6059` errors on cross-package imports as expected noise. Focus on errors within `apps/api/src/` itself.

## Schema changes — use `prisma migrate`, never `db push`

Hard rules earned from KAN-679 (production data loss event) and KAN-680 (root-cause cleanup):

### Allowed

- **Local development:** `npx prisma migrate dev --name <description>` against an ephemeral local DB. Generates a migration file + applies it. The migration file gets committed.
- **Deploy / shared DBs:** `npx prisma migrate deploy` against the target. Applies any pending migration files in order. Idempotent. No interactive prompts. No destructive surprises.
- **Status check:** `npx prisma migrate status` — read-only, safe everywhere.
- **Adopting baseline on an existing DB:** `prisma migrate diff --from-empty --to-schema-datamodel <schema> --script > migration.sql` to capture current state, then `prisma migrate resolve --applied <migration-name>` to mark it without re-applying. Pattern used to bootstrap KAN-680.

### Banned

- **`prisma db push`** in any prod context. It silently DROPs tables that diverge from the schema. There is no audit trail. There is no migration file. KAN-679 lost 8 rows of production data because the schema-vs-DB diff was not what the operator expected.
- **`--accept-data-loss`** flag, period. Anywhere. If a schema change legitimately requires a destructive operation, write the migration explicitly with named `DROP` / `ALTER ... DROP COLUMN` statements, get them reviewed in the PR, and apply via `migrate deploy`.
- **Manual SQL `DROP TABLE` / `TRUNCATE` / `ALTER ... DROP`** against shared DBs without the `reference_destructive_db_operation_protocol.md` 5-step gate (in personal memory).

### Backup posture is a prerequisite

Before any session that touches DB schema or data, verify Cloud SQL backups + PITR are both enabled:

```sh
gcloud sql instances describe growth-db --project=growth-493400 \
  --format='value(settings.backupConfiguration.enabled,settings.backupConfiguration.pointInTimeRecoveryEnabled)'
# expected: True;True
```

Anything else (False, missing, single True) is a STOP signal — fix posture first via:

```sh
gcloud sql instances patch growth-db --project=growth-493400 \
  --backup-start-time=03:00 --enable-point-in-time-recovery
```

### Why this exists

- KAN-679 dropped `Tenant`, `Contact`, `Integration`, `CompanyInfo` tables (8 rows of demo data) when `prisma db push --accept-data-loss` interpreted legacy CamelCase tables as drift. Cloud SQL backups were disabled at the time, so there was no recovery path.
- KAN-680 traced the root cause to a duplicate Prisma schema at `apps/api/prisma/schema.prisma` (deleted in KAN-680) — different model definitions, different table casings, no `@@map` directives. Confusion between two "authoritative" schemas was the real mistake; the data loss was the consequence.
- Post-KAN-680: single canonical schema is `packages/db/prisma/schema.prisma`. Migrations live in `packages/db/prisma/migrations/`. Baseline = `20260425005757_baseline`.

## Deploy paths — single canonical per service

Post-KAN-680: each Cloud Run service has exactly one deploy mechanism. No parallel deploy systems.

| Service | Deploy mechanism | Triggered by |
|---|---|---|
| `growth-api` | `.github/workflows/deploy-api.yml` (GitHub Actions) | push to `main` touching `apps/api/**` or `packages/**` |
| `growth-connectors` | `.github/workflows/deploy-connectors.yml` (GitHub Actions) | push to `main` touching `apps/connectors/**` or `packages/**` |
| `growth-web` | `cloudbuild-web.yaml` + `growth-web-deploy` Cloud Build trigger | push to `main` (no path filter — broader than ideal) |

The legacy `cloudbuild.yaml` + `cloudbuild-staging.yaml` for the API + their Cloud Build trigger `growth-api-deploy` were retired in KAN-680. The trigger is **disabled** (not deleted) — its trigger ID `0a6e65ab-3765-4915-af37-e62841b76893` survives for archaeology if anyone needs to revisit history.

Web's parallel deploy mechanism (cloudbuild-web.yaml) was intentionally left untouched in KAN-680 — separate cleanup ticket warranted.

## Cloud Run deploy auto-shift expectation (KAN-685)

Both `growth-api` and `growth-connectors` services should have:

```
spec.traffic = [{ type: TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST, percent: 100 }]
```

This makes every successful deploy auto-promote the new revision to 100% traffic. The `google-github-actions/deploy-cloudrun@v2` action relies on this — it doesn't pass `--no-traffic`, so promotion is determined by the existing service spec.

**Don't** pin to a specific `revisionName` via REST API or `gcloud run services update-traffic --to-revisions=NAME=100`. Doing so silently breaks future auto-promotion: deploys create new revisions but traffic stays on the pinned name. Three sessions burned on this (KAN-677/657/454) before KAN-685 traced the root cause.

**If you need to roll back to an older revision:** use `gcloud run services update-traffic --to-revisions=OLD_NAME=100`, verify the rollback served what you wanted, then **immediately** restore `--to-latest` after rollback. Don't leave the pin in place.

**Diagnostic command** if auto-shift looks broken:

```sh
gcloud run services describe SERVICE --region=us-central1 \
  --format='value(spec.traffic[].revisionName,spec.traffic[].percent,spec.traffic[].latestRevision)'
```

Healthy state shows `True 100` (latestRevision=true, percent=100). Broken state shows a revision name + `100` (pinned).

**Repair via REST** (the gcloud equivalent sometimes hits the auth issue documented below):

```sh
TOKEN=$(gcloud auth application-default print-access-token)
curl -s -X PATCH \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "https://run.googleapis.com/v2/projects/growth-493400/locations/us-central1/services/SERVICE?updateMask=traffic" \
  -d '{"traffic":[{"type":"TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST","percent":100}]}'
```

## gcloud `ACCESS_TOKEN_TYPE_UNSUPPORTED` workaround (KAN-686)

Some `gcloud` commands return `ACCESS_TOKEN_TYPE_UNSUPPORTED` against the user's gcloud token, even when ADC is freshly authenticated. Confirmed affecting:

- `gcloud secrets versions access`
- `gcloud run services describe`
- `gcloud run services update-traffic`

Likely an SDK / ADC-vs-user-token / org-policy mismatch — root cause not yet investigated (out of KAN-686 scope).

**Workaround:** use the ADC token directly via REST API.

```sh
# Secret Manager access
TOKEN=$(gcloud auth application-default print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://secretmanager.googleapis.com/v1/projects/growth-493400/secrets/<name>/versions/latest:access" \
  | python3 -c "import sys,json,base64; print(base64.b64decode(json.load(sys.stdin)['payload']['data']).decode())"

# Cloud Run service describe
TOKEN=$(gcloud auth application-default print-access-token)
curl -s -H "Authorization: Bearer $TOKEN" \
  "https://run.googleapis.com/v2/projects/growth-493400/locations/us-central1/services/growth-api"

# Cloud Run traffic patch (see KAN-685 section above for full example)
```

If `gcloud auth application-default print-access-token` returns empty, ADC needs refresh: `gcloud auth application-default login` (interactive — opens a browser).

**When to use:** only when `gcloud` returns the specific `ACCESS_TOKEN_TYPE_UNSUPPORTED` error. The REST APIs are exact equivalents of the gcloud commands; output shapes are identical (or close enough to parse with `python3 -c "import sys,json; ..."`).

## Workspace resolution — packages that ship built output

Workspace packages under `packages/*` that other workspaces depend on (e.g. `@growth/connector-contracts`, `@growth/db`, `@growth/shared`) declare:

```jsonc
{
  "main":  "dist/index.js",
  "types": "dist/index.d.ts",
  "scripts": { "build": "tsc" }
}
```

Consumers import via the workspace name (`import { ... } from '@growth/connector-contracts'`) and npm's workspaces symlink resolves `node_modules/@growth/connector-contracts` → `packages/connector-contracts/`. tsc then follows `main`/`types` and expects to find `dist/index.js` / `dist/index.d.ts`.

**If `dist/` doesn't exist, resolution fails with** `TS2307: Cannot find module '@growth/<name>'` — even though the workspace symlink is fine. `turbo.json` already chains `lint.dependsOn: ["^build"]`, but that only fires when lint is invoked *through* turbo. Direct `npm run lint -w <workspace>` and fresh clones bypass it.

**Fix pattern: a `postinstall` hook in the emitting package's `package.json`** so `npm install` always produces `dist/` before anything tries to consume the package:

```jsonc
"scripts": {
  "build": "tsc",
  "postinstall": "tsc",   // ensures dist/ after every install
  "lint": "tsc --noEmit"
}
```

**Packages using this pattern today:**
- `packages/connector-contracts` — `postinstall: "tsc"` (KAN-664, PR #8)
- `packages/db` — `postinstall: "prisma generate"` (KAN-665, PR #7) — same shape, different tool

`packages/shared` has the same `main: dist/index.js` declaration but isn't currently imported from any `apps/` code, so its missing `dist/` is latent, not broken. If/when `apps/*` imports from `@growth/shared`, add the same `postinstall: "tsc"` hook.

## Known pre-existing type errors

As of 2026-04-24, `npx tsc --noEmit` from `apps/api/` reports approximately:
- **22 errors** in `apps/api/src/` (integrations, router implicit-any, `firebase-admin` missing) — pre-existing baseline.
- **15 errors** in `packages/api/src/services/` that only surface when something in `apps/api/src/` imports from it (missing `express` types, export conflicts in `objective-gap-analyzer.ts`, `Contact` type resolution in `wedge-signals.ts`).
- **12 structural `TS6059` violations** from the rootDir issue above.

None of these are blockers for wedge-path work. Don't fix them as drive-bys — each has its own follow-up scope.

## CI state

As of 2026-04-24, the `Lint & Type Check` and `Test` jobs have been **failing on `main` for multiple days** (4 of the last 5 runs red). Two root causes, both orthogonal to any individual PR's code:

- **`apps/web` has no ESLint config.** `next lint` enters interactive setup in CI (no TTY), fails immediately. Needs a committed `.eslintrc.json` or migration to the flat config.
- **`apps/connectors` vitest needs CI env vars.** Tests import a zod-validated env module requiring `GCP_PROJECT_ID`, `DATABASE_URL`, `INTERNAL_TRPC_AUTH_TOKEN`. CI doesn't supply them, so tests crash at module load.

New PRs will show `UNSTABLE` in `gh pr view` because of the same two pre-existing failures. This is not a signal about the PR's actual code. Check the *specific* failure against the known-failures list before spending time on it.

## Useful one-liners

```sh
# Typecheck a specific workspace without touching others:
cd apps/web && npx tsc --noEmit
cd apps/api && npx tsc --noEmit

# See CI status for the current branch's PR:
gh pr checks --watch=false

# Find all claude-ready tickets in the current sprint:
scripts/jira.sh search 'project = KAN AND labels = claude-ready AND status != Done' | jq -r '.issues[] | "\(.key) [\(.fields.status.name)] \(.fields.summary)"'
```
