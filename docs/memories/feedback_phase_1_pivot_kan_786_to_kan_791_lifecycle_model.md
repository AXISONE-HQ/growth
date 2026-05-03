# feedback_phase_1_pivot_kan_786_to_kan_791_lifecycle_model

**Trigger:** KAN-786 ("Phase 1 Deal + Engagement entities") was halfway-built (sub-cohorts a + b merged, sub-cohort c WIP committed) when a Confluence Roadmap commit revealed Deal is the LIFECYCLE entity going forward, not the terminal-outcome artifact KAN-786 had been scoped against. Mid-build pivot triggered a 3-epic rebuild (KAN-791/792/793) and a 5-PR rollover sequence.

**Empirical anchor:** Pivot landed 2026-05-03. KAN-786 schema (sub-cohort a) had Deal-as-outcome shape: `status DealStatus enum { open | closed_won | closed_lost }`, `closedAt DateTime?`, no pipeline-state columns. EngagementService (sub-cohort b) was complete with `dealId String?` (nullable). Sub-cohort (c) orchestrator hook for closed_won/_lost was implemented (commits b51a48c + 93b6dee) but became obsolete the moment the lifecycle model landed.

---

## What the pivot changed

| Concept | KAN-786 (Deal-as-outcome) | KAN-791 (Deal-as-lifecycle) |
|---|---|---|
| Deal lifecycle state | `Deal.status DealStatus` enum + `closedAt` | Stage outcomeType (`open`/`terminal_won`/`terminal_lost`); Deal.currentStageId carries lifecycle state |
| Pipeline-state location | `Contact.currentPipelineId` (deprecated read-shim Phase 1) | `Deal.pipelineId` (new) — Contact's pipeline-state columns become read-shim, retired in Phase 2 |
| Stage-transition audit | `LeadStageHistory` (contact-scoped) | `DealStageHistory` (deal-scoped, mandatory FK with onDelete: Cascade) |
| Engagement attachment | `Engagement.dealId String?` (nullable, soft-link) | `Engagement.dealId String` (REQUIRED FK with onDelete: Restrict) |
| Stage cadence | not modeled | `Stage.followUpCadence Json` (Phase 2 KAN-796 consumes) |
| Closed-state detection | `Deal.status` enum check | `Stage.outcomeType` lookup (terminal_won / terminal_lost) |
| Per-Deal MO progress | `Contact.microObjectiveProgress Json` | `Deal.microObjectiveProgress Json` (moved) |

---

## What was preserved (sub-cohorts a + b, ~14 commits)

- Schema baseline: Deal model + Engagement model + dealId FK contracts. KAN-791 EXTENDS Deal (adds pipelineId/currentStageId/enteredStageAt/microObjectiveProgress; drops status/closedAt) — additive on net.
- EngagementService logEngagement + classifySignal + correlationId UNIQUE idempotency. KAN-793 commit 3 EXTENDS classifySignal (adds `email_received → positive`).
- All test infrastructure (engagement-service.test.ts, kan-700-schema.test.ts hand-rolled prisma mocks).

---

## What was reverted (sub-cohort c, 2 WIP commits)

- `b51a48c` — `maybeWritePhase1Deal` orchestrator hook for closed_won/_lost
- `93b6dee` — tests for the hook
- Reverted explicitly in KAN-791 first commit `9a47228` with message: `revert: drop sub-cohort (c) maybeWritePhase1Deal helper — superseded by Deal-as-lifecycle pivot (KAN-791)`

The revert commit is the visible audit anchor — anyone reading the branch history sees "this approach was attempted, then superseded by the lifecycle pivot." Stage-evolution logic (which sub-cohort c was approximating) moves to Phase 2 KAN-796 (AI Stages Evolution Logic).

---

## What was deferred to Phase 2+ (KAN-794 through KAN-810)

