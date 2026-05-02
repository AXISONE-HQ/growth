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

The current data model collapses three distinct product concepts into one structural shape, blocking the Learning Loop from observing real outcomes:

**(a) Lead == Contact (KAN-700 deliberate convention).**
- `LeadStageHistory.leadId` FKs to `contacts.id`; in-code comments confirm "Lead == Contact in this schema"
- `Contact.currentStageId` is the **only "deal-like" signal today** — when a stage transition fires `transition_to_closed_won`, the contact's pipeline stage flips to a terminal stage, but **no row is created** to represent the closed-won opportunity
- Empirically: `lead_stage_history` is **0 rows** in production; not a single transition has been recorded end-to-end

**(b) Engagement is event-only and unwired.**
- `engagement-logger.ts` defines an `EngagementStore` interface but **the only impl is `InMemoryEngagementStore`** (in-process array, zero persistence)
- The module's Express route (`createEngagementLoggerRouter`) is **never mounted** — apps/api uses Hono/tRPC, not Express
- `engagement-logger.ts` has **zero imports anywhere** in `apps/` or `packages/` (excluding tests/dist)
- Pub/Sub topic `growth.engagement.logged` is referenced by `behavioral-learner.ts` as a subscriber, but **nothing publishes to it**
- Net: every engagement signal in production is lost; the Learning Service has no input

**(c) Both gaps block the Brain's learning loop.**
- The AI normalization layer needs Lead-shaped + Engagement-shaped rows to route through the Learning System's per-contact-per-MO progress tracking
- Without Deal: closed-won/lost outcomes don't feed the `Outcome` model; learning loop never observes a real revenue signal
- Without Engagement: every AI agent action (`agentic-tools.ts`) and every contact touchpoint is invisible to the Brain's behavioral model
- Empirically: `outcomes` table is **0 rows**; the Learning Loop has produced exactly zero observations in production

---

## 2. Desired outcome

**Measurable result + tier impact:**

