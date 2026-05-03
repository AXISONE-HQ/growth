# Phase 1 — Add Deal + Engagement entities to the data model

| Field | Value |
|-------|-------|
| **Status** | Draft (Phase 1 of 5-phase roadmap; pivoted 2026-05-03) |
| **Priority** | P1 |
| **Loop Phase** | Cross-cutting (Ingest + Understand + Execute) |
| **Tier** | All |
| **Author** | drafted 2026-05-02; pivoted 2026-05-03 to Deal-as-lifecycle per architectural review |
| **Audit-first state** | All schema/code claims grounded in grep + prod row counts (see "Empirical anchors" below) |
| **Sprint 6 epics** | KAN-791 (schema pivot) + KAN-792 (AI Lead Normalizer) + KAN-793 (Track A → Deal integration) |

---

## 10. Architectural Context

> **Note:** Section is numbered §10 (chronologically the 10th section to be added during the 2026-05-03 pivot) but positioned at the top so future readers see the roadmap framing before diving into the implementation detail. The original §1-§9 reading order is preserved below.

Phase 1 sits inside a **5-phase / 20-epic roadmap** committed 2026-05-03. The full roadmap and per-epic specs live at the Confluence page below; this PRD covers Phase 1 only.

📄 **Confluence roadmap:** [SD/4227074 — 5-phase roadmap (KAN-791 through KAN-810)](https://axisone-team.atlassian.net/wiki/spaces/SD/pages/4227074)

### The 5 phases (one-line summary each)

1. **Phase 1 (THIS PRD) — Lifecycle + Intake** (Sprint 6, KAN-791/792/793). Make `Deal` the lifecycle entity; add AI Lead Normalizer for inbound; wire Track A → Deal at intake. Sub-cohorts (a)+(b) shipped foundation under KAN-786 (Deal/Engagement base tables + EngagementService); pivot extends, doesn't rebuild.
2. **Phase 2 — Brain + Stages Evolution** (Sprint 7, KAN-794/795/796). Brain Service consumes the lifecycle data trail; AI Pipeline Routing Logic (replaces hardcoded `defaultAssignmentPipelineId`); AI Stages Evolution Logic (consumes `followUpCadence`).
3. **Phase 3 — Communication Engine** (Sprint 8, KAN-797/798). AI Communication Shaper (tone/channel/timing); Send Policy (rate limits, quiet hours, suppression).
4. **Phase 4 — Multi-channel + Connectors** (Sprint 9+, KAN-799 through KAN-805). Inbound/outbound for SMS, WhatsApp, voice; HubSpot/Meta Lead Ads integrations.
5. **Phase 5 — Cost & Observability** (Sprint 10+, KAN-806 through KAN-810). LLM cost tier optimization (KAN-806); telemetry roll-up; per-tenant dashboards; quarterly model-pricing refresh discipline (per `feedback_model_pricing_refresh_discipline`).

### How Phase 1 fits

Phase 1 is **the data-foundation phase**. It establishes the row shapes (Deal as lifecycle, Engagement persisted with `dealId`, DealStageHistory transitions, StageOutcomeType terminals) that every subsequent phase consumes. Phase 2 reads the rows; Phase 3 acts on them; Phase 4 widens the producer side; Phase 5 instruments the cost side.

Concretely: Phase 2's Brain Service can't exist without Phase 1's Engagement+Deal data; Phase 3's Communication Shaper can't shape without Phase 2's Brain output; Phase 4's connectors all write through the same Phase 1 schema. The dependency chain runs strictly forward.

### What's IN Phase 1 vs OUT (full list in §5)

**IN Phase 1:** lifecycle schema, AI Lead Normalizer (MVP, single source = email), Track A integration. Phase 1 ships with:
- Stage transitions written by simple writers (no AI orchestration yet — Phase 2 KAN-796)
- Pipeline routing hardcoded to `Tenant.defaultAssignmentPipelineId` (no AI routing yet — Phase 2 KAN-795)
- `Deal.value` defaults to 0 (no enrichment yet — KAN-790 deferred indefinitely until product decision)
- `Stage.followUpCadence` stored but not consumed (Phase 2 KAN-796)
- Engagement signals from inbound + agent emit (Phase 4 widens to webhooks for opens/clicks/replies/bounces)

**OUT of Phase 1 (Phase 2+):** Brain Service, AI Pipeline routing, AI Stages Evolution, AI Communication Shaper, Send Policy, multi-channel connectors, cost optimization. See §5 for the full deferred list.

### Forward-compatibility notes

Sub-cohort (a) (KAN-786 commits a37d3c3 + 759d0ae merged via PR #91 work) shipped Deal + Engagement base tables + SignalClass enum + enum-drift PAIRS extension. KAN-791 EXTENDS those tables (adds columns, makes `Engagement.dealId` required, drops the early `DealStatus` enum + `Deal.closedAt`) — does NOT rebuild from scratch. Sub-cohort (b) (commit d6e8e16) shipped EngagementService at `packages/api/src/services/engagement-service.ts`; KAN-791 makes `dealId` REQUIRED in `EngagementInput` (additive change to the shape).

Sub-cohort (c)'s WIP commits (b51a48c + 93b6dee on `feat/kan-786-phase-1-deal-engagement`) — the orchestrator Deal-write hook for closed_won/_lost — are **CANCELLED by the pivot**. Those commits stay in branch history (audit trail of what was attempted) but never merge. The pivot's intake-side Deal creation (KAN-793) replaces the decision-side hook completely.

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
  // ... existing fields preserved (id, pipelineId, name, order, isInitial, isTerminal,
  // entryActions, transitionRules, autoApproveMatrix, createdAt, updatedAt) ...
  // NEW (KAN-791):
  outcomeType       StageOutcomeType @default(open) @map("outcome_type")
  // NEW (KAN-791): per-tenant per-Pipeline per-Stage follow-up cadence config.
  // Stored in Phase 1; consumer ships in Phase 2 KAN-796 (AI Stages Evolution Logic).
  // Default platform cadence per Stage shipped via the lazy-bootstrap helper (see §4 KAN-793).
  followUpCadence   Json             @default("{}") @map("follow_up_cadence")
  // NEW relations (KAN-791):
  dealsCurrent      Deal[]             @relation("DealCurrentStage")
  dealStageFromHist DealStageHistory[] @relation("DealStageFromHistory")
  dealStageToHist   DealStageHistory[] @relation("DealStageToHistory")

  // KAN-791 INVARIANT: at most one isInitial Stage per Pipeline.
  // Prisma's @@unique doesn't natively support partial indexes — append raw SQL
  // to the migration (the spurious-DROP workaround per KAN-787 already requires
  // manual migration.sql editing; same workflow):
  //
  //   CREATE UNIQUE INDEX stages_one_initial_per_pipeline_idx
  //     ON stages (pipeline_id) WHERE is_initial = true;
  //
  // Enforces the schema invariant the lazy-bootstrap helper (KAN-793,
  // ensureTenantHasDefaultPipeline) and the Track A consumer rely on. Schema
  // invariants beat runtime checks.
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
  /// Semantic descriptor — bounded set: 'normalizer' | 'agent' | 'human' | 'system' | 'rule'
  /// Stays human-readable for log/UI display + queryable as a category index.
  triggeredBy    String   @map("triggered_by")
  /// Typed FK populated only when the transition came from a Decision firing.
  /// Phase 2 KAN-796 (AI Stages Evolution Logic) emits decision-driven transitions
  /// at scale; Phase 1 transitions (Normalizer-driven) leave this null.
  /// `triggeredBy` is the descriptive category; `decisionId` is the precise FK.
  /// Both can coexist (e.g., triggeredBy='agent' + decisionId=<id> for agent-emitted
  /// decisions) or only one (e.g., triggeredBy='human' + decisionId=null for manual moves).
  decisionId     String?  @map("decision_id")
  metadata       Json     @default("{}")

  deal      Deal      @relation(fields: [dealId], references: [id], onDelete: Cascade)
  fromStage Stage?    @relation("DealStageFromHistory", fields: [fromStageId], references: [id], onDelete: SetNull)
  toStage   Stage     @relation("DealStageToHistory", fields: [toStageId], references: [id], onDelete: Restrict)
  decision  Decision? @relation(fields: [decisionId], references: [id], onDelete: SetNull)

  @@index([dealId, transitionedAt])
  @@index([toStageId])
  @@index([decisionId])
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

Phase 1 splits across **three Sprint 6 epics**, each with its own implementation ticket. Sub-cohort (a) shipped foundation (Deal + Engagement base tables + enum-drift PAIRS for SignalClass) under the original KAN-786 scope; sub-cohort (b) shipped EngagementService at `packages/api/src/services/engagement-service.ts`. KAN-791/792/793 below extend that foundation, don't rebuild it.

### KAN-791 — Deal-as-Lifecycle schema pivot

**Branch convention:** `feat/kan-791-schema-pivot` (off main, after sub-cohorts (a)+(b) merge).

| File | Change |
|------|--------|
| `packages/db/prisma/schema.prisma` | Apply §3 changes: extend `Deal` with `pipelineId`/`currentStageId`/`enteredStageAt`/`microObjectiveProgress` columns; switch `value` to `Decimal @default(0)`; drop `status DealStatus` + `closedAt`; add `outcomeType StageOutcomeType` + `followUpCadence Json` to `Stage`; create `DealStageHistory` model; make `Engagement.dealId` REQUIRED. New migration via `prisma migrate dev --name kan_791_deal_lifecycle_pivot`. **MUST strip the spurious `DROP INDEX "knowledge_chunks_embedding_hnsw_idx"` line from the generated SQL** before commit per KAN-787. CI runs `prisma migrate deploy`. |
| `packages/db/prisma/schema.prisma` (cleanup) | Mark `Contact.currentStageId`, `Contact.currentPipelineId`, `Contact.microObjectiveProgress` for Phase 2 drop (keep columns in Phase 1 for read-shim during transition). Drop `lead_stage_history` table (0 prod rows). |
| `packages/api/src/services/engagement-service.ts` | Add `dealId: string` REQUIRED field to `EngagementInput`; pass through to `prisma.engagement.create`. Update `engagement-service.test.ts` — every test fixture now provides `dealId`; tests that previously created Engagement without one must be revised (sub-cohort (b) pattern, just add `dealId`). |
| `packages/api/src/services/run-decision-for-contact.ts` | **Remove `maybeWritePhase1Deal` helper + 2 call sites** (sub-cohort (c) work-in-progress on `feat/kan-786` branch — orchestrator hook approach is **cancelled** per pivot). Deal lifecycle now starts at Track A intake (KAN-793), not at decision approval. KAN-789 is also superseded — Stage transitions write `DealStageHistory` rows directly via simple writers (Phase 2's KAN-796 adds AI; Phase 1 ships the writer infrastructure only). |
| Cross-codebase reader migration | Identify all read sites via `grep -rn "currentStageId\|currentPipelineId\|microObjectiveProgress" packages/api/src/ apps/`. For each: refactor to read from `Deal` if a Deal exists for the contact, else fall back to the deprecated Contact column (read-shim). If a site can't be cleanly migrated, document why in the PR description and defer to a per-site follow-up ticket. Hot consumers: `message-composer.ts:88-117` (live runtime), `agentic-tools.ts:105,149,367` (5 read sites), `context-assembler.ts:537,586` (2 read sites). |
| `enum-drift.test.ts` PAIRS | Add `[StageOutcomeType, "stage_outcome_type"]` per `reference_enum_drift_pairs_discipline`. (DealStatus enum is REMOVED in this migration; remove its PAIRS entry too — the enum-drift test must reflect the new schema.) |

### KAN-792 — AI Lead Normalizer (MVP)

**Branch convention:** `feat/kan-792-lead-normalizer` (off main, can branch in parallel with KAN-791 if schema is mergeable).

| File | Change |
|------|--------|
| `packages/api/src/services/lead-normalizer.ts` | **NEW** module-scoped functions for parsing inbound and producing structured `{ contact: ContactInput, deal: DealInput, inboundEngagement: EngagementInput }`. Source-aware: V1 ships an email pre-parser (extracts `from_address`/`subject`/`body_preview` → structured fields like `companyName`, `role`, `intent`, `dealStageSignal`), then runs an Anthropic Claude Sonnet extraction pass for the unstructured-text portion. Module-scope per sibling-service convention (matches `engagement-service.ts` from sub-cohort (b), `agentic-tools.ts`, `threshold-gate.ts`). Exports: `normalizeInboundEmail(input)`, `normalizeInbound(source, input)` (extensible to non-email sources later). |
| `packages/api/src/services/__tests__/lead-normalizer.test.ts` | **NEW** vitest tests with: (a) sample email fixtures (Formspree-style, hotmail real-email, plain text inquiry), (b) mocked Anthropic SDK responses, (c) source pre-parser tests independent of the AI step, (d) failure-isolation: AI extraction failure produces a degraded-but-valid normalized output (fallback to pre-parser fields only). Per `feedback_prd_assumed_infrastructure_check_kan_786`, pre-flight verifies the Anthropic SDK is wired in this repo before writing code (likely already in `packages/api/src/services/llm-client.ts`; adapt to its existing client pattern). |

### KAN-793 — Track A Inbound → Deal integration

**Branch convention:** `feat/kan-793-track-a-deal-integration` (off main, depends on KAN-791 merged + KAN-792 merged).

| File | Change |
|------|--------|
| `apps/api/src/subscribers/lead-received-push.ts` (or the equivalent push-subscriber file from KAN-774) | After validating the `lead.received` event, call `normalizeInbound(...)` to produce `{ contact, deal, inboundEngagement }`. Replace the existing `assignLeadToPipeline` flow with: (1) upsert Contact, (2) resolve tenant's default Pipeline + its starting Stage (the Stage where `isInitial: true`), (3) create Deal with `pipelineId` + `currentStageId` set to the starting Stage + `correlationId = leadInboxEventId` (Resend message id; Pub/Sub redelivery safe), (4) create inbound `Engagement` with `dealId = deal.id`, `engagementType = 'lead_received'`, `signalClass = 'positive'`, `correlationId = leadInboxEventId + ":inbound"`, (5) write `DealStageHistory` entry with `fromStageId = null`, `toStageId = starting_stage.id`, `triggeredBy = 'normalizer'`. |
| `apps/connectors/src/webhooks/resend-inbound.ts` | No code change required at the connector layer — the existing Resend webhook publishes `lead.received` to Pub/Sub; the consumer above does the normalize+write. Connector stays thin. |
| `packages/api/src/services/lead-assignment.ts` (existing — `assignLeadToPipeline`) | Update or replace: assignment flow now operates on Deals (assigning a Deal to a pipeline), not on Contacts directly. Per the lifecycle pivot, "assignment" is "create Deal in starting Stage of routed Pipeline." Routing resolution chain: (1) try `Tenant.defaultAssignmentPipelineId`; (2) if NULL, try the tenant's only Pipeline if `findMany` returns exactly 1; (3) if still NULL, **lazy-bootstrap** the platform-default Pipeline via `ensureTenantHasDefaultPipeline(tenantId)` (see helper below). Phase 1 always succeeds in producing a Pipeline+Stage to route to — never drops the lead. Pipeline routing AI per KAN-795 supersedes in Phase 2. |

#### Lazy-bootstrap helper — `ensureTenantHasDefaultPipeline(tenantId)` (Q9.4 resolution, in KAN-793 scope)

When a Track A inbound fires for a tenant with **zero Pipelines** (or a NULL `defaultAssignmentPipelineId` + multiple/zero Pipelines making fallback ambiguous), the consumer auto-bootstraps a **platform-default Pipeline + 7 Stages** before writing the Deal. Idempotent: if the Pipeline already exists (lookup by `name = "Default Sales Pipeline"` + `tenantId`), return its id — no second bootstrap.

**Helper location:** Embed in the KAN-793 consumer for Phase 1 (`apps/api/src/subscribers/lead-received-push.ts` or sibling). Promote to a shared service in Phase 5 onboarding work (KAN-807 Tenant Onboarding Wizard).

**Platform-default Pipeline shape:**

| Pipeline name |
|---|
| `Default Sales Pipeline` |

**Platform-default Stages (created in order, with `followUpCadence` JSON shape per the KAN-796 consumer spec):**

| order | name | outcomeType | isInitial | isTerminal | followUpCadence (no_response_hours / max_attempts / stalled_after_days) |
|---|---|---|---|---|---|
| 0 | New | `open` | true | false | `{ "noResponseHours": 24, "maxAttempts": 4, "stalledAfterDays": 30 }` |
| 1 | Contacted | `open` | false | false | `{ "noResponseHours": 48, "maxAttempts": 4, "stalledAfterDays": 30 }` |
| 2 | Qualified | `open` | false | false | `{ "noResponseHours": 72, "maxAttempts": 4, "stalledAfterDays": 30 }` |
| 3 | Proposal Sent | `open` | false | false | `{ "noResponseHours": 168, "maxAttempts": 3, "stalledAfterDays": 30 }` |
| 4 | Negotiating | `open` | false | false | `{ "noResponseHours": 24, "maxAttempts": 6, "stalledAfterDays": 14 }` |
| 5 | Closed Won | `terminal_won` | false | true | `{}` (n/a — terminal stages don't have follow-up cadence) |
| 6 | Closed Lost | `terminal_lost` | false | true | `{}` (n/a) |

After bootstrap completes, also populate `Tenant.defaultAssignmentPipelineId` so subsequent leads route via path (1) without re-checking. Tenants can rename, reorder, add, or remove Stages once the Tenant Onboarding Wizard ships (KAN-807); until then this default works for any inbound.

**Idempotency guarantee:** the helper must be safe to call multiple times concurrently. Use a tenant-scoped advisory lock OR a `findFirst({ where: { tenantId, name: "Default Sales Pipeline" } })` check before the create — first writer wins, later writers find existing and return early.

### Seeds posture

**No seed data for `deals`, `engagements`, or `deal_stage_history` in `packages/db/prisma/seed.ts`.** The success metric in §2 requires REAL Track A traffic to count — seeded rows would inflate or require `metadata->>'source' = 'seed'` exclusion to work everywhere. Cleaner to start empty. If demo data is needed for design partner onboarding, write a separate `scripts/demo-seed-deal-engagement.ts` that runs on demand against a named demo tenant only — never via `prisma migrate seed`.

---

## 5. Out of scope (explicit non-goals)

**Phase 2+ epics deferred (KAN-794 onwards from the 5-phase / 20-epic roadmap — see §10):**

- **KAN-794 Brain Service** — read-side consumer of normalized Contact + Deal + Engagement rows; produces BrainSnapshot. Phase 1 just produces the rows; Brain doesn't exist yet.
- **KAN-795 AI Pipeline Routing Logic** — currently Phase 1 hardcodes "tenant's `defaultAssignmentPipelineId`" for routing every Deal. AI-based routing (which Pipeline best fits this Lead given the Deal/Contact/intent signals?) is Phase 2.
- **KAN-796 AI Stages Evolution Logic** — currently Phase 1 ships the `followUpCadence` Json column on Stage but doesn't act on it. The cadence consumer (cron-driven advancement of Deals through Stages based on signal patterns + cadence config) is Phase 2.
- **KAN-797 AI Communication Shaper** — picks tone/channel/timing for outbound based on Deal+Contact context. Phase 2.
- **KAN-798 Send Policy** — tenant-level send rate limits + quiet hours + suppression list. Phase 2.
- **KAN-799+ all Phase 3+ connectors** — multi-channel (SMS, WhatsApp, voice) inbound + outbound. Phase 3+.

**Phase 1 explicit simplifications (consumed by the Phase 2+ tickets above):**

- Stage transitions are written by **simple writer functions** (no AI yet) — the Normalizer writes the initial transition on intake; downstream stage moves come from human triggers or future automation
- Pipeline routing falls through 3 paths: `Tenant.defaultAssignmentPipelineId` → tenant's only Pipeline if exactly 1 → **lazy-bootstrap platform-default Pipeline** (per Q9.4 + §4 KAN-793 helper). Phase 1 always succeeds in producing a Pipeline+Stage; never drops the lead. AI routing per KAN-795 supersedes
- `Stage.followUpCadence` is **stored, not consumed** — the column exists so the schema is forward-compatible with KAN-796; Phase 1 doesn't read it
- `Deal.value` defaults to `0` — value enrichment from Contact metadata or upstream signals is **out of Phase 1 scope** (per KAN-790 deferral; revisit when first design partner needs value tracking)
- Stage transitions in Phase 1 happen ONLY at intake (Normalizer writes the `null → starting_stage` transition). No mid-lifecycle transitions are written by Phase 1 code; humans can transition via direct DB or upcoming UI; AI-driven advancement ships in KAN-796.

**Phase 2 reader-migration deferral list (sites that will NOT be migrated in KAN-791; deferred to the absorbing Phase 2 epic):**

The following Contact-lifecycle column reads stay reading from `Contact` via the read-shim during Phase 1. Migration to `Deal`-side reads happens in the Phase 2 epic that owns the consumer:

| Read site | Phase 2 epic that absorbs |
|---|---|
| `packages/api/src/services/message-composer.ts:88-117` (live runtime — reads `microObjectiveProgress` for outbound message context) | KAN-797 (AI Communication Shaper) — Shaper takes over message composition, will read from Deal directly |
| `packages/api/src/services/agentic-tools.ts:105,149,367` (5 read sites for agentic tool context) | KAN-794 (Brain Service) — Brain consumes Deal-shaped context; agentic tools become Brain-mediated |
| `packages/api/src/services/context-assembler.ts:537,586` (Brain-context assembly) | KAN-794 (Brain Service) — context-assembler becomes part of Brain Service or replaced |

**KAN-791 migrates ONLY the read sites that Phase 1 code paths exercise** (essentially: any read inside the new lead-normalizer + Track A consumer + EngagementService dealId-required paths). Other consumers stay reading from Contact via the read-shim. Per audit-first: less migration risk in Phase 1, clearer scope for Phase 2 epics.

**Already-superseded in the pivot:**

- The original sub-cohort (c) **orchestrator-hook approach** for closed_won/_lost Deal writes (was: write Deal at decision-approval) — replaced by lifecycle approach (Deal exists from intake; closed_won/_lost is a Stage transition). The work-in-progress on `feat/kan-786-phase-1-deal-engagement` (commits b51a48c + 93b6dee) is **cancelled** — preserved in branch history but not merged.
- **KAN-789** (transition_to_closed_won/_lost executors) — superseded. Stage transitions are now generic writes via DealStageHistory; specific action-type executors no longer needed. Close KAN-789 as obsolete in PR review.
- **KAN-785** (Phase 3 Lead/Contact split) — superseded by Deal-as-lifecycle. Lead lifecycle lives on Deal now; Contact stays as the person-record. Close as obsolete.

**Held in queue for separate sessions (not blocking Phase 1):**

- KAN-787 Prisma vector-index drift structural fix (recurring tax until shipped — workaround applies to KAN-791 migration)
- KAN-788 dev-env refresh
- KAN-783 decision/action chain audit
- Vestigial JSON column drops + ContactState drop — Phase 2 cleanup pass

**Phase 5 — KAN-808 callout (tenant Pipeline retirement workflow):**

`Deal.pipelineId` and `Deal.currentStageId` use `onDelete: Restrict` per §3 — correct for Phase 1 (don't orphan Deals when a Pipeline or Stage is deleted), but means a tenant **cannot delete a Pipeline or Stage that has any associated Deals**, including closed_won/_lost terminal-state Deals from years ago. Once design partners want to retire / archive old Pipelines, **KAN-808 (tenant Pipeline retirement workflow)** must implement either: (a) soft-delete pattern (`isArchived: Boolean` flag instead of row removal), (b) bulk-reassignment of historical Deals to a "retired" pseudo-Pipeline before drop, or (c) hard-delete cascade with explicit user confirmation. Phase 1 doesn't need to solve this — `onDelete: Restrict` correctly fails-loud if anyone tries.

---

## 6. Acceptance criteria

**KAN-791 (schema):**
- [ ] `prisma migrate dev --name kan_791_deal_lifecycle_pivot` generates migration cleanly against local Postgres@15 + pgvector v0.8.2 (5-layer recipe per `feedback_local_postgres_pgvector_parity_gap_kan_706`); KAN-787 spurious-DROP workaround applied (`grep "DROP INDEX" migration.sql` returns zero before commit)
- [ ] Generated SQL matches §3: Deal extended (pipelineId/currentStageId/enteredStageAt/microObjectiveProgress/value-default-0); Stage extended (outcomeType/followUpCadence); DealStageHistory created; Engagement.dealId required; DealStatus + Deal.closedAt + lead_stage_history dropped; Contact lifecycle columns marked deprecated (kept for Phase 1 read-shim)
- [ ] Prisma client regenerated; `enum-drift.test.ts` PAIRS extended for `StageOutcomeType` + DealStatus PAIRS removed (enum no longer exists)
- [ ] EngagementService updated — `dealId` REQUIRED in `EngagementInput`; existing tests revised to provide it; new test confirms create fails if `dealId` omitted
- [ ] Reader migration audit complete — every `Contact.currentStageId` / `.currentPipelineId` / `.microObjectiveProgress` read site identified, migrated to Deal-side reader, OR documented + deferred with a follow-up ticket
- [ ] `feat/kan-786-phase-1-deal-engagement` branch closed without merging the orchestrator-hook commits (b51a48c + 93b6dee — the maybeWritePhase1Deal helper is cancelled per pivot); sub-cohort (a)+(b) commits already merged via PR #91-related work
- [ ] Full turbo test suite green (no regression vs current 56 files / 654 tests + new KAN-791 tests)

**KAN-792 (Normalizer):**
- [ ] `packages/api/src/services/lead-normalizer.ts` created with `normalizeInboundEmail` + `normalizeInbound(source, input)` exports
- [ ] Test fixture: 3 sample inbound emails (Formspree-style, hotmail-style, plain text) parse cleanly into `{ contact, deal, inboundEngagement }`
- [ ] Anthropic SDK call mocked in tests; pre-parser logic tested independently of the AI step
- [ ] Failure-isolation test: AI extraction throws → degraded output with pre-parser fields only (does NOT abort)
- [ ] Pre-flight discipline applied: confirmed Anthropic SDK is wired in repo (likely `llm-client.ts`); adapted to existing client pattern not invented from scratch

**KAN-793 (Track A integration):**
- [ ] `lead-received-push.ts` consumer (or equivalent) calls `normalizeInbound(...)` after event validation
- [ ] Real-email Track A smoke at end of sprint: send fresh inbound email → all of:
  - `contacts` row exists for the sender (or dedup hit)
  - `deals` row exists with `pipelineId` = tenant's `defaultAssignmentPipelineId`, `currentStageId` = that Pipeline's `isInitial` Stage, `correlationId` = the inbound `lead_inbox_events.id`
  - `engagements` row exists with `deal_id = deals.id`, `engagementType = 'lead_received'`, `signalClass = 'positive'`
  - `deal_stage_history` row exists with `fromStageId = null`, `toStageId = starting_stage.id`, `triggeredBy = 'normalizer'`
- [ ] §2 SQL queries return `>= 1` for both `deals` and `engagements` (real Track A traffic post-deploy)

**Phase 1 close gate (cross-cutting, applies after all 3 epics ship):**
- [ ] **Track A 4-query regression check** — same matrix from yesterday's KAN-741 close, all four pass post-deploy:
  1. `growth-api` consumer log: `gcloud run services logs read growth-api --region us-central1 --limit=50 | grep -E "lead-received-push|assigned"` → fresh `[lead-received-push] assigned` line
  2. Pub/Sub publish count: monotonic increment on `lead.received` topic
  3. `SELECT id, status, resend_email_id, created_at FROM lead_inbox_events ORDER BY created_at DESC LIMIT 1;` → new row, `status='accepted'`
  4. `SELECT id, email, tenant_id, created_at FROM contacts WHERE created_at > NOW() - INTERVAL '5 minutes';` → smoke sender present (or dedup-hit existing)
- [ ] **Empirical end-of-sprint smoke is load-bearing** per `feedback_kan_745_cost_observability_shipped` — Jira→Done only after deploy + smoke green, NOT at merge time

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

The existing dead `engagement-logger.ts` emits to Pub/Sub topic `growth.engagement.logged`. `behavioral-learner.ts` is documented as a subscriber. But the topic has **never received a message in production** (the publisher is dead). Question survives the Phase 1 pivot — Engagement is still written by EngagementService at intake (KAN-793) + downstream (sub-cohort (b) flow); the read-path question for behavioral-learner.ts is independent of how Engagement is produced.

Two options:
- **(a) Direct Prisma write only.** `behavioral-learner.ts` reads from the `engagement` table on a schedule via `listEngagementsSinceForLearning(after)`. Simpler, fewer moving parts, no topic to provision.
- **(b) Prisma write + Pub/Sub publish (sibling subscribers).** `logEngagement` writes to Prisma AND publishes to `growth.engagement.logged`. Other subscribers can fan out. Adds a topic per `feedback_pubsub_route_registration_vs_subscription_config` — requires real-delivery smoke before declaring wired.

**Recommendation: start with (a).** Lower configuration surface, cleaner Phase 1 scope. Phase 2's KAN-794 Brain Service can revisit if real-time SLAs require it.

### Q9.2 — `18 decisions / 0 actions` divergence (KAN-783)

Production has 18 `decisions` rows but 0 `actions` rows (per yesterday's empirical anchors). Three hypotheses:
- (a) Shadow mode: agentic decisions persisted to `AgenticShadowDecision` instead of emitting `Action`s
- (b) Action dispatch path is broken — KAN-689 cohort suspect
- (c) Decisions exist but threshold gate filtered all below dispatch threshold

**Out of Phase 1 scope** — KAN-783 owns this. Even less of a blocker post-pivot: Phase 1's data trail (Deal + Engagement) is established at intake (KAN-793), upstream of any action dispatch. Decision→Action divergence affects downstream telemetry but not Phase 1's success metric.

### Q9.3 — `Deal.value` source (KAN-790)

`Deal.value` defaults to `0` in Phase 1 (per the lifecycle pivot — was `null` in pre-pivot draft). Empirical schema check found `Contact.metadata` field doesn't exist — assumption from earlier draft was wrong. Value-enrichment product decision deferred to **[KAN-790](https://axisone-team.atlassian.net/browse/KAN-790)** — options: add typed `Contact.dealValue Decimal` + `Contact.dealCurrency Varchar(3)` columns, add `Contact.metadata Json`, source from `Decision.metadata`, or add override inputs at decision-time.

Per `feedback_prd_assumed_infrastructure_check_kan_786` anchor #2 — defer to defaults + file enrichment follow-up; don't silently bind to a semantically-wrong existing field.

### Q9.4 — Default Pipeline routing — lazy-bootstrap (RESOLVED)

**Resolution (2026-05-03):** Phase 1 routes via a 3-path fallback chain that **always succeeds in producing a Pipeline+Stage** — never drops a lead due to missing tenant configuration. Lead = revenue; the worst failure mode would be silently dropping inbound during onboarding-incomplete state. Fred's call: "in production, leads = revenue" → lazy bootstrap (option (c)) over atomic-or-nothing (option (a)).

**Routing fallback chain (in order):**
1. `Tenant.defaultAssignmentPipelineId` (existing column from KAN-705) — if set, use it
2. If NULL: `Pipeline.findMany({ where: { tenantId } })` — if exactly 1, use it (most prod tenants); also populate `defaultAssignmentPipelineId` for next time
3. If still 0 Pipelines: **lazy-bootstrap** the platform-default Pipeline + 7 Stages via `ensureTenantHasDefaultPipeline(tenantId)` (helper specced in §4 KAN-793). Idempotent. Populate `defaultAssignmentPipelineId` after bootstrap.

**Edge case — Pipeline exists but has no `isInitial: true` Stage:** unreachable post-KAN-791 because the schema invariant (`@@unique([pipelineId]) WHERE isInitial = true` enforced via raw SQL partial index per §3) requires every Pipeline to have at most one isInitial Stage. The lazy-bootstrap helper creates Stage 0 with `isInitial: true`, so freshly-bootstrapped Pipelines always satisfy the invariant. If somehow a Pipeline exists with zero isInitial Stages (legacy data), log + skip and fall through to lazy-bootstrap of a sibling Pipeline. Don't mutate the existing one (could be deliberate).

**KAN-795 (AI Pipeline Routing Logic, Phase 2) supersedes the hardcoded fallback** — the AI router replaces step 1 of the chain (intelligent routing based on lead signal); steps 2+3 remain as defaults until KAN-795 ships per-tenant configuration UI. Lazy-bootstrap stays canonical even after KAN-795 — it's the "tenant has zero config" floor.

### Q9.5 — Engagement.dealId atomicity (RESOLVED — no longer in conflict)

`Engagement.dealId` is REQUIRED (FK NOT NULL). Q9.4's lazy-bootstrap resolution **eliminates the previous conflict** — Deal always exists at the moment Engagement is written, because the Normalizer creates it first (potentially via lazy-bootstrap of the Pipeline first if needed). No atomicity concern remains in Phase 1.

**Implementation invariant** (still important even without conflict): the Normalizer's intake flow produces `{ contact, deal, inboundEngagement }` in dependency order — Pipeline (lazy-bootstrap if needed) → Contact (upsert) → Deal (create with FK to Pipeline + Stage + Contact) → DealStageHistory (create with FK to Deal) → Engagement (create with FK to Deal). Recommend `prisma.$transaction([...])` for the Deal+History+Engagement triplet (the lazy-bootstrap can be a sibling transaction outside; idempotent helper handles concurrent-safety via tenant-scoped advisory lock or findFirst-then-create pattern).

If the Deal write somehow fails mid-transaction: Prisma rolls back the entire transaction; no Engagement is written; consumer retries on next Pub/Sub redelivery; correlationId idempotency (per Edit 2) prevents duplicate Deals on retry. Failure-loud, not silent-degraded.

### Q9.6 — LLM model selection in the Normalizer (KAN-792)

KAN-792 starts with **Anthropic Claude Sonnet** (matches the existing `llm-client.ts` defaults observed across `agentic-tools.ts` etc.). Cost optimization (Haiku for cheap pre-classification + Sonnet for full extraction, or fallback chain) deferred to **KAN-806** (LLM cost tier-mapping per `feedback_kan_745_cost_observability_shipped` discipline).

Pre-flight discipline: confirm Anthropic SDK is wired in repo (`grep -rn "anthropic" packages/api/src/services/llm-client.ts`) before writing Normalizer code. If a different client is canonical, adapt. Per `feedback_prd_assumed_infrastructure_check_kan_786` — don't assume.

### Q9.7 — Per-Stage cadence: stored not consumed in Phase 1

`Stage.followUpCadence Json` ships in Phase 1's KAN-791 migration. The CONSUMER (a cron-driven advancement job that reads cadence + advances Deals through Stages based on signal patterns) is **Phase 2 KAN-796 (AI Stages Evolution Logic)**.

For Phase 1: column exists, defaults to `{}`, no readers. Tenants can populate via direct DB access if they want to pre-load configuration; UI for editing the cadence is also Phase 2.

### Q9.8 — Superseded follow-ups (close in PR review)

The Phase 1 lifecycle pivot supersedes two prior tickets:

- **[KAN-785](https://axisone-team.atlassian.net/browse/KAN-785)** (Phase 3 Lead/Contact split) — Lead lifecycle now lives on `Deal`; the 1-Contact-N-Leads pattern is naturally supported via 1-Contact-N-Deals. Close as obsolete in PR review.
- **[KAN-789](https://axisone-team.atlassian.net/browse/KAN-789)** (transition_to_closed_won/_lost executors) — Stage transitions are now generic writes via `DealStageHistory`; specific action-type executors no longer needed. Close as obsolete in PR review.

KAN-790 stays open (value enrichment is a real product decision, just deferred). KAN-787 + KAN-788 stay open (orthogonal infrastructure work).

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
