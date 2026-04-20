# SendGrid Adapter (KAN-473)

Transactional email via SendGrid using the **managed subuser** pattern —
AxisOne owns the master SendGrid account; each tenant gets an isolated
subuser with its own sender reputation, domain authentication, suppression
list, and quota.

## Files

| File               | Purpose                                                           |
| ------------------ | ----------------------------------------------------------------- |
| `index.ts`         | `SendGridAdapter` implementing `ChannelAdapter`                   |
| `client.ts`        | Singleton-aware subuser API key management + Secret Manager cache |
| `provisioning.ts`  | Subuser creation + scoped API key generation                      |
| `domain-auth.ts`   | Domain Authentication API + DNS records + DMARC suggestion        |
| `subdomain.ts`     | Shared `reply.{slug}.growth.axisone.com` fallback                 |
| `events.ts`        | Event webhook processor (delivered/bounce/open/spam/unsubscribe)  |
| `suppressions.ts`  | Per-tenant Redis suppression cache                                |
| `unsubscribe.ts`   | Signed unsubscribe tokens for List-Unsubscribe headers            |
| `signature.ts`     | Real ECDSA webhook signature verifier                             |
| `errors.ts`        | API status + event type → classification + side-effect            |
| `__tests__/`       | Vitest unit tests (errors, unsubscribe tokens)                    |

## End-to-End Flow

### Connect — Custom Domain

```
Tenant enters sending domain (e.g. acme.com) + From address
      ↓
POST connectors.connect (tRPC)
      ↓
provisionSubuser()      — creates SendGrid subuser + scoped mail.send API key
      ↓
requestDomainAuth()     — SendGrid returns 3 CNAME records
      ↓
UI shows DNS wizard (KAN-596) with records + provider-specific instructions
      ↓
Tenant adds records to DNS, clicks "Verify"
      ↓
triggerDomainVerification() → validateDomainAuth() → SendGrid checks DNS
      ↓
Connection status: PENDING → ACTIVE (when valid)
```

### Connect — Shared Subdomain Fallback

```
Tenant opts for shared subdomain (no custom domain)
      ↓
provisionSubuser() + provisionSharedSubdomain()
      ↓
Tenant uses `reply.{slug}.growth.axisone.com` — verified immediately
      ↓
Connection status: ACTIVE (aggressive rate caps apply, KAN-604)
```

### Send

```
Pub/Sub action.send
      ↓
subscriber.ts → adapter.send(connection, msg)
      ↓
isSuppressed(tenant, email)?  — Redis cache
      ↓ no
domainAuthStatus === 'verified'?
      ↓ yes
generateUnsubscribeToken() + buildUnsubscribeUrl()
      ↓
htmlToText() if HTML-only provided
      ↓
sendWithSubuserKey():
  sgMail.setApiKey(subuser key)
  sgMail.send({
    to, from, subject, html, text,
    headers: {
      List-Unsubscribe: <url>, <mailto:unsubscribe@...>,
      List-Unsubscribe-Post: List-Unsubscribe=One-Click
    },
    customArgs: { actionId, tenantId, connectionId, traceId },
    trackingSettings: { click, open }
  })
      ↓
Return providerMessageId — subscriber publishes action.executed
```

### Event Webhook

```
SendGrid POST /webhooks/sendgrid  (batch of up to 1000 events)
      ↓
ECDSA signature verify (timestamp window check + public key)
      ↓ valid
adapter.handleWebhook(events)
      ↓
processSendGridEvents() per event:
  delivered   → action.executed(status=delivered)
  bounce      → classify hard/soft; if hard → suppress + action.executed(failed)
  spamreport  → suppress + action.executed(failed) + spam rate alert
  unsubscribe → suppress + action.executed(suppressed)
  open/click  → tracking event only (future: learning signals)
      ↓
Publish action.executed per terminal event
```

### Unsubscribe Landing

```
User clicks unsubscribe link in email footer (or Gmail one-click)
      ↓
GET unsubscribe.growth.axisone.com/{token}  (main app @growth-ai/web)
      ↓
verifyUnsubscribeToken() — HMAC-SHA256 verify + 180-day expiry check
      ↓ valid
suppress(tenantId, email, 'unsubscribe')
      ↓
Render confirmation + "Resubscribe" option
      ↓
POST + List-Unsubscribe-Post=One-Click returns 200 for Gmail's one-click
```

## Required Secrets

| Secret                              | Payload                                        | Created when          |
| ----------------------------------- | ---------------------------------------------- | --------------------- |
| `sendgrid-master`                   | SendGrid master API key (full access)          | One-time ops setup    |
| `sendgrid-webhook-public-key`       | SendGrid webhook ECDSA public key (PEM)        | One-time ops setup    |
| `unsubscribe-signing-key`           | 32+ byte random string for HMAC-SHA256         | One-time, rotate quarterly |
| `{tenant_id}-sendgrid`              | `{apiKey, subuserUsername}`                    | On tenant `connect()` |

