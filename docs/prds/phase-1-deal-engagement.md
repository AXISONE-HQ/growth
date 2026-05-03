# Phase 1 — Add Deal + Engagement entities to the data model

| Field | Value |
|-------|-------|
| **Status** | Draft |
| **Priority** | P1 |
| **Loop Phase** | Cross-cutting (Ingest + Understand + Execute) |
| **Tier** | All |
| **Author** | drafted 2026-05-02 from empirical schema audit + open-question resolution pass |
| **Audit-first state** | All schema/code claims grounded in grep + prod row counts (see "Empirical anchors" below) |

---

## 1. Problem statement

> **Architectural pivot (2026-05-03):** Phase 1 was originally scoped as "add Deal + Engagement entities" with Deal as an outcome-only record (status enum: open/closed_won/closed_lost). The Sprint 6 architectural review replaced this with **Deal as the lifecycle entity** — every lead arriving creates a Deal in the starting Stage of the routed Pipeline; closed_won/closed_lost are just terminal Stages. See §10 (Architectural Context) for the 5-phase / 20-epic roadmap this PRD now sits inside.

Today's data model has **four concrete gaps** that block the Brain's learning loop and the AI normalization layer:

**(a) Inbound leads arrive as basic Contacts, no AI extraction.** Track A inbound (Resend webhook) creates a `Contact` row with raw `from_address` + `subject` + `body_preview`. No structured field extraction (company name, role, intent, deal-stage signal). Brain Service, when it ships in Phase 2 (KAN-794), has no rich data to consume — every lead is a name + email blob.

**(b) Lead lifecycle tracking is fragmented across three competing places.** `Contact.currentStageId` (Pipeline state on Contact, 7 contacts have it set in prod) + `lead_stage_history` table (0 rows in prod — never written) + threshold-gate special-case `transition_to_closed_won`/`_lost` action types (catalog-only, no executor — see KAN-789). No single source of truth; downstream consumers have to triangulate. The Phase 3 Lead/Contact split (KAN-785, now superseded — see §9.5) was a band-aid for the same root issue.

**(c) Closed-won outcomes have no persistent row anywhere.** When (or if) a `transition_to_closed_won` decision is approved, the existing code path... does nothing (KAN-789). No `Outcome` row, no audit, no learning signal. The `outcomes` table is 0 rows in prod.

**(d) Engagement is in-memory dead code.** `engagement-logger.ts` (~430 LoC) defines an `EngagementStore` interface but the only impl is `InMemoryEngagementStore` — never mounted, never imported (KAN-782 deletion target). Every engagement signal in production is lost; behavioral-learner.ts has no input.

**Phase 1 closes all four gaps in one architectural shift:**
1. **Deal becomes the lifecycle entity** — created at intake, transitions through Stages, terminal Stages carry `outcomeType: terminal_won | terminal_lost` (no separate status enum). Single source of truth for lead lifecycle.
2. **AI Lead Normalizer** (KAN-792) parses inbound and creates Contact + Deal + inbound Engagement in one atomic flow. Source-aware pre-parsers + AI extraction.
3. **Track A inbound integration** (KAN-793) wires the Normalizer into the existing Resend webhook + assignment-worker chain. Replaces the bare `assignLeadToPipeline` flow.
4. **Engagement persists with `dealId`** (required FK) — every signal attaches to the Deal it's about. Replaces the dead in-memory logger.

This addresses Fred's "massage lead to fit databases" goal directly: the AI Normalizer does the massaging at intake; the Deal model gives the lifecycle a concrete row to point at.

---

## 2. Desired outcome

**Measurable result:**

- **Real Deal rows from Track A inbound**, in the starting Stage of the routed Pipeline, populated by the AI Normalizer (not synthetic seeds, not closed-won-only outcome shells)
- **Real Engagement rows tied to Deals via `deal_id`** — both inbound (created by the Normalizer at intake) and downstream (agent action emits via the existing EngagementService from sub-cohort (b))
- **Source-of-truth lifecycle:** `Contact.currentStageId` + `lead_stage_history` retire (deprecation in Phase 1, drop in Phase 2 cleanup); Deal lifecycle is canonical

