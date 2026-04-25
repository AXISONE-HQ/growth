# Email deliverability — `growth.axisone.ca`

**Domain:** `growth.axisone.ca`
**Provider:** Resend (region `us-east-1`)
**DNS host:** GoDaddy (`ns31.domaincontrol.com`, `ns32.domaincontrol.com`)
**Status:** Verified on Resend; sending live (KAN-662 confirmed end-to-end).
**Known issue:** Hotmail/Outlook (M365 ATP) routes first sends to spam. KAN-687 tracks the hardening.
**Last audited:** 2026-04-25

This doc is the baseline. Update the audit block whenever DNS or Resend config changes.

---

## Current DNS state

Captured `2026-04-25` via `dig @8.8.8.8` (Google public resolver), cross-checked against `1.1.1.1` for the DKIM record.

```text
# Subdomain SPF
$ dig +short TXT growth.axisone.ca
(empty — no record)

# Subdomain DMARC
$ dig +short TXT _dmarc.growth.axisone.ca
(empty — no record; falls back to parent _dmarc.axisone.ca via DMARC inheritance)

# Subdomain MX
$ dig +short MX growth.axisone.ca
(empty — sender-only, no inbound mail)

# DKIM (Resend's default selector)
$ dig +short TXT resend._domainkey.growth.axisone.ca
"p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDCtpgCNeNc4fcPwRKneCozBi3Dztol5DEZze+Soq
vT1lXk9hfS5Umauo4SLnfGBQ64rwxD1VAvsQ/oqg3/Z4zCz1T8oMlG8UjxmDOOVy+eqW/QSLYZknYBbzh
PtjBM+IfPAfym6nMjikmui9m9/hfXSreOiLnaBHLHIJcSgltRQIDAQAB"

# Resend bounce subdomain — MX (for AWS SES bounce processing under Resend)
$ dig +short MX send.growth.axisone.ca
10 feedback-smtp.us-east-1.amazonses.com.

# Resend bounce subdomain — SPF
$ dig +short TXT send.growth.axisone.ca
"v=spf1 include:dc-fd741b8612._spfm.send.growth.axisone.ca ~all"

# Macro expansion of the SPF include
$ dig +short TXT dc-fd741b8612._spfm.send.growth.axisone.ca
"v=spf1 include:amazonses.com ~all"
```

### Parent zone (`axisone.ca`) — for inheritance context

```text
# SPF
$ dig +short TXT axisone.ca
"v=spf1 include:dc-aa8e722993._spfm.axisone.ca ~all"

# DMARC — applies to subdomains via inheritance unless overridden
$ dig +short TXT _dmarc.axisone.ca
"v=DMARC1; p=reject; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;"
```

---

## Resend's expected records

The Resend API key bound to `growth-resend-key:latest` is a **Sending-scope** key — `GET /domains` returns `401 restricted_api_key`. The canonical "what should be there" needs to come from one of:

- The Resend dashboard (**Settings → Domains → growth.axisone.ca → DNS records**), OR
- A temporary Domains-scope API key — pull `GET /domains/{domain_id}` and stash the response in this doc.

Until that's pulled, this section reflects what we infer from the dig output + Resend's standard auto-config pattern (Resend partners with GoDaddy via the GoDaddy DNS API, so present records are almost certainly what Resend asked for):

| Record | Type | Value | Status |
|---|---|---|---|
| `resend._domainkey.growth.axisone.ca` | TXT | RSA public key (1024-bit) | ✅ present |
| `send.growth.axisone.ca` | MX | `10 feedback-smtp.us-east-1.amazonses.com` | ✅ present |
| `send.growth.axisone.ca` | TXT | `v=spf1 include:dc-fd741b8612._spfm.send.growth.axisone.ca ~all` | ✅ present |

Resend does **not** by default write `_dmarc.<subdomain>` or apex SPF on the sender subdomain — those are operator-owned. See **Recommendations** below.

---

## Drift

No drift between Resend's auto-config and current DNS — every record Resend was supposed to write is present. The deliverability gap is in operator-owned records that Resend never writes (DMARC, key rotation policy).

---

## DMARC posture

Subdomain `growth.axisone.ca` has **no explicit DMARC record**. Per RFC 7489 §6.6.3, receivers will look up `_dmarc.<subdomain>` first, fall back to `_dmarc.<organizational-domain>` (`_dmarc.axisone.ca`), and apply that policy. So the **inherited** posture is:

```
v=DMARC1; p=reject; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;
```

