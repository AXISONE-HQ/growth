# feedback_prd_assumed_infrastructure_check_kan_786

**Trigger:** PRD §4 of KAN-786 specified artifacts (handlers, execution paths, schema fields) that don't exist in the actual codebase. Pre-flight grep checks during sub-cohort (c) on 2026-05-03 found **multiple instances** of this pattern — same root class (PRD asserts an artifact exists; empirical verification finds it doesn't), surfaced at different layers of the spec.

**Empirical anchor #1 — assumed handler / execution path:** Sub-cohort (c) on 2026-05-03. PRD §4 said "extend the `transition_to_closed_won` / `_lost` handlers to insert a Deal row alongside the existing Pipeline stage transition." Pre-flight grep returned only type-literal + catalog entries from `threshold-gate.ts:36-37` + `:92-97`. Zero dispatcher matches across the repo. The "existing handler" the PRD said to extend simply doesn't exist — these action types get APPROVED by the threshold gate then... nothing. Same silent producer-side-only class as KAN-783's "18 decisions / 0 actions" symptom.

**Empirical anchor #2 — assumed schema field:** Same sub-cohort (c), pre-flight #4 on 2026-05-03. PRD §4 / Edit 4 / Q9.3 specified `Deal.value = Contact.metadata?.dealValue ?? null` and `Deal.currency = Contact.metadata?.dealCurrency ?? "USD"` for sourcing the deal's value/currency. Empirical schema check (`sed -n '/^model Contact {/,/^}/p' packages/db/prisma/schema.prisma`) found the `Contact` model has `externalIds Json` (CRM IDs, semantically wrong for deal values) and `microObjectiveProgress Json` (KAN-700 MO tracking, semantically wrong) JSON columns, but **no `metadata` field**. The "free-form metadata blob the PRD assumed" simply doesn't exist on the Contact model. **Workaround:** hardcode `value=null`, `currency="USD"` defaults for Phase 1; file follow-up ticket [KAN-790](https://axisone-team.atlassian.net/browse/KAN-790) for value-enrichment as a separate product decision (typed columns vs. metadata blob vs. decision-scope source).

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

## Discipline going forward — PRD authors (THREE verification dimensions)

Three orthogonal pre-flight checks before specifying anything that "extends," "uses," or "alongside-existing-X" a code/schema artifact:

### (1) Path verification (sibling pattern: `feedback_prd_path_systematic_error_apps_vs_packages`)

Before writing "create file X" or "edit file Y", confirm the path empirically:
```bash
find apps packages -type f -name "*.ts" -path "*/services/*" | head
ls apps/api/src/services/threshold-gate.ts 2>&1 || ls packages/api/src/services/threshold-gate.ts
```
3-of-4 wrong PRD §4 paths in sub-cohort (b) caught this way.

### (2) Execution-path verification (this entry's anchor #1)

Before writing "extend handler X", confirm handler X is wired into a dispatcher, not just defined as a type or catalog entry:
```bash
grep -rn "case ['\"]<actionType>['\"]\|<actionType>:" --include='*.ts' \
  packages/api/ apps/ | grep -v node_modules | head
```
If only TYPE LITERALS (single-quoted strings in unions) and CATALOG ENTRIES (object-literal keys in const config) come back, the handler **isn't wired**. Treat as missing infrastructure: either include the executor implementation explicitly in scope, OR explicitly note the **decoupled approach** in the PRD (write outcome directly, defer executor to separate ticket — what KAN-786 sub-cohort (c) chose, see KAN-789 for the deferred executor).

Distinguish PRD claims at three execution-layer levels: (a) *type/catalog is defined* → cheap grep. (b) *handler is dispatched* → switch case / dispatcher entry. (c) *handler executes side effects* → what code runs in the case body. (a) without (b)/(c) is the trap.

### (3) Schema-field verification (this entry's anchor #2)

Before writing "use field X.foo" or "default to X.bar ?? value", confirm the field exists on the model:
```bash
sed -n '/^model X {/,/^}/p' packages/db/prisma/schema.prisma | grep -E "foo|bar"
# If zero matches: the field doesn't exist
```
If the field doesn't exist, options are:
- **Add the field in scope** (new schema migration in same PR — only if the schema change is cheap and product-clear)
- **Use defaults + file enrichment follow-up** (what KAN-786 sub-cohort (c) chose for `Contact.metadata` — hardcoded `value=null`/`currency="USD"`, KAN-790 tracks the enrichment product decision)
- **Use the closest semantically-correct existing field** — only if there genuinely is one. Existing fields with wrong semantics (e.g., `externalIds` for deal values) don't count; binding to wrong semantics is worse than defaults.

The "is `X.metadata` actually on the model?" check is 5 seconds of `sed` + `grep`. Cheaper than discovering during implementation.

---

## Discipline going forward — PRD reviewers

When reviewing PRDs that say "extend handler X" or "alongside the existing Y" or "use field X.foo", ask three questions:

1. **"Where does file X actually live?"** — sample 1-2 paths via `ls`, confirm
2. **"Where does handler X actually execute?"** — if author can't point at the executor file/line, that's a flag
3. **"What field on model X holds Y?"** — `sed`/`grep` schema.prisma; if the field doesn't exist, ask whether the PRD adds it or uses defaults

The 30-second triple-grep at PRD review time is cheaper than catching divergences across multiple sub-cohort implementations 2 weeks later.

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

- `docs/prds/phase-1-deal-engagement.md` — §4 amended in commits `dd94027` (anchor #1, transition-executor decoupling) + the upcoming amendment for anchor #2 (drop Contact.metadata references; defer to KAN-790)
- [KAN-786](https://axisone-team.atlassian.net/browse/KAN-786) — Phase 1 ticket
- [KAN-789](https://axisone-team.atlassian.net/browse/KAN-789) — missing transition executor (anchor #1's resolution)
- [KAN-790](https://axisone-team.atlassian.net/browse/KAN-790) — value-enrichment decision (anchor #2's resolution)
- [KAN-783](https://axisone-team.atlassian.net/browse/KAN-783) — broader 18 decisions / 0 actions class; KAN-789 is one cause
- [`feedback_prd_path_systematic_error_apps_vs_packages.md`](./feedback_prd_path_systematic_error_apps_vs_packages.md) — sibling pattern at the path-verification dimension; this entry covers execution-path + schema-field dimensions

**Three-pattern PRD-spec-vs-reality triple now canonized:** path layer (sibling entry above), execution-path layer (anchor #1 here), schema-field layer (anchor #2 here). All three caught via empirical pre-flight grep discipline during KAN-786 sub-cohort (c). Pattern recurrence (4 PRD §4 divergences across 2 sub-cohorts: paths/idempotency/handlers/fields) suggests PRD authoring needs systematic empirical-grounding step before any "extend"/"alongside"/"use field"/"wire into" claims.

---

## Status

**Active.** Pattern applies to all future PRDs in this repo. Distinct from `feedback_prd_path_systematic_error_apps_vs_packages` — both are PRD-spec-vs-reality drift but at different layers (file location vs runtime behavior). Retiring conditions: (a) PRD-lint that runs grep-checks on every "extend" / "alongside existing" claim, or (b) team standardizes on a code-organization where every action type maps 1:1 to a checked-in executor file (would make missing-executor structurally impossible).
