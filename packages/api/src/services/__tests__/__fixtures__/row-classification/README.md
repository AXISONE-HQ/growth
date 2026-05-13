# KAN-907 — Row Classification Fixtures

Synthetic CSVs for the **product-review gate** on Cohort 2.3 (PR 6/8).

These fixtures are **not** consumed by automated tests — those mock
`llm-client.complete()` + `downloadObject`. These files are for the
human-in-the-loop accuracy check against live Haiku + the
heuristic-vs-LLM split ratio before the PR is authorized for merge.

## How to use

1. Each fixture's headers + row count are documented below.
2. The validation script `scripts/kan-907-row-classification-validation.ts`
   (planned, mirrors KAN-904/905 pattern) parses each fixture, runs the
   production `runRowClassification` pipeline against an in-memory
   ImportJob shape, and reports:
   - Per-row classification (entity_type, confidence, source)
   - Per-fixture summary: heuristic vs LLM ratio, low-confidence flags
3. Compare results against the expected tables below.

## Expected behavior per fixture

### `contacts-batch.csv` — 10 rows, single-entity

| Expectation | Value |
|---|---|
| Detected entity type (PR 4) | `contacts` @ ≥85% |
| `runRowClassification` path | Single-entity heuristic-only |
| LLM batches | 0 |
| LLM cost | $0 |
| Heuristic ratio | 100% |
| Skipped rows | 0 |
| Staged into | `import_staging_contacts` |
| `review_recommended` | 0 (high-confidence single-entity path) |

### `orders-batch.csv` — 10 rows, single-entity

| Expectation | Value |
|---|---|
| Detected entity type (PR 4) | `orders` @ ≥85% |
| `runRowClassification` path | Single-entity heuristic-only |
| LLM batches | 0 |
| Skipped rows | 0 |
| Staged into | `import_staging_orders` |
| `review_recommended` | 0 |

### `mixed-discriminator.csv` — 10 rows, mixed-entity with `record_type` column

| Expectation | Value |
|---|---|
| Detected entity type (PR 4) | `mixed` @ ≥85% |
| `runRowClassification` path | Full heuristic + (likely no LLM) |
| LLM batches | 0 (discriminator rule fires at 100%) |
| Heuristic ratio | 100% |
| Per-entity counts | 3 contacts, 3 companies, 2 orders, 2 deals |
| `review_recommended` | 0 (all 100% confidence via rule (a)) |

### `mixed-ambiguous.csv` — 10 rows, mixed-entity WITHOUT discriminator

| Expectation | Value |
|---|---|
| Detected entity type (PR 4) | `mixed` @ ≥85% |
| `runRowClassification` path | Heuristic + LLM batch |
| LLM batches | 1 (≤50 rows, all in one batch) |
| Heuristic ratio | ~50-70% (most rows have distinctive signals) |
| LLM ratio | ~30-50% (ambiguous rows that don't trigger rules) |
| Expected per-entity counts | ~3 contacts, ~3 companies, ~2 orders, ~2 deals (mirroring discriminator fixture but with lower confidence) |
| `review_recommended` | Likely 2-5 rows (boundary heuristic 80% + low-confidence LLM) |

### `edge-empty.csv` — 5 rows, mostly empty

| Expectation | Value |
|---|---|
| Detected entity type (PR 4) | could vary; brief flagged this fixture as out-of-scope for V1, but row classifier should still handle it gracefully |
| `runRowClassification` path | Rule (f) empty-check fires for 3 of 5 |
| Skipped rows | 3 (the all-empty rows) |
| Staged | 1 contact (alice@a.com row) + 1 unknown ("trailing,value" row may stage as unknown via LLM) |
| LLM batches | Possibly 1 (for the "trailing,value" weird row) |

## Acceptance gate

PR 6 is **not** merged until:

- Single-entity fixtures (`contacts-batch`, `orders-batch`) produce 0
  LLM calls and stage 100% of non-empty rows correctly.
- `mixed-discriminator` produces 0 LLM calls (discriminator rule must
  fire) and per-entity counts match the expected distribution.
- `mixed-ambiguous` produces ≤1 LLM batch, and the per-entity counts
  approximately mirror the discriminator fixture (within ±2 per entity).
- `edge-empty` correctly classifies the 3 empty rows as `skipped` with
  no LLM call required.

## Validation script (planned)

`scripts/kan-907-row-classification-validation.ts` (untracked, mirrors
KAN-904/905 scripts). Parses each fixture + invokes
`runRowClassification` against a synthetic in-memory ImportJob shape +
stubbed prisma + real `complete()` for the LLM batches.
