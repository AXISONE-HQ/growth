# KAN-904 — AI Entity Detection Fixtures

Synthetic CSVs for the **product-review gate** on Cohort 2.2 (PR 4/8).

These fixtures are **not** consumed by automated tests — those mock
`llm-client.complete()` with hand-written response strings. These files
are for the human-in-the-loop accuracy check against live Haiku before
the PR is authorized for merge.

## How to use

1. Render the user prompt for one of these fixtures via
   `buildDetectionUserPrompt({ fileName, detectedHeaders, sampleRows })`.
2. Send the prompt to Haiku (or paste into the Anthropic console).
3. Compare actual `entity_type` / `confidence` vs. the expected values
   in the table below.

The first 5 rows of each fixture are the "sample rows" Haiku sees;
that's the same payload pattern that the production
`csv-import-inspector` produces.

## Expected classifications

| Fixture | Expected `entity_type` | Expected confidence band | Notes |
|---|---|---|---|
| `contacts-only.csv`  | `contacts`  | high (≥ 85) | Classic contact-list shape: email + first/last name + phone + lifecycle_stage + source. Any classification other than `contacts` is a regression. |
| `companies-only.csv` | `companies` | high (≥ 85) | B2B account shape: name + domain + industry + employee_count + annual_revenue + billing_city. No people fields. |
| `deals-only.csv`     | `deals`     | high (≥ 85) | Pipeline-record shape: deal_name + amount/currency + stage + expected_close_date + owner_email. |
| `orders-only.csv`    | `orders`    | high (≥ 85) | Transactional shape: order_number + total + placed_at + payment_method + customer_email. |
| `mixed.csv`          | `mixed`     | normal-to-high (65-90) | Explicit `record_type` discriminator column plus both contact-shape and company-shape columns. A classifier that returns just `contacts` or just `companies` is missing the mixed signal — minor regression. Returning `mixed` is the win. |
| `ambiguous.csv`      | `unknown` OR low-confidence anything | low (< 50) | Headers `name`, `value`, `date`, `type` have no domain-specific signal. We *want* the model to admit uncertainty here (low confidence → coerced to `unknown` by the service). A high-confidence classification on this fixture would be a hallucination red flag. |

## Smoke procedure (post-PR-open)

```bash
# For each fixture, render the prompt + send to Haiku.
# Sample (pseudocode):
node -e "
  import('./packages/api/src/services/import-detection.js').then(m => {
    const job = { fileName: 'contacts-only.csv', detectedHeaders: ['email','first_name','last_name','phone','lifecycle_stage','source'], sampleRows: parseFirst5Rows('contacts-only.csv') };
    console.log(m.buildDetectionUserPrompt(job));
  });
"
```

Or use the deployed `/imports/[id]` UI: upload each fixture, click
**Run detection**, eyeball the badge + reasoning.

## Acceptance gate

The PR is **not** merged until each of the 6 fixtures has been
classified live AND:

- All four "single-entity" fixtures (`contacts-only`, `companies-only`,
  `deals-only`, `orders-only`) classify with their expected
  `entity_type` at ≥ 80% confidence.
- `mixed.csv` is preferred at `mixed` but `contacts` / `companies` is
  acceptable if confidence < 75 (signal of uncertainty about row-level
  vs file-level classification).
- `ambiguous.csv` returns `unknown` OR any classification with
  confidence < 50 (which the service will coerce to `unknown`).

If accuracy is off, iterate on `DETECTION_SYSTEM_PROMPT` or
`buildDetectionUserPrompt` **before** merge — that's the whole point of
the product-review gate.

---

# KAN-905 — Field-mapping accuracy fixtures

The same 6 CSVs serve a second product-review gate: **field-mapping
accuracy**. Once detection lands a single-entity classification (one of
contacts/companies/deals/orders), `runFieldMapping` calls Haiku again
to suggest a `targetField` for each source column. Below are the
expected mappings.

**Scope**: only the 4 single-entity fixtures (contacts-only,
companies-only, deals-only, orders-only). `mixed.csv` and
`ambiguous.csv` are out of scope for V1 — `runFieldMapping` returns
`BAD_REQUEST` for `mixed` or `unknown` entity types.