**Success metric (end of Sprint 6 — KAN-791/792/793 closed):**

```sql
-- Real Deal rows from Track A inbound, in starting Stage of routed Pipeline
SELECT COUNT(*) FROM deals
WHERE created_at > '2026-05-04'
  AND metadata->>'source' IS DISTINCT FROM 'seed';

-- Real Engagement rows tied to Deals from inbound + agent emit
SELECT COUNT(*) FROM engagements
WHERE created_at > '2026-05-04'
  AND deal_id IS NOT NULL;
```

> **Why `IS DISTINCT FROM` not `!=`:** `metadata->>'source'` returns NULL when the `source` key is absent, and `NULL != 'seed'` evaluates to NULL (not TRUE) — every untagged real row would be silently dropped from the count. `IS DISTINCT FROM` treats NULL as a real value and returns TRUE. (Detail preserved from original Edit 1; same SQL semantics apply post-pivot.)

**Pass criteria:** both queries return `>= 1` from **real Track A traffic** at end of Sprint 6 (no demo-seed rows; no synthetic smoke fixtures — must come from a real inbound email through the pivoted flow).

---

## 3. Schema changes

The original Phase 1 enum-based Deal design (`status DealStatus @default(open)`) is **replaced** by the lifecycle model below. Sub-cohort (a) work shipped a foundation that's forward-compatible — KAN-791 extends those tables, doesn't rebuild them.

### What KAN-791 adds / changes

