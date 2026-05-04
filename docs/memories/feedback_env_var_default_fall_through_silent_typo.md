# feedback_env_var_default_fall_through_silent_typo

**Trigger:** Source-code defaults that look like dev placeholders (`?? 'leads.axisone.app'`, `.default('http://localhost:8081')`, etc.) become LOAD-BEARING in production whenever an env var gets missed during deploy. The default is supposed to be safe-for-dev; it silently falls through in prod and produces wrong-but-syntactically-valid output. For production-required values, fail-loud at boot via required env vars (no `.default()`, no `??` fallback).

**Empirical anchor (KAN-818, Sprint 9 close):** First multi-turn smoke produced AI email with `Reply-To: <inboxSlug>@leads.axisone.app`. The `.app` was a typo in the source-code default `LEAD_INBOX_DOMAIN: z.string().default('leads.axisone.app')` — set when the env var slot was scaffolded under the assumption it would always be set on deploy. It wasn't. growth-api Cloud Run service had `LEAD_INBOX_DOMAIN` unset → zod default fired → wrong-TLD Reply-To went out the door. Customer's reply (sent to the wrong-TLD address) never reached our inbound webhook → multi-turn loop broken.

**Two fixes:**

- **Fix 1 (gcloud env update):** `gcloud run services update growth-api --update-env-vars LEAD_INBOX_DOMAIN=leads.axisone.ca` → revision `growth-api-00157-fst`. Unblocked the multi-turn smoke immediately.
- **Fix 2b (structural, PR #103):** removed `.default('leads.axisone.app')` from the zod schema and the `??` fallback from 3 use-sites. Now zod throws at boot if the env var is unset; helper functions throw at use-site if the env var is missing at runtime. Pre-merge env-var verification on both growth-api and growth-connectors confirmed the env var IS set before merging the fail-loud change.

---

## The pattern

For every env var slot in the codebase, ask:

1. **Is this value needed in production?** If yes → no `.default()`, no `?? 'placeholder'` fallback. Required at boot (zod's `z.string()` without default throws on missing input). Required at use-site (helper throws if value happens to be empty string).

2. **Is the default a real default or a placeholder?** If it's a placeholder ("set this on deploy"), it's NOT a default — it's a typo waiting to fall through. Real defaults are values that work correctly in production (e.g. `LOG_LEVEL: z.string().default('info')` — production wants `info` if nothing else specified).

3. **Does the placeholder LOOK plausible?** That's worse — `'leads.axisone.app'` looked like a real domain (it's `.ca` in real life). The placeholder syntactically validates, semantically lies.

4. **Pre-merge: verify env var IS set on every deploy target** before merging a no-default change. If any target is missing it, the fail-loud change becomes an outage on next deploy. Pattern:
   ```sh
   gcloud run services describe SERVICE --region=us-central1 --format=json \
     | python3 -c "import json,sys; data=json.load(sys.stdin); env=data['spec']['template']['spec']['containers'][0].get('env',[]); print([e for e in env if e.get('name')=='VAR_NAME'])"
   ```

---

## Why empirically

**Three forces drove the discipline:**

1. **Silent fallthrough produces hard-to-diagnose bugs.** No log emitted, no error thrown, just wrong output. Took ~2 hours of debug to spot the `.app` vs `.ca` discrepancy in the AI email's Reply-To header — Fred caught it visually, not via logs.

2. **Defaults rot relative to truth.** `'leads.axisone.app'` was probably correct at scaffolding time (or a guess that nobody validated). The real domain is `leads.axisone.ca`. Defaults written ahead of infrastructure DRIFT from infrastructure. Required values stay current because deploy fails when they're wrong.

3. **Env-var hygiene compounds.** Every `.default()` saved a few keystrokes once and cost a multi-hour debug later. Removing them across the codebase (audit pattern: `grep -rn "\.default(" --include="*.ts" packages/api apps/`) preempts the entire class.

---

## Audit candidates

Files to sweep for similar fall-through risks (run `grep -rn "\.default(" --include="*.ts" packages/api apps/` and review each match):

- Any env-var schema with `.default('http://localhost:...')` — production should fail loud, not silently use localhost
- Any `process.env.X ?? 'placeholder-domain.example'` — same class
- Any `?? 'TODO'` / `?? 'replace-me'` strings — placeholder-as-default is the exact antipattern

**Real defaults that DO belong:**
- `LOG_LEVEL: z.string().default('info')` — production-correct value
- `PORT: z.coerce.number().default(8080)` — fine if standard port is right for the service
- `NODE_ENV: z.enum([...]).default('development')` — fine because every prod target overrides

---

## When to apply

- Every new env var slot: ask "production-required or convenience-default?" — pick one consciously
- Reviewing PRs that add `.default()` or `??` env-var fallbacks: flag for audit
- Sprint cleanup ticket: sweep existing env-var schemas + classify as required vs default

**When NOT to apply:**

- Genuinely optional config (feature flags that default-off, debug toggles)
- Values where the default IS the production value (LOG_LEVEL=info, NODE_ENV='production' for prod builds)
- Cases where production deployment process GUARANTEES the env var (rare — even gold-plated processes miss vars; see KAN-818)

---

## Cross-references

- KAN-818 PR #103 — origin (4-site Fix 2b removing silent defaults)
- KAN-816 PR #102 — sibling (the multi-turn smoke that surfaced the .app typo)
- `feedback_smoke_tenant_config_gaps_block_headline_outcomes.md` — sibling class (config gaps surfaced by smoke)
- `feedback_pubsub_route_registration_vs_subscription_config.md` — sibling structural class (config-against-assumed-shape)

---

## Status

**Active.** Apply as standard env-var hygiene discipline; sweep existing schemas in a future cleanup sprint.