## Enabling the Adapter

1. Place master API key + webhook public key + signing key in Secret Manager
2. Grant `connectors-sa@...` `roles/secretmanager.secretAccessor` on each
3. Complete one-time DNS on `growth.axisone.com` for shared subdomain fallback (see KAN-602)
4. Set `ENABLE_SENDGRID=true` on the Cloud Run service
5. Configure the Event Webhook in SendGrid dashboard to point at `https://connectors.growth.axisone.com/webhooks/sendgrid` with signed-events enabled
6. Redeploy

## Deliverability Notes

- **Shared subdomain** tenants get aggressive rate caps (10% of custom-domain limits) to protect shared reputation
- **Dedicated IPs** arrive at Phase 2 (200+ tenants with consistent >50k emails/month)
- DMARC suggestion is `p=quarantine` — safe default that doesn't break delivery but starts visibility
- Open + click tracking is on by default; tenants can opt out per-send via `trackingSettings`

## Compliance Coverage

- CAN-SPAM: physical address required in email body (handled by tenant template); unsubscribe link in every send (handled here)
- CASL: explicit consent via double-opt-in (outside adapter scope); unsubscribe within 10 days (handled here via realtime event webhook)
- GDPR: right to be forgotten via `suppress()` API; data retention on SendGrid side governed by account policy
- RFC 8058: `List-Unsubscribe: <url>, <mailto>` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` on every send

## Ticket Status

| Ticket  | Status     | Notes                                                     |
| ------- | ---------- | --------------------------------------------------------- |
| KAN-499 | In Review  | Full `send()` with suppression gate + unsub headers       |
| KAN-500 | In Review  | Subuser provisioning + scoped mail.send API key           |
| KAN-501 | In Review  | Domain Authentication + DMARC suggestion                  |
| KAN-502 | To Do      | DNS wizard UI — lives in `@growth-ai/web`                 |
| KAN-503 | In Review  | Event webhook handler with spam-rate alert                |
| KAN-504 | In Review  | Shared subdomain fallback                                 |
| KAN-505 | To Do      | Settings UI — lives in `@growth-ai/web`                   |
| KAN-506 | In Review  | Suppression + unsubscribe infrastructure                  |
| KAN-587 | In Review  | Mail client factory with caching + mutex                  |
| KAN-588 | In Review  | List-Unsubscribe + List-Unsubscribe-Post headers          |
| KAN-589 | In Review  | html-to-text fallback auto-generation                     |
| KAN-590 | In Review  | Subuser + scoped API key creation                         |
| KAN-591 | In Review  | IP pool inheritance (dedicated IPs = Phase 2)             |
| KAN-592 | In Review  | Idempotent connect — existing subuser reused              |
| KAN-593 | In Review  | Domain Auth API call + persist records                    |
| KAN-594 | In Review  | DMARC policy recommendation                               |
| KAN-595 | In Review  | Verify endpoint via `triggerDomainVerification`           |
| KAN-599 | In Review  | ECDSA signature verification with timestamp window        |
| KAN-600 | In Review  | Batch event dispatcher                                    |
| KAN-601 | In Review  | 0.1% spam-rate alert threshold                            |
| KAN-602 | To Do      | One-time parent domain DNS setup (ops)                    |
| KAN-603 | In Review  | Auto-provision per-tenant subdomain                       |
| KAN-604 | In Review  | Rate cap policy on shared (enforcement = KAN-487)         |
| KAN-608 | In Review  | Per-tenant Redis suppression set                          |
| KAN-609 | In Review  | Signed unsubscribe tokens + URL builder (landing = web)   |
| KAN-610 | To Do      | Admin suppressions UI — lives in `@growth-ai/web`         |

## Local Testing

```bash
# Unit tests
npm run -w @growth-ai/connectors test

# Run the service against real SendGrid test creds
ENABLE_SENDGRID=true \
GCP_PROJECT_ID=growth-dev \
PUBLIC_WEBHOOK_BASE_URL=https://your-ngrok.ngrok.io \
npm run -w @growth-ai/connectors dev
```

SendGrid provides a [Mail Send sandbox](https://docs.sendgrid.com/api-reference/mail-send/mail-send#body)
(`mail_settings.sandbox_mode.enable=true`) that accepts all API calls without
actually delivering. Wire this into `send()` when running integration tests.

## Known Follow-ups

| Concern                                                    | Ticket      | Blocker?              |
| ---------------------------------------------------------- | ----------- | --------------------- |
| Persist `ChannelConnection` via Prisma                     | KAN-558     | Yes — blocks real connects |
| Settings + DNS wizard UI                                   | KAN-502/505/610 | Ships in web app   |
| Dedicated IP pool (Phase 2)                                | Post-MVP    | No                    |
| Tenant resolution from subuser in webhook router           | KAN-549     | No — events carry customArgs |
| Rate-limiting enforcement integration                       | KAN-487     | Adapter ready; needs Redis rate limiter wiring |
