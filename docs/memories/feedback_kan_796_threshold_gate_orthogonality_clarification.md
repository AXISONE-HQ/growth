# feedback_kan_796_threshold_gate_orthogonality_clarification

**Trigger:** "X subsumes Y" or "X replaces Y" framing in PRDs requires empirical verification of Y's actual responsibilities BEFORE scoping X. PRD framing collapses architectural distinctions; only `grep`/`read`/`docstring` verification reveals whether Y is truly subsumed or whether X and Y are orthogonal layers that compose (not replace). Empirical anchor: KAN-796 spec said "replaces today's threshold-gate" — pre-flight found threshold-gate is the action-approval governance layer (KAN-39), not transition execution. They're orthogonal; sub-cohort (b) wiring composes them.

**Empirical anchor:** KAN-796a pre-flight (2026-05-03) caught a misconception in the original spec. PRD framing was "stage-transition-engine subsumes today's threshold-gate." Pre-flight check #3 read `packages/api/src/services/threshold-gate.ts` docstring (KAN-39) which describes it as the "DECIDE phase Step 5 — Final gate before action execution. Compares the confidence score against the tenant's configured threshold. Routes low-confidence actions to the human review queue; high-confidence actions proceed to the Agent Dispatcher." That's action-approval governance, not transition execution. KAN-796a stage-transition-engine writes Deal.currentStageId + DealStageHistory; threshold-gate decides whether agentic actions may fire autonomously. Different layers. Sub-cohort (b) KAN-813 wiring composes them: threshold-gate gates → if approved, stage-transition-engine writes.

---

## The pattern

When a PRD says "X replaces Y" or "X subsumes Y":

1. **Locate Y empirically.** `grep -rn "Y" packages apps --include="*.ts"` finds the actual references, exports, and call sites.
2. **Read Y's docstring.** The first 30 lines usually state Y's purpose. If the purpose differs from PRD's framing, the PRD has misconceived the architecture.
3. **Trace Y's callers.** `grep -rn "import.*Y" apps packages` shows what depends on Y. If callers exist, "subsumes" needs migration plan; "replaces" might break live code.
4. **Surface the divergence in pre-flight report.** Stop, ask: is X truly subsuming Y, OR are they orthogonal layers that compose? OR is X replacing a part of Y while leaving the rest?
5. **Wait for user's architectural call** before writing code.

The cost of this check: 5-10 minutes of `grep` + `read`. The cost of skipping it: shipping a module that duplicates an existing module's concerns, or worse, deleting an existing module and breaking live callers.

---

## Why empirically

**KAN-796a near-miss timeline:**

- Original spec wrote: "stage-transition-engine subsumes today's threshold-gate"
- If accepted at face value: KAN-796a would have built a module that duplicates threshold-gate's confidence-vs-threshold check + human-review-queue routing + auto-approve-matrix evaluation
- Then KAN-813 sub-cohort (b) wiring would discover the duplication during integration; either delete the original threshold-gate (breaking KAN-39 + KAN-704 consumers) or rename one (vocab churn).
- Pre-flight `grep` + `read` revealed threshold-gate is action-approval (governance) not transition-write (execution). Decision ambiguity dissolved into: "they compose orthogonally."

The PRD wasn't wrong about the high-level architecture (Phase 2 needs both). It was wrong about the relationship between two specific modules. PRD framing collapses architectural relationships into shorter labels; pre-flight verification recovers the precision.

---

## Sibling pattern from earlier sessions

This is the same class as **KAN-795 pre-flight discovery** (existing `aiAssignmentFallback` in lead-assignment.ts) and **KAN-797a pre-flight discovery** (existing `message-composer.ts` 403 LoC live production code). All three had spec-vs-reality divergence that pre-flight caught:

| Epic | PRD framing | Reality |
|---|---|---|
| KAN-795 | "introduce new AI tier" | aiAssignmentFallback already exists, fully LLM-driven, in production |
| KAN-796a | "subsumes threshold-gate" | threshold-gate is orthogonal (action-approval, not transition-write) |
| KAN-797a | "new compose-message module" | message-composer.ts exists, 403 LoC, live action.decided send path |

Three for three. Pre-flight verification is load-bearing for any PRD that frames a relationship to existing code.

---

## When to apply

- Any PRD with "subsumes" / "replaces" / "extends" / "introduces" relative to existing code
- Any new-module spec where the new module's name overlaps with existing module names
- Any spec that assumes a feature doesn't exist (the "introduces new X" framing implies absence — verify)

---

## Disciplined pre-flight checklist for "X replaces/subsumes Y" PRDs

- [ ] `grep -rn "Y" packages apps --include="*.ts"` — does Y exist? where?
- [ ] Read Y's docstring (top 30 lines)
- [ ] `grep -rn "import.*Y\|from.*Y" packages apps --include="*.ts"` — who depends on Y?
- [ ] `wc -l Y.ts` — how much code is at risk?
- [ ] If Y exists in production: surface 3 paths in pre-flight report (replace wholesale / sit alongside / refactor + extract)
- [ ] Wait for explicit architectural decision before writing code

---

## Cross-references

- KAN-796a (origin — threshold-gate orthogonality clarification)
- KAN-795 — sibling pattern (aiAssignmentFallback discovery)
- KAN-797a — sibling pattern (message-composer discovery → Path B coexistence)
- [`feedback_legacy_message_composer_vs_brain_driven_shaper_coexistence.md`](./feedback_legacy_message_composer_vs_brain_driven_shaper_coexistence.md) — companion (Path B pattern)
- threshold-gate.ts (KAN-39) — the orthogonal layer

---

## Status

**Active.** Pattern applies to all future PRDs that frame relationships to existing code.