- KAN-794 Brain Service — replaces ambiguous-routing posture (unassigned/escalated outcomes get resolved asynchronously instead of producing Contact-only state)
- KAN-795 Customer Decision meta-pipeline — for ambiguous routing
- KAN-796 AI Stages Evolution Logic — Stage-transition cron driven by signal patterns + followUpCadence
- KAN-797 Communication Shaper, KAN-798 Send Policy, KAN-799-803 multi-source connectors (Meta Lead Ads / SMS / WhatsApp / Voice / lead_api)
- KAN-806 Cost & Observability, KAN-807 Onboarding Wizard, KAN-808-810 ancillary

Phase 1 ships with: Track A inbound → Default Pipeline lazy-bootstrap → Deal write → DealStageHistory + Engagement. Everything beyond is Phase 2+.

---

## Rollover process — 5 PRs

| PR | Subject | Merge strategy | Commit |
|---|---|---|---|
| #91 | PRD revision (4 amendments adding §10 Architectural Context + revising §1/§3/§4/§5/§6/§9 for lifecycle model) | `--squash` | `bdf355b` |
| #92 | Sub-cohorts a + b code (preserved all 9 commits including the 2 cancelled WIP for audit-trail value) | `--merge` | `81c7f09` |
| #93 | KAN-791 schema pivot (Deal lifecycle fields + Stage outcomeType + DealStageHistory + Engagement.dealId required; LeadStageHistory + DealStatus enum dropped) | `--merge` | `765be1b` |
| #94 | KAN-792 AI Lead Normalizer (module-scoped + Haiku tier + failure-isolated extraction) | `--merge` | `aff0b25` |
| #95 | KAN-793 Track A → Deal integration (bootstrap + integration + classifySignal extension; +commit 0 LeadStageHistory cleanup) | `--merge` | `014f489` |

End-of-sprint Track A real-email smoke (2026-05-03 21:04 UTC, growth-api revision -00148): 8/8 checks PASS + §2 success metric green (deals=1/1, engagements=1/1).

---

## Pattern — when a roadmap-level pivot lands mid-execution

Three options surface:

1. **Abandon WIP entirely** — loses learning value; cancellations become invisible
2. **Rebase-rewrite** to remove cancelled commits — clean history but loses audit trail
3. **Merge AS-IS + revert in successor branch's first commit** — preserves the "we tried this, it became obsolete" trail with explicit superseded-by reference

Option (3) won. The PR #92 merge commit + KAN-791's first revert commit (9a47228) together read as a complete record of the pivot moment. Future Claude sessions reading the history can reconstruct the architectural change without needing to find the Confluence roadmap commit.

---

## Discipline going forward

When a multi-cohort feature build encounters a roadmap-level pivot:

1. **Stop and surface the conflict immediately** — don't quietly try to refactor in-flight WIP to fit the new model
2. **Fred makes the architectural call** (preserve / abandon / pivot how)
3. **Default to merge-AS-IS + revert pattern** unless clean-history is load-bearing for compliance
4. **Successor branch's first commit must be the explicit revert** with superseded-by reference to the new ticket
5. **PRD revision PR ships before the implementation PR** — locks the new contract before code lands

Sibling pattern: `feedback_minimum_slice_of_broader_epic` (when a ticket is "minimum slice of epic X," prefer mode-branch on existing scaffolding). Both about preserving option-value when scope changes mid-flight.

---

## Cross-references

- `docs/prds/phase-1-deal-engagement.md` — canonical PRD post-pivot (§10 Architectural Context, 4 PRD amendments)
- `feedback_minimum_slice_of_broader_epic` — sibling preserve-option-value pattern
- `feedback_class_fix_not_instance_fix` — sibling discipline-at-class-level pattern
- `feedback_kan_791_dropped_model_residual_references` — companion (KAN-791 dropped LeadStageHistory left 4 silent no-op references; KAN-793 commit 0 cleaned them)
- `feedback_migration_diff_script_pattern_for_destructive_changes` — companion (KAN-791 was first KAN-prefixed use of the diff-script pattern)
- KAN-786 (origin), KAN-791 (schema pivot), KAN-792 (Normalizer), KAN-793 (integration), KAN-794-810 (Phase 2+ deferred)

---

## Status

**Done.** Phase 1 shipped end-to-end 2026-05-03. Pattern is forward-looking — applies to any future multi-cohort build that encounters a roadmap pivot.
