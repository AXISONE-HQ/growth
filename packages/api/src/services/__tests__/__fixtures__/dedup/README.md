# Cohort 2.6 Dedup Fixtures (KAN-911)

Reference data for the rule-based + Levenshtein duplicate-detection matchers.
Paired with `import-dedup.test.ts` for matcher validation.

## Files

| File                          | Purpose                                                   |
| ----------------------------- | --------------------------------------------------------- |
| `existing-tenant-data.json`   | Canonical entities (Contact/Company/Deal/Order) that the matchers compare against — what's already in the tenant's CRM. |
| `staging-dedup.json`          | Staged rows from a freshly-uploaded import. Each row is annotated with the matcher path it exercises. |

## Coverage Map (staging → expected decision)

### Contacts
| sourceRowIndex | Path                                | Expected signal             | Score | Suggested action |
| -------------- | ----------------------------------- | --------------------------- | ----- | ---------------- |
| 0              | email exact                          | `email_exact`               | 100   | `update`         |
| 1              | phone NANP fallback                  | `phone_exact`               | 95    | `update`         |
| 2              | name fuzzy + same company boost      | `name_fuzzy`                | ≥ 85  | `needs_review`   |
| 3              | bucket-skip (different first letter) | —                           | 0     | `insert`         |

### Companies
| sourceRowIndex | Path             | Expected signal       | Score | Suggested action |
| -------------- | ---------------- | --------------------- | ----- | ---------------- |
| 0              | domain exact     | `domain_exact`        | 100   | `update`         |
| 1              | name fuzzy       | `name_fuzzy`          | ≤ 94  | `needs_review`   |
| 2              | legal-name fuzzy | `legal_name_fuzzy`    | ≤ 94  | `needs_review`   |
| 3              | no match         | —                     | 0     | `insert`         |

### Deals
| sourceRowIndex | Path                                | Expected signal              | Score | Suggested action |
| -------------- | ----------------------------------- | ---------------------------- | ----- | ---------------- |
| 0              | name + email + 30d window            | `close_date_window` + 2 more | 90    | `needs_review`   |
| 1              | name + email only (out of window)    | `name_fuzzy` + `contact_email_exact` | ≤ 85  | `needs_review`   |
| 2              | name match, different email          | —                            | 0     | `insert`         |

### Orders
| sourceRowIndex | Path                                | Expected signal                | Score | Suggested action |
| -------------- | ----------------------------------- | ------------------------------ | ----- | ---------------- |
| 0              | providerOrderId exact                | `provider_order_id_exact`      | 100   | `update`         |
| 1              | orderNumber + email + 24h window     | 3 signals incl. `placed_at_window` | 90    | `needs_review`   |
| 2              | orderNumber alone                    | `order_number_exact`           | 95    | `update`         |
| 3              | no match                             | —                              | 0     | `insert`         |

## Why these specific rows?

Cohort 2.6 ships 7 design decisions (A–G). The fixtures cover every load-bearing
one: NANP phone fallback (decision C), eager-join contact email for deals/orders
(decision D), first-letter bucket pre-filter (decision E), canonical signal names
(decision F), fuzzy-cap 94 (decision B). Decisions A (company 3-rule) and G
(`fastest-levenshtein` choice) are exercised by the company fixtures + every
fuzzy comparison respectively.

The trigram-bucketing upgrade (decision H follow-up, KAN-912) is out of scope —
fixtures will be re-exercised when that ticket lands.
