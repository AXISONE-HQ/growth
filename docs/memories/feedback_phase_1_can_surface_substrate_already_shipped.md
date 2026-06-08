---
name: Phase 1 can surface substrate already shipped — dramatically reducing scope
description: KAN-1131/1132 banked 2026-06-08. A ticket framed as "build substrate X" can have Phase 1 enumeration reveal that substrate X is already 80% shipped — the typed column exists, the UI is wired, the read paths are in place. The remaining work is consolidation + documentation, not greenfield. Scope shrinks 3-6x; framing flips from "build" to "complete."
type: feedback
---

**The pattern**: A ticket framed as "build new substrate X" enters Phase 1 enumeration. The audit phase reveals X is already shipped at multiple layers (schema, UI, service). The remaining work is read-path consolidation + audit-discipline-lock + retirement of any legacy parallel path. Scope shrinks dramatically; framing must flip from "greenfield" to "complete + consolidate."

**KAN-1131 instance**: Original ticket framing: "the growth platform is timezone-naive at three layers — no `Tenant.timezone` field, unsafe display layer, latent send-policy evaluation". Phase 1 enumeration found:

- `AccountProfile.timeZone` typed column shipped (schema.prisma:2160) ✅
- Settings UI shipped (timezone-select.tsx via Intl.supportedValuesOf) ✅
- Send-policy timezone-aware code shipped (send-policy.ts:377 uses Intl.DateTimeFormat) ✅
- KAN-943 fix helper shipped (`fmt-date.ts`) ✅
- Date library policy locked (NATIVE Intl, no date-fns) ✅

Substrate was ~80% shipped. The actual remaining work: consolidate send-policy's read path from the legacy JSON to the typed column (1 PR), document audit findings on 15 apps/web sites (1 PR docs + 1-line fix). Scope shrank ~6x from original 3-5 PRs / 2-3 weeks framing to 2 PRs / 1 session.

**KAN-1132 instance** (sibling): Same epic-substrate workstream. Original framing: "multi-currency awareness". Phase 1 enumeration found `defaultCurrency String @default("USD")` already shipped on AccountProfile + Tenant. Multi-currency display via MoneyDisplay component already correct. Remaining work: documentation lock + integration test for Decimal round-trip. Scope shrank similarly.

## Anti-pattern

Treating original framing as authoritative:

1. "The ticket says build substrate X; I'll build substrate X" → may duplicate already-shipped work
2. "The Phase 1 enumeration is overhead before I write code" → enumeration is the savings, not the cost
3. "If it were shipped, the ticket would say so" → tickets are written by humans with incomplete context; enumeration corrects

The right move: **let Phase 1 enumeration authoritatively reframe scope**. If substrate is already shipped, surface this clearly + propose a reframed scope before any code edits.

## Forward discipline

For tickets framed as "build substrate X" or "add capability Y":

1. **Run Phase 1 enumeration as a substrate-state audit FIRST** — search the schema, the service layer, the UI, for existing implementations
2. **Surface the audit findings explicitly in Phase 1 HALT**: "Phase 1 reveals X is already shipped at layers A/B/C; remaining work is consolidation/documentation"
3. **Propose a reframed scope** with specific PR shapes ("PR 1 consolidates X; PR 2 documents Y")
4. **Bank the substrate-shipped finding as a memo candidate** for future Phase 1 traces
5. **Memo cross-reference**: cite `feedback_architectural_audits_must_search_capability_not_field_name.md` as the corollary discipline — the original framing's miss was likely a literal-grep gap

This is the **substrate-already-shipped reframe** discipline. Scope reductions of 3-6x are common; reductions to 0 (entirely complete) happen but are rarer.

## Related patterns / memos

- `feedback_architectural_audits_must_search_capability_not_field_name.md` — sibling pattern (literal-grep miss is the precursor)
- `feedback_phase_1_enumeration_as_code_state_truthing.md` — sibling pattern (enumeration as truth-finding)
- `feedback_phase_2_step_0_reframes_substitution_to_documentation.md` — sibling pattern (Step 0 reframes from substitution to docs)
- `feedback_step_0_can_surface_empirical_data_realities_reframing_phase_1_locks.md` — sibling pattern (Step 0 reframe)

## Banked from

- KAN-1131 (multi-tenant timezone awareness epic) — substrate ~80% shipped; scope shrank 6x
- KAN-1132 (multi-currency epic) — substrate ~90% shipped; scope shrank similarly
- Session date: 2026-06-07/08
