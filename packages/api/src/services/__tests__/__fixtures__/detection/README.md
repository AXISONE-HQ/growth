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
