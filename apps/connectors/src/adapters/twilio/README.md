# Twilio Adapter (KAN-472)

SMS via Twilio using the **managed subaccount** pattern — AxisOne owns the
master Twilio account; each tenant gets an isolated subaccount, Messaging
Service, phone number, and A2P 10DLC Brand + Campaign provisioned
automatically when they connect.

## Files

| File                   | Purpose                                                               |
| ---------------------- | --------------------------------------------------------------------- |
| `index.ts`             | `TwilioAdapter` implementing `ChannelAdapter`                         |
| `client.ts`            | Per-tenant Twilio SDK client factory with Secret Manager creds        |
| `provisioning.ts`      | Subaccount creation + phone number purchase                           |
| `messaging-service.ts` | Messaging Service creation + number attachment (KAN-567)              |
| `compliance.ts`        | 10DLC Trust Hub Brand + A2P Campaign submission (KAN-569/570)         |
| `status-poller.ts`     | Cron for polling 10DLC approval status (KAN-571)                      |
| `status-callback.ts`   | `/webhooks/twilio/status` handler — delivery status → action.executed |
| `signature.ts`         | Real HMAC-SHA1 webhook signature verifier                             |
| `errors.ts`            | Twilio error code → classification + side-effect                      |
| `keywords.ts`          | STOP/HELP/START detection + compliant auto-reply templates            |
| `optout.ts`            | Redis-backed per-tenant opt-out cache                                 |
| `__tests__/`           | Unit tests (errors, keywords)                                         |

## End-to-End Flow

### Connect

```
Tenant submits "About your business" form (KAN-581)
      ↓
POST connectors.connect (tRPC)
      ↓
provisionSubaccount()     — creates Twilio subaccount, stores creds in Secret Manager
      ↓
createMessagingService()  — creates Messaging Service with webhook URLs
      ↓
provisionPhoneNumber()    — searches + buys a number in the tenant's area code
attachNumberToService()   — attaches the number to the Messaging Service
      ↓
submitBrandAndCampaign()  — Trust Hub Brand + A2P Campaign (async 24–72h)
      ↓
buildConnectionRecord()   — assembles ChannelConnection (status: PENDING)
      ↓
Persist to channel_connections (TODO KAN-558)
      ↓
Return connection — UI shows "Pending 10DLC approval"
```

### Poll (every 4h via Cloud Scheduler)

```
pollAllTwilioConnections() → fetches pending connections
      ↓
For each: pollComplianceStatus() against Twilio Trust Hub
      ↓
Transition ACTIVE → publish connection.health.changed
Transition ERROR  → publish connection.health.changed + tenant alert
```

### Send

```
Pub/Sub action.send
      ↓
subscriber.ts → adapter.send(connection, msg)
      ↓
isOptedOut(tenant, phone)?  — channel-level STOP cache
      ↓ no
isSendable(compliance)?     — 10DLC approved?
      ↓ yes
client.messages.create({ messagingServiceSid, to, body, statusCallback })
      ↓
Return SendResult → subscriber publishes action.executed
```

### Inbound

```
Twilio POST /webhooks/twilio
      ↓
HMAC-SHA1 signature verify → 401 if invalid
      ↓
adapter.handleWebhook(parsedForm)
      ↓
detectKeyword(body)?
  STOP  → markOptedOut(tenant, phone) + auto-reply
  HELP  → auto-reply
  START → clearOptOut + auto-reply
  (all) → return InboundEvent (with _keyword tag)
None  → return InboundEvent
      ↓
Webhook router publishes inbound.raw to Pub/Sub
```

### Status Callback

```
Twilio POST /webhooks/twilio/status?actionId=...&connectionId=...&tenantId=...
      ↓
HMAC-SHA1 signature verify
      ↓
processTwilioStatusCallback(params, tenantId, actionId, connectionId)
      ↓
Classify any ErrorCode (21610 → opt-out, etc.)
      ↓
Publish action.executed with final status
```

## Required Secrets

| Secret                                  | Payload                                              | Created when          |
| --------------------------------------- | ---------------------------------------------------- | --------------------- |
| `twilio-master`                         | `{accountSid, authToken}` — master account creds     | One-time ops setup    |
| `{tenant_id}-twilio`                    | `{accountSid, authToken, messagingServiceSid?}`      | On tenant `connect()` |
| `twilio-subaccount-{accountSid}`        | Raw auth token (reverse lookup for sig verify)       | On tenant `connect()` |