- **Add `Deal` model** → tenants can query closed-won opportunities, report revenue-class metrics (replacing the `orders_placed` `TargetMetric` enum value's purely-aggregate read path), feed the `Outcome` learning system with real terminal events
- **Add `Engagement` model** → every AI agent action emit and every contact touchpoint becomes a queryable row, enabling per-contact-per-MO progress tracking and closing the input gap to `behavioral-learner.ts`
- **Replace dead `engagement-logger.ts`** → ~430 LoC of unreachable code retired; sibling cohort-shrinking opportunity per `feedback_first_cohort_shrinking_pr` and `feedback_kan_762_csv_import_dead_code_deletion`

**Success metric (end of Sprint 6):**

> Both `deals` and `engagements` tables hold non-zero rows in production, populated by **real ingestion** (ThresholdGate close transitions + AI agent action emits), **not synthetic seeds**.

Verification query at sprint close:
```sql
SELECT 'deals' AS t, COUNT(*) AS n,
       COUNT(*) FILTER (WHERE metadata->>'source' IS DISTINCT FROM 'seed') AS real_n
FROM deals
UNION ALL
SELECT 'engagements' AS t, COUNT(*) AS n,
       COUNT(*) FILTER (WHERE metadata->>'source' IS DISTINCT FROM 'seed') AS real_n
FROM engagements;
```

> **Why `IS DISTINCT FROM` not `!=`:** `metadata->>'source'` returns NULL when the `source` key is absent, and `NULL != 'seed'` evaluates to NULL (not TRUE) — every untagged real row would be silently dropped from the count. `IS DISTINCT FROM` treats NULL as a real value and returns TRUE.
Pass criteria: `real_n >= 1` for both rows.

---

## 3. Schema changes

Verbatim Prisma model — to be appended to `packages/db/prisma/schema.prisma`:

```prisma
// ─────────────────────────────────────────────
// PHASE 1 — Deal + Engagement (Sprint 6)
// ─────────────────────────────────────────────

model Deal {
  id            String     @id @default(cuid())
  tenantId      String     @map("tenant_id")
  contactId     String     @map("contact_id")
  correlationId String?    @unique @map("correlation_id")
  value         Decimal?   @db.Decimal(12, 2)
  currency  String     @default("USD") @db.VarChar(3)
  status    DealStatus @default(open)
  closedAt  DateTime?  @map("closed_at")
  metadata  Json       @default("{}")
  createdAt DateTime   @default(now()) @map("created_at")
  updatedAt DateTime   @updatedAt @map("updated_at")

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  contact Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)

  @@index([tenantId, status])
  @@index([tenantId, contactId])
  @@map("deals")
}

enum DealStatus {
  open
  closed_won
  closed_lost

  @@map("deal_status")
}

model Engagement {
  id             String      @id @default(cuid())
  tenantId       String      @map("tenant_id")
  contactId      String      @map("contact_id")
  correlationId  String?     @unique @map("correlation_id")
  engagementType String      @map("engagement_type")
  signalClass    SignalClass @map("signal_class")
  channel        String?
  metadata       Json        @default("{}")
  occurredAt     DateTime    @map("occurred_at")
  createdAt      DateTime    @default(now()) @map("created_at")

  tenant  Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  contact Contact @relation(fields: [contactId], references: [id], onDelete: Cascade)

  @@index([tenantId, contactId, occurredAt])
  @@index([tenantId, engagementType])
  @@map("engagements")
}

enum SignalClass {
  positive
  negative
  neutral

  @@map("signal_class")
}
```

Plus relations to add on existing `Tenant` and `Contact` models:
```prisma
// In model Tenant {} relations block:
deals       Deal[]
engagements Engagement[]

// In model Contact {} relations block:
deals       Deal[]
engagements Engagement[]
```

**Lead vs Contact note:**
Both models attach to `Contact`, not a separate `Lead`, because **Lead == Contact in current schema (KAN-700 deliberate convention)**. Phase 3 (Lead split) will rebind these. The migration is non-breaking either way — the relation can be moved later by renaming the FK column from `contact_id` → `lead_id`, no column-shape change.

**Cuid vs Uuid choice:**
`cuid()` matches the recently-added `ActionOutcome` model (line 421 of schema.prisma); both are append-mostly time-ordered tables benefitting from cuid's lexicographic sortability. Other Phase-1-adjacent models use `uuid()`; this is acceptable schema-level inconsistency, narrowly scoped.

---

## 4. Code changes

### Files to edit

| File | Change |
|------|--------|
| `packages/db/prisma/schema.prisma` | New models + enums + relations on Tenant/Contact (Section 3 above). New migration generated via `prisma migrate dev --name add_deal_engagement`. CI runs `prisma migrate deploy` per `reference_schema_pr_ci_migrate_step` discipline. |
| `apps/api/src/services/threshold-gate.ts:36-37,92-97` | Extend `transition_to_closed_won` and `transition_to_closed_lost` action handlers to insert a `Deal` row (status=`closed_won`/`closed_lost`, `closedAt=now()`, value/currency from action metadata if present, else null) **alongside** the existing Pipeline stage transition. Idempotent on re-fire (use `(tenantId, contactId, status='closed_won')` upsert key derivation, not a hard UNIQUE — reps can be earned multiple times across deal cycles). |
| `apps/api/src/services/behavioral-learner.ts:9` | (Decision needed — see §9 Open questions) replace Pub/Sub subscription to `growth.engagement.logged` with direct Prisma reads from new `engagement` table, OR keep Pub/Sub and add Engagement persistence as a sibling subscriber. Recommend the latter for now (preserves existing decoupling) but PR author can swap. |
| `packages/api/src/services/agentic-tools.ts` | Wire AI agent action emit path to call `engagementService.logEngagement()`. Every action dispatched becomes one `Engagement` row with `engagementType` derived from `actionType` (e.g., `email_send` → `engagementType="email_send"`, signalClass=`neutral`; opens/clicks/replies arrive later from webhooks). Use the 3-taxonomy guidance from `decision_kan_749_mvp_shape_rationale` — pass `actionType` AS-IS, defer vocab refactor. |

### Files to create

| File | Purpose |
|------|---------|
| `apps/api/src/services/engagement-service.ts` | **NEW** Prisma-backed Engagement service. Replaces dead `engagement-logger.ts`. Public API (3 methods, narrow surface): |

**Idempotency contract:** All writes accept an optional `correlationId`; if provided and a row already exists with that value, the write is a no-op (return existing row). This makes Pub/Sub redelivery and handler retries safe by construction. Recommended `correlationId` sources: Resend message id for inbound-derived engagements, decision id for threshold-gate-derived deals, downstream agent action id for agent-emitted engagements.

```ts
// apps/api/src/services/engagement-service.ts (NEW)

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

export class EngagementService {
  constructor(private prisma: PrismaClient) {}

  async logEngagement(input: EngagementInput): Promise<Engagement> {
    return this.prisma.engagement.create({
      data: {
        tenantId: input.tenantId,
        contactId: input.contactId,
        engagementType: input.engagementType,
        signalClass: classifySignal(input.engagementType), // reuse logic from engagement-logger.ts:164
        channel: input.channel ?? null,
        occurredAt: input.occurredAt,
        metadata: input.metadata ?? {},
      },
    });
  }

  async listForContact(
    tenantId: string,
    contactId: string,
    opts?: { since?: Date; limit?: number }
  ): Promise<Engagement[]> {
    return this.prisma.engagement.findMany({
      where: {
        tenantId,
        contactId,
        ...(opts?.since && { occurredAt: { gte: opts.since } }),
      },
      orderBy: { occurredAt: 'desc' },
      take: opts?.limit ?? 100,
    });
  }

  async listSinceForLearning(after: Date, limit = 1000): Promise<Engagement[]> {
    return this.prisma.engagement.findMany({
      where: { occurredAt: { gte: after } },
      orderBy: { occurredAt: 'asc' },
      take: limit,
    });
  }
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

- [ ] `prisma migrate dev --name add_deal_engagement` generates migration; CI green; `prisma migrate deploy` lands cleanly in staging then prod via the deploy-api.yml path-gated step (per `reference_schema_pr_ci_migrate_step`)
- [ ] `Deal` model exists with the exact schema in §3; `DealStatus` enum present
- [ ] `Engagement` model exists with the exact schema in §3; `SignalClass` enum present
- [ ] `Tenant` and `Contact` relations updated; Prisma client regenerated; `enum-drift.test.ts` PAIRS extended for the 2 new enums (per `reference_enum_drift_pairs_discipline`)
- [ ] `apps/api/src/services/threshold-gate.ts` inserts a `Deal` row on `transition_to_closed_won` / `transition_to_closed_lost` (unit test in same PR, integration test on the threshold-gate flow)
- [ ] `apps/api/src/services/engagement-service.ts` is created; `engagement-service.test.ts` covers the 3 methods
- [ ] `apps/api/src/services/agentic-tools.ts` emits an `Engagement` row on action dispatch (unit test asserting Prisma engagement.create called; e2e: trigger one decision via existing decision-engine integration test, observe one `Engagement` row land)
- [ ] `behavioral-learner.ts` either reads from the `engagement` table directly OR subscribes to `growth.engagement.logged` with a sibling Engagement-persistence subscriber — **decision documented in PR description with trade-off** (see §9 below)
- [ ] **Empirical end-of-sprint smoke (load-bearing per `feedback_kan_745_cost_observability_shipped`):** at least 1 real `Deal` row and 1 real `Engagement` row exist in production; verification query from §2 returns `real_n >= 1` for both
- [ ] No regression on `lead_inbox_events` flow (KAN-741 Track A close validation matrix re-runs green)

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

**Recommendation: (a).** Phase 1 establishes the `Deal` row; value enrichment is a Phase 1.1 follow-up that doesn't block the schema.

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
