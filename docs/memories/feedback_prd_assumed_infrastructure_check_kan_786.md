# feedback_prd_assumed_infrastructure_check_kan_786

**Trigger:** PRD §4 of KAN-786 specified "extend the `transition_to_closed_won` / `_lost` handlers to insert a Deal row alongside the existing Pipeline stage transition." Empirical check during sub-cohort (c) pre-flight (2026-05-03) found **NO existing Pipeline stage transition** for these action types. They appear only as type literals + auto-approve catalog entries; no dispatcher case acts on them.

**Empirical anchor:** Sub-cohort (c) on 2026-05-03. Pre-flight grep for execution paths returned only type-literal + catalog entries from `threshold-gate.ts:36-37` + `:92-97`. Zero dispatcher matches across the repo. The "existing handler" the PRD said to extend simply doesn't exist — these action types get APPROVED by the threshold gate then... nothing. Same silent producer-side-only class as KAN-783's "18 decisions / 0 actions" symptom.

---

## Pattern

PRD authors who write "extend X handler" or "insert Y alongside the existing Z" must verify the handler/Z **is actually wired into an execution path** — not just defined as a type, not just listed in a configuration catalog, not just referenced in a threshold-gate decision. A type-literal-in-a-union and a catalog-entry-in-a-config-object are NOT execution paths.

This is distinct from `feedback_prd_path_systematic_error_apps_vs_packages` (wrong file paths / imports / shapes — all those things existed, just at different locations). This pattern is about: the assumed *behavior* doesn't exist anywhere. The PRD author's mental model of what runs at runtime didn't match what actually runs.

---

## The grep discipline (PRD authors)

Cheap check: are there switch cases / dispatcher entries / call sites that act on the action type?

```bash
# Substitute <actionType> with the literal you're about to assume has a handler
grep -rn "case ['\"]<actionType>['\"]\|<actionType>:" \
  --include='*.ts' packages/api/ apps/ \
  | grep -v node_modules | grep -v dist | grep -v ".test." | grep -v __tests__ \
  | head -10
```

If the only matches are TYPE LITERALS (single-quoted strings inside union types) and CATALOG ENTRIES (object-literal keys in const config), the handler **isn't wired**. Treat as missing infrastructure.

For "this code is the existing X transition" claims, trace the call path explicitly:
1. Where is the action type dispatched? (`switch (actionType) { case '<x>': ... }`)
2. What does the dispatched code DO to state? (look for `prisma.<table>.update`, event publishes, side-effect calls)
3. If neither (1) nor (2) returns substantive code: the executor doesn't exist.

---

## Discipline going forward — PRD authors

- Before writing "extend handler X", confirm handler X has an execution path: trace from action type → dispatcher → executor → state change. Cite the file/line of the executor in the PRD itself.
- If only the policy layer exists (catalog, threshold, type definition) and **no executor**, treat it as **missing infrastructure** not "extend existing." Either:
  - Include the executor implementation explicitly in scope (and budget for it)
  - Explicitly note the **decoupled approach** in the PRD (write outcome directly, defer executor to separate ticket — what KAN-786 sub-cohort (c) ended up doing)
- Distinguish PRD claims at three layers: (1) *type/catalog is defined* — check `grep "type X"` / catalog object keys. (2) *handler is dispatched* — check switch cases / dispatcher entries. (3) *handler executes side effects* — check what code runs in the case body. Layer (1) without layer (2)/(3) is the trap.

---

## Discipline going forward — PRD reviewers

When reviewing PRDs that say "extend handler X" or "alongside the existing Y", ask: **"where does X actually execute?"** If the PRD author can't point at the executor file/line, that's a flag. The 30-second grep is cheaper than catching it during sub-cohort implementation 2 weeks later.

---

## Empirical detail (KAN-786 sub-cohort (c))

PRD §4 said: "Extend `transition_to_closed_won` and `transition_to_closed_lost` action handlers to insert a `Deal` row **alongside the existing Pipeline stage transition**."

What pre-flight grep actually found:
```
packages/api/src/services/threshold-gate.ts:36:  | 'transition_to_closed_won'      ← TYPE LITERAL
packages/api/src/services/threshold-gate.ts:37:  | 'transition_to_closed_lost'     ← TYPE LITERAL
packages/api/src/services/threshold-gate.ts:92:  transition_to_closed_won: { ... } ← CATALOG ENTRY
packages/api/src/services/threshold-gate.ts:97:  transition_to_closed_lost: { ... } ← CATALOG ENTRY

(zero matches anywhere else: no dispatcher, no executor, no Pipeline.update, no LeadStageHistory.create)
```

The `PLATFORM_AUTO_APPROVE_DEFAULTS` catalog entry (line 92) sets `threshold: 0.9, default: 'auto'` for `transition_to_closed_won`. That's a POLICY ("if confidence ≥ 0.9, auto-approve this action type"), not an EXECUTION ("when approved, do X to the database").

**Resolution adopted:** Option β — write the `Deal` row directly in `run-decision-for-contact.ts` orchestrator on decision approval, decoupled from any (non-existent) Pipeline stage transition. Tracked as [KAN-789](https://axisone-team.atlassian.net/browse/KAN-789) for the missing executor.

---

## Cross-references

- `docs/prds/phase-1-deal-engagement.md` — §4 amended in commit (TBD on docs/phase-1-prd) to reflect Option β
- [KAN-786](https://axisone-team.atlassian.net/browse/KAN-786) — Phase 1 ticket
- [KAN-789](https://axisone-team.atlassian.net/browse/KAN-789) — missing transition executor (this ticket's resolution)
- [KAN-783](https://axisone-team.atlassian.net/browse/KAN-783) — broader 18 decisions / 0 actions class; KAN-789 is one cause
- [`feedback_prd_path_systematic_error_apps_vs_packages.md`](./feedback_prd_path_systematic_error_apps_vs_packages.md) — sibling pattern: PRD wrong about WHERE files live (paths/imports/shapes)
- This entry: PRD wrong about WHAT EXECUTES (handlers/dispatchers)

---

## Status

**Active.** Pattern applies to all future PRDs in this repo. Distinct from `feedback_prd_path_systematic_error_apps_vs_packages` — both are PRD-spec-vs-reality drift but at different layers (file location vs runtime behavior). Retiring conditions: (a) PRD-lint that runs grep-checks on every "extend" / "alongside existing" claim, or (b) team standardizes on a code-organization where every action type maps 1:1 to a checked-in executor file (would make missing-executor structurally impossible).