```prisma
// ─────────────────────────────────────────────
// PHASE 1 PIVOT (KAN-791) — Deal-as-Lifecycle
// See docs/prds/phase-1-deal-engagement.md (PIVOT 2026-05-03)
// ─────────────────────────────────────────────

/// Phase 1 — Deal as the lifecycle entity (KAN-791)
model Deal {
  id                     String   @id @default(cuid())
  tenantId               String   @map("tenant_id")
  contactId              String   @map("contact_id")
  correlationId          String?  @unique @map("correlation_id")
  // NEW (KAN-791) — pipeline + stage state moves from Contact to Deal
  pipelineId             String   @map("pipeline_id")
  currentStageId         String   @map("current_stage_id")
  enteredStageAt         DateTime @default(now()) @map("entered_stage_at")
  // NEW (KAN-791) — per-Deal MO progress (moved from Contact.microObjectiveProgress)
  microObjectiveProgress Json     @default("{}") @map("micro_objective_progress")
  // CHANGED (KAN-791) — value defaults to 0 (Decimal, not nullable) per Fred
  value                  Decimal  @default(0) @db.Decimal(12, 2)
  currency               String   @default("USD") @db.VarChar(3)
  // REMOVED (KAN-791) — `status DealStatus` + `closedAt` enum approach.
  // closed_won/closed_lost are now Stages with outcomeType, not Deal columns.
  // closedAt derivable from DealStageHistory.transitionedAt where toStage.outcomeType != 'open'.
  metadata               Json     @default("{}")
  createdAt              DateTime @default(now()) @map("created_at")
  updatedAt              DateTime @updatedAt @map("updated_at")

  tenant       Tenant             @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  contact      Contact            @relation(fields: [contactId], references: [id], onDelete: Cascade)
  pipeline     Pipeline           @relation(fields: [pipelineId], references: [id], onDelete: Restrict)
  currentStage Stage              @relation("DealCurrentStage", fields: [currentStageId], references: [id], onDelete: Restrict)
  engagements  Engagement[]
  stageHistory DealStageHistory[]

  @@index([tenantId, currentStageId])
  @@index([tenantId, pipelineId])
  @@index([tenantId, contactId])
  @@map("deals")
}

/// KAN-791 — Stage gets outcomeType + cadence (drives terminal-detection + Phase 2 Stages Evolution Logic, KAN-796)
model Stage {
  // ... existing fields preserved ...
  // NEW:
  outcomeType       StageOutcomeType @default(open) @map("outcome_type")
  // NEW: per-tenant per-Pipeline per-Stage follow-up cadence config (consumer ships in KAN-796)
  followUpCadence   Json             @default("{}") @map("follow_up_cadence")
  // NEW relation:
  dealsCurrent      Deal[]           @relation("DealCurrentStage")
  dealStageFromHist DealStageHistory[] @relation("DealStageFromHistory")
  dealStageToHist   DealStageHistory[] @relation("DealStageToHistory")
}

enum StageOutcomeType {
  open
  terminal_won
  terminal_lost

  @@map("stage_outcome_type")
}

/// KAN-791 — DealStageHistory replaces lead_stage_history (deal-scoped, not contact-scoped)
model DealStageHistory {
  id             String   @id @default(cuid())
  dealId         String   @map("deal_id")
  fromStageId    String?  @map("from_stage_id")
  toStageId      String   @map("to_stage_id")
  transitionedAt DateTime @default(now()) @map("transitioned_at")
  /// 'normalizer' | 'agent' | 'human' | 'system' | 'rule:<rule_id>' — extensible string for V1
  triggeredBy    String   @map("triggered_by")
  metadata       Json     @default("{}")

  deal      Deal   @relation(fields: [dealId], references: [id], onDelete: Cascade)
  fromStage Stage? @relation("DealStageFromHistory", fields: [fromStageId], references: [id], onDelete: SetNull)
  toStage   Stage  @relation("DealStageToHistory", fields: [toStageId], references: [id], onDelete: Restrict)

  @@index([dealId, transitionedAt])
  @@index([toStageId])
  @@map("deal_stage_history")
}

/// KAN-791 — Engagement.dealId becomes REQUIRED (Engagement attaches to Deal, queryable to Contact via FK chain)
model Engagement {
  id             String      @id @default(cuid())
  tenantId       String      @map("tenant_id")
  // CHANGED (KAN-791): dealId required; contactId stays as denormalized fast-query field
  dealId         String      @map("deal_id")
  contactId      String      @map("contact_id")
  correlationId  String?     @unique @map("correlation_id")
  engagementType String      @map("engagement_type")
  signalClass    SignalClass @map("signal_class")
  channel        String?
  metadata       Json        @default("{}")
  occurredAt     DateTime    @map("occurred_at")
  createdAt      DateTime    @default(now()) @map("created_at")

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  deal    Deal    @relation(fields: [dealId], references: [id], onDelete: Cascade)
  contact Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)

  @@index([tenantId, dealId, occurredAt])
  @@index([tenantId, contactId, occurredAt])
  @@index([tenantId, engagementType])
  @@map("engagements")
}
```

### What KAN-791 deprecates (read-side only in Phase 1; drop migration in Phase 2 cleanup)

- `Contact.currentStageId` → readers migrate to `Deal.currentStageId` (read-shim during Phase 1; column dropped in Phase 2)
- `Contact.currentPipelineId` → readers migrate to `Deal.pipelineId` (same shim pattern)
- `Contact.microObjectiveProgress` → moved to `Deal.microObjectiveProgress` (Phase 1 migration backfills existing 7 prod contacts to a default Deal row)
- `lead_stage_history` table → replaced by `deal_stage_history` (0 prod rows; safe drop in Phase 2)

### What sub-cohort (a) shipped that stays canonical

- `Deal` table base — KAN-791 extends with the new columns above; doesn't rebuild from scratch
- `Engagement` table base — KAN-791 makes `dealId` required (was implicit) + adds the `(tenantId, dealId, occurredAt)` index
- `correlationId` UNIQUE idempotency contract — preserved verbatim, same Edit 2 semantics
- `SignalClass` enum — preserved
- pgvector + KAN-787 drift workaround discipline — applies to KAN-791's migration too

### What sub-cohort (a) shipped that retires