| Field | Value | Implication |
|---|---|---|
| `p=reject` | strictest | receivers MUST drop unauthenticated mail |
| `sp=` | absent → defaults to `p=reject` | subdomains inherit reject posture |
| `adkim=r` | relaxed | DKIM `d=` only needs to share orgdomain with `From:` (so `d=growth.axisone.ca` aligns with `From: hello@growth.axisone.ca`) |
| `aspf=r` | relaxed | SPF return-path `send.growth.axisone.ca` aligns with `From:` `growth.axisone.ca` (both share `axisone.ca`) |
| `rua` | `dmarc_rua@onsecureserver.net` | GoDaddy-hosted DMARC reporting; we don't see the reports directly |
| `ruf` | absent | no forensic reports |
| `pct` | absent → 100% | full enforcement |

**KAN-662 send analysis.** All 3 sends had:
- DKIM signed by `d=growth.axisone.ca` → DKIM alignment passes.
- Return-Path `bounces@send.growth.axisone.ca` → SPF passes (via `_spfm` macro). SPF alignment passes (relaxed; orgdomain match).
- → DMARC passes.

So the Hotmail spam-folder placement is **not** a DMARC failure. It's a reputation/policy signal Microsoft applies at the inbox-vs-spam decision layer. Fixes are reputation-based (warmup, recipient engagement, Microsoft SNDS), not DMARC-tightening.

### 30-day DMARC tightening schedule (proposed)

This applies once we add the explicit subdomain record per Recommendations §1.

| Day | Subdomain DMARC posture |
|---|---|
| 0   | `p=none; pct=100; rua=mailto:dmarc-rua@axisone.ca; ruf=mailto:dmarc-ruf@axisone.ca; fo=1;` (collect baseline) |
| 7   | If 7d of clean rua reports: `p=quarantine; pct=25;` (partial quarantine on failures) |
| 14  | If clean: `p=quarantine; pct=100;` |
| 21  | If clean: `p=reject; pct=25;` |
| 30  | If clean: `p=reject; pct=100;` (matches parent posture, with own rua) |

Pause/back off on any uptick in failures in `rua`. The schedule is an upper bound, not a SLA.

---

## Recommendations

Three prioritized DNS changes. Fred owns GoDaddy edits; nothing changes here without his go-ahead.

### REC 1 — HIGH — Add explicit subdomain DMARC record

