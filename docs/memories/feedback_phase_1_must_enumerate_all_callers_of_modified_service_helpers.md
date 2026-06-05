---
name: Phase 1 must enumerate ALL callers of modified service helpers
description: KAN-1094→KAN-1098 2026-06-04. When Phase 1 design trace identifies a service-layer helper integration point (composer, resolver, audit-writer, etc.), trace MUST enumerate ALL callers via comprehensive grep — not just the suspected or named ones. Each caller documented as wired / not-wired / to-be-wired-followup. KAN-1094 Phase 1 narrowed to one composer call site (action-decided-push); missed the autonomy-path call site (lead-received-push:2562 dispatchPhase2Send). Smoke caught it; ~150 LoC fix-forward (KAN-1098) + re-smoke costs the cluster close.
type: feedback
originSessionId: fa3e75d9-e845-486a-a581-d9a9d6138c62
---
**KAN-1094 → KAN-1098 fix-forward 2026-06-04**: Phase 1 design trace identified one composer call site (`action-decided-push.ts:414`) without enumerating ALL composer callers via grep. `message-composer.ts:259` docstring explicitly named BOTH callers ("KAN-815c dispatchPhase2Send + legacy gateAndPublishComposed") but Phase 1 narrowed scope. Result: KAN-1094 shipped with autonomy-path composer call site UNWIRED — the DOMINANT production path missed scenario injection. Smoke ceremony caught it post-merge; ~150 LoC fix-forward + re-smoke costs the cluster close.

## The discipline rule

For any Phase 1 trace that touches a service-layer helper (composer, resolver, audit-writer, dispatcher, etc.):

1. Run `grep -rn '<functionName>(' apps/ packages/ --include='*.ts'`
2. Enumerate every call site (file:line)
3. Document each call site's status:
   - **wired** (this PR will integrate scenario/change at this site)
   - **not-wired** (out-of-scope; document reason explicitly)
   - **to-be-wired-in-followup** (file Phase 2.5 ticket immediately — surface the gap before merge, not after smoke)
4. Verify the count matches expectations — if more callers exist than the build prompt assumes, surface the gap immediately

**Bounded ~5-min addition to Phase 1.** Prevents the smoke-time architectural catch that costs ~3-4 hours fix-forward.

## Anti-pattern (what we did in KAN-1094)

Phase 1 trace named one composer call site without checking via grep:

> "**Composer integration point**: `packages/api/src/services/message-composer.ts:124` — `composeMessage` function."
> "**`apps/api/src/subscribers/action-decided-push.ts:279`** — actual `composeMessage` call site"

The trace correctly identified action-decided-push as A call site (corrected from the build prompt's wrong audit-write sites — itself a Phase 1 catch). But it didn't enumerate ALL callers. The grep would have surfaced `lead-received-push.ts:2562 dispatchPhase2Send` immediately as an unwired caller.

The `message-composer.ts:259` docstring even named both callers:
> "Callers (KAN-815c dispatchPhase2Send + legacy gateAndPublishComposed)"

Phase 1 had the signal in the source itself; just didn't run the grep.

## Forward discipline

**Phase 1 design trace MUST include caller-enumeration when touching a service-layer helper.** Add to the Phase 1 anchor checklist:

```
Anchor N (REQUIRED for service-layer helper integration):
- [ ] grep -rn 'helperName(' apps/ packages/ --include='*.ts'
- [ ] Caller A at file:line — status: wired/not-wired/followup (reason: ...)
- [ ] Caller B at file:line — status: ...
- [ ] Caller count matches build prompt expectation? Y/N
- [ ] If N: surface gap immediately + decide scope inclusion before Phase 2 begins
```

## Activation triggers for similar discipline pins

- When a Phase 1 trace identifies fewer call sites than a docstring enumerates → STOP, grep, enumerate
- When a smoke catch reveals a missed integration point → file fix-forward + update Phase 1 discipline doc with the enumeration step
- When a service-layer helper is being EXTENDED with a new parameter (e.g., `composeMessage(input)` now accepts `scenario?`) → ALL callers need updating, not just the named one

## Sibling memos (the architectural-catch family)

- `feedback_parent_design_trace_line_refs_drift_per_pr_traces_canonical` — Cluster I PR III (KAN-1058) line-shift catch
- `feedback_parent_trace_framing_assumptions_vs_codebase_reality` — Tier 2 PR II (KAN-1087) framing-assumption catch (server-component → dual-layer guard)
- `feedback_smoke_step_execution_authority_taxonomy` — smoke step CC-autonomous / Fred-mediated / test-suite-substituted classification
- `feedback_ad_hoc_debug_fixes_must_propagate_to_source` — ad-hoc rewrites during smoke must propagate to source before reporting GREEN

**KAN-1094 catch is the 4th in this family** — first one caught at SMOKE time rather than Phase 1 time. Test-suite-substituted gates couldn't see the omission because no integration test exercised the autonomy path.

## Pattern-class observation

The four catches escalate in detection difficulty:

| Catch | Detection layer | Cost |
|---|---|---|
| Line-shift drift (Cluster I PR III) | Phase 1 verification | Trivial fix during Phase 1 |
| Framing-assumption (Tier 2 PR II) | Phase 1 verification | Phase 1 reframe; clean Phase 2 build |
| Composer-site correction (KAN-1094 Phase 1) | Phase 1 verification | Phase 1 reframe; clean Phase 2 build |
| **Caller-enumeration gap (KAN-1094 → KAN-1098)** | **Empirical smoke** | **Fix-forward PR + re-smoke** |

The cost escalates ~10× when the catch slips past Phase 1 into smoke. The enumeration discipline is procedural Phase 1 hygiene — bounded ~5-min addition that prevents the most expensive failure mode.

## Banked alongside KAN-1098 ticket file

## 2026-06-05 meta-rule append (after KAN-1098 Phase 1 reframe)

The original 2026-06-04 memo quoted `message-composer.ts:259` docstring as evidence that the docstring named both composer callers: "Callers (KAN-815c dispatchPhase2Send + legacy gateAndPublishComposed)". KAN-1098 Phase 1 trace surfaced that this docstring is on `resolveReplyToForTenant` (declared at L281), NOT on `composeMessage` (declared at L136). The two are 145 lines apart in the same file. The inferential leap from the quoted docstring to "composer caller" was wrong; the discipline itself (grep-enumerate ALL callers) was correct and would have caught the reframe at Phase 1.

**Meta-rule**: when a docstring is quoted as evidence of a callership claim, **verify the docstring is ON the function being claimed about, not on a sibling function in the same file**.

Verification: read 5-10 lines above and below the quoted docstring; identify which `export function`, `export class`, or `export const` declaration the docstring most-immediately precedes. That's the function the docstring documents — and the only function its callership claim applies to.

This is procedural Phase 1 hygiene applied to memos themselves. The original memo's pattern (grep enumeration) holds; the inferential supporting evidence had a sibling-attribution drift that this meta-rule prevents.