- `DealStatus` enum (`open` | `closed_won` | `closed_lost`) — replaced by `StageOutcomeType` on Stage. KAN-791 migration drops the enum + the `Deal.status` column.
- `Deal.closedAt` column — derivable from `DealStageHistory.transitionedAt` where `toStage.outcomeType != 'open'`. Drop in same migration.

**Migration discipline:** Per KAN-787, every `prisma migrate dev` will spuriously emit `DROP INDEX "knowledge_chunks_embedding_hnsw_idx"` — strip before commit (workaround documented in `docs/memories/feedback_prisma_vector_index_silent_drop_drift.md`). Per session memory `feedback_prd_assumed_infrastructure_check_kan_786`, KAN-791 implementation runs the three-dimensional pre-flight check (path / execution-path / schema-field) before any "extend X" claim.

---

## 4. Code changes

### Files to edit

| File | Change |
|------|--------|
| `packages/db/prisma/schema.prisma` | New models + enums + relations on Tenant/Contact (Section 3 above). New migration generated via `prisma migrate dev --name add_deal_engagement_kan_786` (KAN-786 is the Sprint 6 implementation ticket; matches the ticket-prefixed convention used by `apps/connectors/...kan_741_*` and `apps/api/...kan_774_*`). CI runs `prisma migrate deploy` per `reference_schema_pr_ci_migrate_step` discipline. |
| `packages/api/src/services/run-decision-for-contact.ts` | **Hook into the orchestrator at the post-approval point**: when a decision is approved (auto via threshold gate or manually) AND `actionType` is `transition_to_closed_won` or `transition_to_closed_lost`, write a `Deal` row inline (status = `closed_won`/`closed_lost`, `closedAt = now()`, **`value = null`, `currency = "USD"`** — see [KAN-790](https://axisone-team.atlassian.net/browse/KAN-790) for value-enrichment deferral; `Contact.metadata` field doesn't exist on the schema). **Decoupled from Pipeline stage transition**: the `transition_to_closed_won` / `_lost` action types have **no executor in the current codebase** (catalog-only entries in `threshold-gate.ts:92-97`, no dispatcher case anywhere — see [KAN-789](https://axisone-team.atlassian.net/browse/KAN-789)). Deal write is the outcome record itself; Pipeline stage state will be reconciled when KAN-789's executor lands. **Idempotent via `correlationId = decision.id`** per Edit 2's idempotency contract — if a `Deal` already exists with this `correlationId`, the write is a no-op (returns existing). Same decision firing twice creates exactly one deal; different decisions on same contact create separate deals (multi-cycle closed-won works correctly). |
| `packages/api/src/services/behavioral-learner.ts:9` | (Decision needed — see §9 Open questions) replace Pub/Sub subscription to `growth.engagement.logged` with direct Prisma reads from new `engagement` table, OR keep Pub/Sub and add Engagement persistence as a sibling subscriber. Recommend the latter for now (preserves existing decoupling) but PR author can swap. |
| `packages/api/src/services/agentic-tools.ts` | Wire AI agent action emit path to call `engagementService.logEngagement()`. Every action dispatched becomes one `Engagement` row with `engagementType` derived from `actionType` (e.g., `email_send` → `engagementType="email_send"`, signalClass=`neutral`; opens/clicks/replies arrive later from webhooks). Use the 3-taxonomy guidance from `decision_kan_749_mvp_shape_rationale` — pass `actionType` AS-IS, defer vocab refactor. |

> **Note on the orchestrator-hook row:** Original §4 text assumed `transition_to_closed_won` / `_lost` had an existing executor (and instructed to extend `threshold-gate.ts:36-37,92-97`). KAN-786 sub-cohort (c) pre-flight (2026-05-03) found no execution path — these action types appear ONLY as type literals + auto-approve catalog entries in `threshold-gate.ts`, with zero dispatcher cases anywhere in the repo. PRD updated to match empirical reality: write the `Deal` directly at the orchestrator (`run-decision-for-contact.ts`) on decision approval, decouple from the (non-existent) Pipeline stage transition, file [KAN-789](https://axisone-team.atlassian.net/browse/KAN-789) for the missing executor. See `docs/memories/feedback_prd_assumed_infrastructure_check_kan_786.md` for the canonical pattern + grep discipline.

### Seeds posture

**No seed data for `deals` or `engagements` in `packages/db/prisma/seed.ts`.** The success metric in §2 requires real ingestion to count, and seeded rows would either inflate the metric (if untagged) or require the `metadata->>'source' = 'seed'` exclusion to work perfectly across every query path. Cleaner to start empty and let real flows populate. If demo data is needed for design partner onboarding, write a separate `scripts/demo-seed-deal-engagement.ts` that runs on demand against a named demo tenant only — never via `prisma migrate seed`.

### Files to create

| File | Purpose |
|------|---------|
| `packages/api/src/services/engagement-service.ts` | **NEW** Prisma-backed Engagement service. Replaces dead `engagement-logger.ts`. Public API (3 methods, narrow surface): |

**Idempotency contract:** All writes accept an optional `correlationId`; if provided and a row already exists with that value, the write is a no-op (return existing row). This makes Pub/Sub redelivery and handler retries safe by construction. Recommended `correlationId` sources: Resend message id for inbound-derived engagements, decision id for threshold-gate-derived deals, downstream agent action id for agent-emitted engagements.

**Service expressed as module-scoped functions** to match sibling-service convention in `packages/api/src/services/` (e.g., `agentic-tools.ts`, `threshold-gate.ts`). The 3-method API contract + `correlationId` idempotency from prior PRD revisions is preserved verbatim — only the shape adapts. Prisma types are imported from `@prisma/client` directly (the canonical pattern across `apps/api/src/router.ts:4` and the rest of the repo; `@growth/db` alias is not wired — see CLAUDE.md gotcha #2).

```ts
// packages/api/src/services/engagement-service.ts (NEW)

import type { Engagement, PrismaClient, SignalClass } from "@prisma/client";

export interface EngagementInput {
  tenantId: string;
  contactId: string;
  engagementType: string;
  channel?: string | null;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
  /** Optional natural-key dedup token. If provided and a row with this
   *  correlationId already exists, the write is a no-op (returns the
   *  existing row). Pub/Sub redelivery + handler retries safe by
   *  construction. */
  correlationId?: string;
}

export async function logEngagement(
  prisma: PrismaClient,
  input: EngagementInput,
): Promise<Engagement> {
  if (input.correlationId) {
    const existing = await prisma.engagement.findUnique({
      where: { correlationId: input.correlationId },
    });
    if (existing) return existing;
  }

  return prisma.engagement.create({
    data: {
      tenantId: input.tenantId,
      contactId: input.contactId,
      engagementType: input.engagementType,
      signalClass: classifySignal(input.engagementType),
      channel: input.channel ?? null,
      occurredAt: input.occurredAt,
      metadata: (input.metadata ?? {}) as object,
      ...(input.correlationId && { correlationId: input.correlationId }),
    },
  });
}

export async function listEngagementsForContact(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  opts?: { since?: Date; limit?: number },
): Promise<Engagement[]> {
  return prisma.engagement.findMany({
    where: {
      tenantId,
      contactId,
      ...(opts?.since && { occurredAt: { gte: opts.since } }),
    },
    orderBy: { occurredAt: "desc" },
    take: opts?.limit ?? 100,
  });
}

export async function listEngagementsSinceForLearning(
  prisma: PrismaClient,
  after: Date,
  limit = 1000,
): Promise<Engagement[]> {
  return prisma.engagement.findMany({
    where: { occurredAt: { gte: after } },
    orderBy: { occurredAt: "asc" },
    take: limit,
  });
}

function classifySignal(engagementType: string): SignalClass {
  const positive = new Set([
    "email_open",
    "email_click",
    "email_reply",
    "form_submit",
  ]);
  const negative = new Set([
    "email_bounce",
    "email_unsubscribe",
    "contact_optout",
  ]);
  if (positive.has(engagementType)) return "positive" as SignalClass;
  if (negative.has(engagementType)) return "negative" as SignalClass;
  return "neutral" as SignalClass;
}
```

### File to delete (sibling PR — recommended NOT bundled with Phase 1)

- `packages/api/src/services/engagement-logger.ts` (~430 LoC)
- Bundle with this PR: ❌ would expand Phase 1 scope; per `feedback_fix_exposes_next_error` the cohort-shrinking deletion is a **separate ticket**

---

## 5. Out of scope (explicit non-goals)

- **Lead/Contact split** (Phase 3 territory) — KAN-700 documented "Lead == Contact" as a deliberate decision; reopening is a product call, not a schema-audit follow-up
- **MicroObjective reparenting** (Pipeline → Objective) — Phase 2 scope; touches `PipelineMicroObjective` join table + `message-composer.ts:88-117` runtime consumer
- **Vestigial JSON column drops** (`Objective.subObjectives`, `ContactState.subObjectives`, `Contact.microObjectiveProgress`) — empirically confirmed safe-to-drop in audit pass, but defer to Phase 2 schema cleanup migration
- **`ContactState` table drop** (entire table is empty + unwritten) — Phase 2 cleanup
- **18-decisions / 0-actions investigation** — Decision→Action emission path may be broken in production; separate audit ticket below
- **AI normalization layer PRD** — depends on this PRD landing first; separate document
- **Engagement vocabulary refactor** (3-taxonomy from KAN-749) — defer to KAN-763 Phase C, gated on KAN-768 typed telemetry per `decision_kan_749_mvp_shape_rationale`
- **Dead-code deletions** (`engagement-logger.ts`, `onboarding-wizard.ts`) — sibling PR, KAN-INBOX-engagement-deadcode-deletion below

---

## 6. Acceptance criteria

- [ ] `prisma migrate dev --name add_deal_engagement_kan_786` (KAN-786 = Sprint 6 impl ticket) generates migration; CI green; `prisma migrate deploy` lands cleanly in staging then prod via the deploy-api.yml path-gated step (per `reference_schema_pr_ci_migrate_step`)
- [ ] `Deal` model exists with the exact schema in §3; `DealStatus` enum present
- [ ] `Engagement` model exists with the exact schema in §3; `SignalClass` enum present
- [ ] `Tenant` and `Contact` relations updated; Prisma client regenerated; `enum-drift.test.ts` PAIRS extended for the 2 new enums (per `reference_enum_drift_pairs_discipline`)
- [ ] `packages/api/src/services/threshold-gate.ts` inserts a `Deal` row on `transition_to_closed_won` / `transition_to_closed_lost` (unit test in same PR, integration test on the threshold-gate flow)
- [ ] `packages/api/src/services/engagement-service.ts` is created; `engagement-service.test.ts` covers the 3 methods
- [ ] `packages/api/src/services/agentic-tools.ts` emits an `Engagement` row on action dispatch (unit test asserting Prisma engagement.create called; e2e: trigger one decision via existing decision-engine integration test, observe one `Engagement` row land)
- [ ] `behavioral-learner.ts` either reads from the `engagement` table directly OR subscribes to `growth.engagement.logged` with a sibling Engagement-persistence subscriber — **decision documented in PR description with trade-off** (see §9 below)
- [ ] **Empirical end-of-sprint smoke (load-bearing per `feedback_kan_745_cost_observability_shipped`):** at least 1 real `Deal` row and 1 real `Engagement` row exist in production; verification query from §2 returns `real_n >= 1` for both
- [ ] **Track A regression check:** After Phase 1 deploy, re-run the 4-query verification matrix from yesterday's Track A close-out. All four must pass before Phase 1 is declared shipped — same matrix that closed Track A; reusing it ensures Phase 1's schema additions don't regress the producer→consumer chain.
  1. **growth-api consumer log:** `gcloud run services logs read growth-api --region us-central1 --limit=50 | grep -E "lead-received-push|assigned"` — expect a fresh `assigned contactId=... tenantId=... mode=unassigned` line for the smoke email sent post-deploy
  2. **Pub/Sub publish count:** `gcloud pubsub topics describe lead.received --format='value(name)'` plus a count check on the subscription metric — expect monotonic increment vs. pre-deploy baseline
  3. **`lead_inbox_events` row:** `SELECT id, status, resend_email_id, created_at FROM lead_inbox_events ORDER BY created_at DESC LIMIT 1;` — expect new row with `status='accepted'` and the smoke email's Resend message id (note: success-class status string is `accepted`, verified empirically yesterday)
  4. **Contact created:** `SELECT id, email, tenant_id, created_at FROM contacts WHERE created_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC;` — expect the smoke sender's email present (or dedup hit on existing contact, which is also valid)

---

## 7. Doctrine check (growth-product-owner alignment)

- [x] **Does not introduce configuration complexity** — pure schema + service additions. No new tenant-config knobs. No new env vars. No new Pub/Sub topics (reuses existing `growth.engagement.logged` if §9 decision keeps the subscriber pattern).
- [x] **AI proposes, human validates** — `Engagement` rows are observed *output* of AI agent decisions and contact touchpoints, not user-configured signals. `Deal` rows are observed *output* of stage transitions that themselves go through threshold-gate + (in agentic mode) the auto-approve matrix. Human validation gates remain at the action-dispatch layer where they already exist.
- [x] **Generates data that improves future decisions** — `Engagement` is the canonical input to the Learning System per growth doctrine. `Deal.status=closed_won/lost` rows feed `Outcome` (currently 0 rows; Phase 1 closes the producer side of that pipeline).

---

## 8. Dependencies + sequencing

**Blocked by:** nothing — pure greenfield additions, zero data migration risk (empirical confirmation: `objectives`=0, `contact_states`=0, `outcomes`=0, `actions`=0 in prod; reshape freedom).

**Blocks:**
- AI normalization layer PRD (needs Lead/Engagement before it can route normalized leads through learning loop)
- Phase 2 schema cleanup PRD (drops vestigial JSON columns + reparents MicroObjective; some readers in Phase 1 may need to backfill from MicroObjective table — coordinate timing)
- Future closed-won revenue reporting

**Sibling work (parallelizable, separate PRs):**
- KAN-INBOX-engagement-deadcode-deletion (delete `engagement-logger.ts` + verify `onboarding-wizard.ts` then delete it too)
- Dead-code cohort-shrinking pattern continues per `feedback_first_cohort_shrinking_pr`

**Sprint placement:** Sprint 6 (next sprint after current Track A close).

**Smoke discipline (per `feedback_kan_745_cost_observability_shipped`):**
The empirical end-of-sprint smoke is the load-bearing proof — DO NOT close the ticket on merge alone. 4-distinct-config-gap discoveries on KAN-745 reinforce: Jira→Done only after deploy + smoke, not at merge time (`feedback_jira_done_transition_premature_pre_deploy_gate`).

---

## 9. Open questions (do not block PRD; document decision in PR)

### Q9.1 — `behavioral-learner.ts` Pub/Sub vs direct Prisma read

The existing dead `engagement-logger.ts` emits to Pub/Sub topic `growth.engagement.logged`. `behavioral-learner.ts` is documented as a subscriber. But the topic has **never received a message in production** (the publisher is dead).

Two options for the new `EngagementService.logEngagement` path:

- **(a) Direct Prisma write only.** `behavioral-learner.ts` reads from the `engagement` table on a schedule via `listSinceForLearning(after)`. Simpler, fewer moving parts, no topic to provision.
- **(b) Prisma write + Pub/Sub publish (sibling subscribers).** `EngagementService.logEngagement` writes to Prisma AND publishes to `growth.engagement.logged`. `behavioral-learner.ts` subscribes for real-time updates. Other subscribers can fan out (e.g., real-time dashboard counters). Adds a topic to provision per `feedback_pubsub_route_registration_vs_subscription_config` — requires real-delivery smoke before declaring wired (`feedback_oidc_audience_smoke_test_required`).

**Recommendation: start with (a).** Lower configuration surface, cleaner Phase 1 scope, no new topic provisioning. Migrate to (b) only if/when real-time learning loop SLAs require it. Document the choice + reasoning in the PR description.

### Q9.2 — `18 decisions / 0 actions` divergence

Production has 18 `decisions` rows but 0 `actions` rows. Three hypotheses:
- (a) Shadow mode: agentic decisions persisted to `AgenticShadowDecision` instead of emitting `Action`s
- (b) Action dispatch path is broken — KAN-689 cohort suspect (`router.ts:661,689` Objective writes have schema-drift-broken field names; similar fragility may exist in the action-emit path)
- (c) Decisions exist but the threshold gate filtered all of them below dispatch threshold

**Out of Phase 1 scope.** File as separate audit ticket (KAN-AUDIT-decision-action-chain-divergence below). Does NOT block this PRD because Phase 1's `Engagement` writer hooks into `agentic-tools.ts` upstream of any action dispatch — even if dispatch is broken, the Engagement row will still land at decision time.

### Q9.3 — `Deal.value` source

`threshold-gate.ts` close transitions don't currently carry a `value` payload. Options:
- (a) Leave `Deal.value` null on insert; populate later via a separate `updateDealValue` mutation
- (b) Source from `Contact.metadata` or pipeline-stage entry actions if present
- (c) Require value in the close-transition action payload as a new schema field

**Phase 1 recommendation (revised after sub-cohort (c) pre-flight #4): hardcode `value = null` and `currency = "USD"` for every Deal write.** Empirical schema check (2026-05-03) found `Contact.metadata` field doesn't exist — Contact has `externalIds Json` (CRM IDs, semantically wrong) and `microObjectiveProgress Json` (KAN-700 MO tracking, semantically wrong) but no generic metadata blob. Phase 1 success metric in §2 (non-zero Deal rows in prod) is met without value enrichment. Value-enrichment product decision deferred to **[KAN-790](https://axisone-team.atlassian.net/browse/KAN-790)** — options include adding typed `Contact.dealValue Decimal` + `Contact.dealCurrency Varchar(3)` columns, adding a `Contact.metadata Json` field, sourcing from `Decision.metadata`, or adding override inputs at decision-time. Per `feedback_prd_assumed_infrastructure_check_kan_786` (anchor #2): when an assumed field doesn't exist, defer to defaults + file enrichment follow-up — don't silently bind to a semantically-wrong existing field.

---

## Empirical anchors (audit-first carry-forward proof)

These row counts and grep results are the empirical foundation for §1 and the "out of scope" rationale. Pulled 2026-05-02 from prod via Cloud SQL Auth Proxy + ADC after Track A close:

```
table                       rows
-------------------------   ----
tenants                        1
contacts                       7
objectives                     0   ← greenfield reshape freedom
micro_objectives              10
pipeline_micro_objectives      1
contact_states                 0   ← entire table unused
decisions                     18
actions                        0   ← Q9.2 audit
outcomes                       0   ← Phase 1 closes producer side
lead_stage_history             0
pipelines                      1
lead_inbox_events              6
```

Key non-empirical claims and their grep-confirmed sources:
- "Lead == Contact" → `packages/db/prisma/schema.prisma:169-170, 724` (in-code comments)
- "engagement-logger has zero imports" → `grep -rn "from.*engagement-logger"` returns 0 rows outside the file itself
- "InMemoryEngagementStore is the only impl" → `grep -rn "implements EngagementStore"` returns exactly 1 result (engagement-logger.ts:330)
- "ContactState never written" → `grep -rEn "prisma\.contactState\.(create|update|upsert)"` returns 0 rows outside tests/dist
- "Contact.microObjectiveProgress never written" → all grep hits are reads/selects/type signatures; no write site

---

## Reviewers

- Drafted: Claude Code, audit-first
- Pending: Fred (product owner) — review for doctrine alignment + sprint sequencing
- Tagged for technical review on PR open: TBD

---

*PRD ends here. No code changes shipped. Ready for review.*