**Why.** Today the subdomain inherits parent's `p=reject` policy with `rua` going to GoDaddy's dmarc_rua mailbox we can't read. Adding our own subdomain record gives us:
- Direct control over the policy on this subdomain (independent of parent — we can monitor without weakening parent's posture)
- An rua mailbox we own → we see the reports
- A `ruf` mailbox for forensic samples on individual failures (when `fo=1`)
- Explicit `pct` for staged tightening per the schedule above

**Record to paste into GoDaddy** (Type: `TXT`, Host: `_dmarc.growth`, TTL: 1 hour):

```
v=DMARC1; p=none; adkim=r; aspf=r; pct=100; rua=mailto:dmarc-rua@axisone.ca; ruf=mailto:dmarc-ruf@axisone.ca; fo=1;
```

> Starting at `p=none` is a one-step **loosening** from inherited `p=reject` — that's intentional, to collect baseline rua data risk-free during the audit window. Tighten per the 30-day schedule above. If you'd rather match the parent's posture immediately and skip the monitoring window, swap `p=none` → `p=reject` in the record above. Recommend the staged path because we have a known reputation issue (Hotmail spam) and want failure visibility before re-locking.

**Prerequisite:** the `dmarc-rua@axisone.ca` and `dmarc-ruf@axisone.ca` mailboxes must accept mail. Use a mail-handling service (DMARC.org has a list) or just a regular monitored inbox. Volume is typically <10 reports/day for a low-traffic sender.

### REC 2 — MEDIUM — Rotate DKIM key from 1024-bit to 2048-bit

**Why.** The current key at `resend._domainkey.growth.axisone.ca` is **1024-bit RSA** (DER size 162 bytes, modulus 128 bytes). Modern best practice has been 2048-bit since ~2018 (Google, Microsoft, ICANN guidance). Some receivers downgrade trust on 1024-bit signatures. 1024-bit is no longer considered cryptographically robust against well-resourced adversaries.

Resend's current default may be 1024 for legacy compatibility. Request a key rotation to 2048-bit via:
- Resend support, OR
- Resend dashboard if a "rotate DKIM" / "key length" toggle exists, OR
- Re-add the domain with the 2048 option (if their setup wizard offers it now)

**Action for Fred:** check Resend dashboard for a key-rotation control. If absent, file a Resend support ticket: *"Please rotate the DKIM key for growth.axisone.ca to 2048-bit. The current selector `resend._domainkey` returns a 1024-bit RSA key."* The new public-key TXT record will be auto-written by Resend's GoDaddy integration; verify with `dig` after the change.

> No record text here because the value is generated by Resend.

### REC 3 — LOW — Defer apex SPF on `growth.axisone.ca` until mail-tester says otherwise

**Why we're NOT recommending one yet.** SPF on the subdomain apex is not strictly required:
- SPF only authenticates the envelope-from (return-path), which is `bounces@send.growth.axisone.ca`. `send.` already has SPF.
- DMARC SPF alignment passes via relaxed mode (orgdomain match).
- Adding apex SPF that doesn't include Resend's IPs would be cosmetic; adding one that does include them is redundant with the `send.` subdomain SPF.

Some receivers (Microsoft historically) prefer to see *something* at the apex. If `mail-tester.com` flags missing apex SPF in the next harness run (Pending §1), add this neutral record as a follow-up:

```
v=spf1 include:_spf.resend.com ~all
```

Validate `_spf.resend.com` resolves and includes Resend's sending IPs before publishing. Skip otherwise.

---

## Pending operational tasks

Tracked under KAN-687.

- [ ] **Run mail-tester baseline** — Fred grabs a fresh address from <https://www.mail-tester.com/> and runs `npx tsx scripts/mail-tester-send.ts <address>` (see harness below). Refreshes the URL within 5 min for the score. Update the `Last audited` block at the top of this doc with: score, key findings, date.
- [ ] **Provision rua / ruf mailboxes** — `dmarc-rua@axisone.ca`, `dmarc-ruf@axisone.ca` (or equivalent). Prerequisite for REC 1.
- [ ] **Apply REC 1 (DMARC at subdomain)** — paste record into GoDaddy after mailboxes exist. `dig` to verify.
- [ ] **Apply REC 2 (DKIM key length)** — file Resend ticket or use dashboard control. `dig` the selector after rotation.
- [ ] **Microsoft SNDS registration** — <https://sendersupport.olc.protection.outlook.com/snds/> for visibility into Outlook reputation. Requires Resend's sending IP block, which Resend support can provide. Optional but high-leverage for the Hotmail problem.
- [ ] **Microsoft JMRP enrollment** — <https://sendersupport.olc.protection.outlook.com/pm/> for "marked as junk" feedback on Microsoft inboxes. Optional.
- [ ] **Subdomain split decision** — keep `growth.axisone.ca` for transactional or split into `tx.growth.axisone.ca` (transactional) and `news.growth.axisone.ca` (marketing-grade). Strategic decision tied to KAN-473 (per-tenant identity).
- [ ] **Sender warmup schedule** — `scripts/sender-warmup.ts` (see "Warmup playbook" below). Daily invocation, day 1–14 ramp. Independent of REC 1+2 — warmup is reputation work, not DNS work.

---

## Harness — mail-tester runbook

`scripts/mail-tester-send.ts` publishes one `ActionSendEvent` through the production Resend pipeline (same code path as KAN-662 Phase E — no shortcuts). Output includes the worker's Resend `data.id` for cross-reference.

```sh
# 1. Grab a fresh address from https://www.mail-tester.com/ (don't refresh until step 3).
# 2. Send via the production pipeline:
PHASE_E_TENANT_ID=9ca85088-f65b-4bac-b098-fff742281ede \
PHASE_E_CONNECTION_ID=35ad29cd-9c96-4a05-8b90-ec3376936d1d \
npx tsx scripts/mail-tester-send.ts test-xxxxxxxx@srv1.mail-tester.com
# 3. Within 5 min, refresh the mail-tester URL to read the score.
# 4. Paste the score and the key findings (red flags) into the audit block at the top of this doc.
```

The same env vars from KAN-662 Phase E are reused so we test through the live demo connection (`hello@growth.axisone.ca`).

---

## Warmup playbook

`scripts/sender-warmup.ts` ramps sender volume on a schedule Microsoft tolerates while reputation builds. Manual-invoke (no cron). Runs against the production Pub/Sub → connectors-worker → Resend path — same code path as KAN-662, no shortcuts.

### Invocation

```sh
# Preview the day-N batch (recipients + subjects). State file NOT updated.
PHASE_E_TENANT_ID=9ca85088-f65b-4bac-b098-fff742281ede \
PHASE_E_CONNECTION_ID=35ad29cd-9c96-4a05-8b90-ec3376936d1d \
npx tsx scripts/sender-warmup.ts --day 1 --dry-run

# Live send for the day.
PHASE_E_TENANT_ID=9ca85088-f65b-4bac-b098-fff742281ede \
PHASE_E_CONNECTION_ID=35ad29cd-9c96-4a05-8b90-ec3376936d1d \
npx tsx scripts/sender-warmup.ts --day 1

# Day-7 / day-14 placement check (one realistic message to Hotmail).
PHASE_E_TENANT_ID=9ca85088-f65b-4bac-b098-fff742281ede \
PHASE_E_CONNECTION_ID=35ad29cd-9c96-4a05-8b90-ec3376936d1d \
npx tsx scripts/sender-warmup.ts --hotmail-check
```

### Schedule

| Day | Volume target | Notes |
|---:|---:|---|
| 1   |   3 | one per inbox |
| 2   |   5 | mix of inboxes, varied subjects |
| 3   |   8 | |
| 4   |  13 | |
| 5   |  21 | |
| 6   |  34 | |
| 7   |  50 | **CHECKPOINT** — Hotmail placement check (`--hotmail-check`). If still spam, hold the ramp; don't advance to day 8. |
| 8–13|  50 | sustained |
| 14  |  50 | **CHECKPOINT** — second Hotmail placement check. If still spam, escalate (see "If day 7 / day 14 still shows spam" below). |

Edit the `SCHEDULE` constant at the top of the script to flatten the curve. The script enforces a per-recipient daily cap (`PER_RECIPIENT_DAILY_CAP`, default 4) — if the schedule asks for more than `recipient_pool × cap`, the batch auto-truncates and prints a warning. With the current 3-inbox pool, anything past day 3 truncates at 12.

### Idempotency

State at `/tmp/sender-warmup-state.json`. A `--day N` rerun within 12 hours is a no-op with a clear log line. Override path with `WARMUP_STATE_FILE=<path>`. Move or `rm` the state file to force a re-run within the window.

`--dry-run` does NOT update state. `--hotmail-check` is independent of the schedule and ignores state.

### Microsoft signals to watch

After each live run check Cloud Logging for the worker's per-message dispatch — that's send-side success. The actual deliverability signal is in the inbox:

| Signal | Where | Means |
|---|---|---|
| Hotmail inbox | `frederic.binette@hotmail.com` Inbox folder | reputation is recovering ✓ |
| Hotmail spam | `frederic.binette@hotmail.com` Junk folder | SmartScreen still distrustful — ramp needs more days OR escalate |
| Gmail inbox | both Gmail addresses | baseline (Gmail is more lenient) |
| DMARC rua reports | once REC 1 mailbox exists | per-IP / per-receiver pass/fail counts |
| Resend dashboard | <https://resend.com/emails> | bounces, complaints, delivery latency |

### If day 7 / day 14 still shows spam

In order of escalation:

1. **Hold the ramp.** Don't advance days. Run day-N again with the same volume for 2–3 more days to give Microsoft more reputation samples.
2. **Manually move spam → inbox** on the Hotmail account. Recipient engagement (move from spam, mark as not-spam, reply) is the strongest single positive signal Microsoft's filter consumes.
3. **Register for Microsoft SNDS** — <https://sendersupport.olc.protection.outlook.com/snds/>. You'll need Resend's sending IP block from Resend support. SNDS gives daily per-IP reputation visibility.
4. **Enroll in Microsoft JMRP** — <https://sendersupport.olc.protection.outlook.com/pm/>. Surfaces "marked as junk" feedback into a feedback loop.
5. **Confirm List-Unsubscribe is RFC-8058 compliant.** As of 2026-04-25 the adapter wires `List-Unsubscribe-Post: List-Unsubscribe=One-Click` but the `List-Unsubscribe` header value is `mailto:` only — RFC 8058 requires HTTPS for the one-click claim. Microsoft weights this. Tracked as a separate finding (filed during this task; see PR description).
6. **Wait 7 more days,** then re-test. Reputation isn't fast.

If after 30 days at sustained volume Hotmail is still spam-foldering, the next lever is the subdomain split (KAN-473) — segregate transactional traffic onto its own subdomain so marketing/wedge sends don't drag transactional reputation down with them.

---

## Cross-references

- KAN-662 — Phase E, established the baseline send (3/3 accepted, all delivered; Hotmail spam)
- KAN-684 — Resend webhook event handler (delivered/bounce/complaint feedback into our pipeline)
- KAN-473 — per-tenant Resend identity (subdomain split lives here strategically)
- KAN-687 — this work