## Expected mappings

### `contacts-only.csv` → entity `contacts`

| Source column        | Expected target | Expected confidence band |
|---|---|---|
| `email`              | `email`          | ≥ 95 |
| `first_name`         | `firstName`      | ≥ 95 |
| `last_name`          | `lastName`       | ≥ 95 |
| `phone`              | `phone`          | ≥ 95 |
| `lifecycle_stage`    | `lifecycleStage` | ≥ 85 |
| `source`             | `source`         | ≥ 85 |

Any column mapped to `skip` is a regression. The contacts universe
contains all 6 of these targets directly.

### `companies-only.csv` → entity `companies`

| Source column         | Expected target  | Expected confidence band |
|---|---|---|
| `name`                | `name`            | ≥ 95 |
| `domain`              | `domain`          | ≥ 95 |
| `industry`            | `industry`        | ≥ 85 |
| `employee_count`      | `sizeRange`       | 60-85 (model must reason about int → enum band; lower confidence acceptable) |
| `annual_revenue`      | `annualRevenue`   | ≥ 90 |
| `billing_city`        | `billingCity`     | ≥ 90 |

`employee_count → sizeRange` is the only tricky one (raw integer vs.
enum band like `range_51_200`). A lower-confidence map there is fine;
a `skip` is a regression.

### `deals-only.csv` → entity `deals`

| Source column         | Expected target              | Expected confidence band |
|---|---|---|
| `deal_name`           | `name`                        | ≥ 95 |
| `amount`              | `value`                       | ≥ 95 |
| `currency`            | `currency`                    | ≥ 95 |
| `stage`               | `stageName` (lookup)          | ≥ 80 (lookup target, model should prefer it over `status`) |
| `expected_close_date` | `expectedCloseDate`           | ≥ 95 |
| `owner_email`         | `contactEmail` (lookup) **OR** `ownerId` | 50-80 (ambiguous — both are defensible; we prefer `contactEmail` as the lookup-resolution path for owner-by-email semantics) |

`stage → stageName` exercises the **lookup-kind** target advertised
in the prompt. If the model picks `status` instead (the canonical
enum), that's a regression — `stageName` is the raw lookup key
intended for free-text stage names like "negotiation" or
"discovery".

### `orders-only.csv` → entity `orders`

| Source column         | Expected target              | Expected confidence band |
|---|---|---|
| `order_number`        | `orderNumber`                 | ≥ 95 |
| `total`               | `grandTotal`                  | ≥ 80 (`total` could also map to `totalAmount` — `grandTotal` is preferred since CSV "total" usually means "final amount after tax & discount") |
| `currency`            | `currency`                    | ≥ 95 |
| `placed_at`           | `placedAt`                    | ≥ 95 |
| `payment_method`      | `paymentMethod`               | ≥ 85 |
| `customer_email`      | `contactEmail` (lookup)       | ≥ 85 (model must prefer the lookup target since the column has an email, not an internal contact ID) |

## Acceptance gate (PR 5)

The PR is **not** merged until each of the 4 supported fixtures has
been mapped live AND:

- All canonical-target mappings hit their expected `targetField` at the
  expected confidence band.
- Lookup-target mappings (`deals/stage → stageName`,
  `deals/owner_email → contactEmail`, `orders/customer_email → contactEmail`)
  reach the lookup target — picking the canonical alternative
  (`status`, `ownerId`) is a regression.
- No row gets `targetField=skip` unless explicitly noted above.

If accuracy is off, iterate on `MAPPING_SYSTEM_PROMPT`, the per-entity
universe field descriptions, or the lookup-tag hint **before** merge.

## Validation script

`scripts/kan-905-mapping-fixture-validation.ts` (planned for
extension from KAN-904's script) runs each fixture through:
`buildMappingUserPrompt(syntheticJob, entityType, FIELD_UNIVERSE_BY_ENTITY[entityType])`
→ `complete({ tier: 'cheap', callerTag: 'import-field-mapping-validation' })`
→ `parseAndValidateMappingResponse(response.text, headers, universe)`
→ compare entries against the expected table above.

Total expected cost: 4 Haiku-4.5 calls × ~1500 input + 500 output
tokens ≈ $0.005.