## Enabling the Adapter

1. Place master Twilio credentials in Secret Manager: `twilio-master` → `{accountSid, authToken}`
2. Grant `connectors-sa@...` `roles/secretmanager.secretAccessor` on the above
3. Set `ENABLE_TWILIO=true` + `PUBLIC_WEBHOOK_BASE_URL=https://connectors.growth.axisone.com` on the Cloud Run service
4. Redeploy — `TwilioAdapter` self-registers and the real HMAC-SHA1 signature verifier replaces the fail-safe stub

## 10DLC Compliance Notes

- Brand + Campaign submission is **asynchronous** (24–72h approval by US carriers).
- Connection stays `PENDING` and `send()` returns `transient` error with reason "10DLC not approved" until both transition to `approved`.
- If rejected, `connection.health.changed` event fires with the Twilio rejection reason.
- The status poller cron MUST run in prod (Cloud Scheduler → Cloud Run job).

## Ticket Status

| Ticket  | Status     | Notes                                                           |
| ------- | ---------- | --------------------------------------------------------------- |
| KAN-491 | In Review  | `send()` with compliance gate + opt-out check                   |
| KAN-492 | In Review  | Subaccount provisioning, idempotent                             |
| KAN-493 | In Review  | Real 10DLC Trust Hub submission shipped                         |
| KAN-494 | In Review  | Number search + purchase + attach                               |
| KAN-495 | In Review  | Status callback handler with error classification               |
| KAN-496 | In Review  | Inbound webhook with keyword detection                          |
| KAN-497 | To Do      | Settings UI — lives in `@growth-ai/web` (follow-up)             |
| KAN-498 | In Review  | 15+ error code classifier                                       |
| KAN-563 | In Review  | Client factory with Secret Manager + cache                      |
| KAN-564 | In Review  | Messaging Service SID send                                      |
| KAN-567 | In Review  | Messaging Service creation on subaccount                        |
| KAN-569 | In Review  | Brand submission via Trust Hub                                  |
| KAN-570 | In Review  | A2P Campaign linked to Brand + Messaging Service                |
| KAN-571 | In Review  | Status poller cron                                              |
| KAN-572 | In Review  | Number search by area code                                      |
| KAN-573 | In Review  | Number purchase + attach to Messaging Service                   |
| KAN-575 | In Review  | Real HMAC-SHA1 sig verifier                                     |
| KAN-576 | In Review  | Status callback HMAC verification (shared verifier)             |
| KAN-577 | In Review  | Update actions.status via MessageSid + action.executed publish  |
| KAN-578 | In Review  | Inbound SMS webhook routing                                     |
| KAN-579 | In Review  | STOP/HELP/START keyword handling                                |
| KAN-580 | In Review  | Pre-send opt-out check                                          |
| KAN-584 | In Review  | Error code → classification map                                 |

## Local Testing

```bash
# Unit tests
npm run -w @growth-ai/connectors test

# Run the service against real Twilio test creds
ENABLE_TWILIO=true \
GCP_PROJECT_ID=growth-dev \
PUBLIC_WEBHOOK_BASE_URL=https://your-ngrok.ngrok.io \
npm run -w @growth-ai/connectors dev
```

Twilio magic numbers for integration tests (all return canned responses):
- `+15005550001` — invalid → error 21211 (suppress_contact)
- `+15005550006` — valid → success
- `+15005550007` — international restriction → error 21408
- `+15005550008` — queue full → error 21611

## Known Follow-ups

| Concern                                          | Ticket      | Blocker?              |
| ------------------------------------------------ | ----------- | --------------------- |
| Persist `ChannelConnection` via Prisma            | KAN-558     | Yes — connect() can't persist without it |
| Connection Manager tRPC `connect()` real impl     | KAN-558     | Blocked on Prisma     |
| Settings UI for SMS connect                       | KAN-497/581–583 | Ships in web app   |
| Keyword auto-reply actual send                    | KAN-579 FF  | Needs getTwilioClient from AccountSid |
| Tenant resolution from AccountSid in webhook router | KAN-549   | No — falls back to placeholder |
| Integration test against Twilio sandbox            | KAN-565     | No — unit tests pass  |
| Number porting LOA flow                           | Post-MVP    | No                    |
