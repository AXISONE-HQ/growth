# Meta Messenger Adapter (KAN-474)

Facebook Messenger via Meta Graph API using the **OAuth + Page Access Token**
pattern. Unlike Twilio/SendGrid, Meta has no sub-account model — AxisOne
registers one Meta App (reviewed by Meta), tenants OAuth-authorize that App
against their Facebook Pages, and we hold per-Page long-lived access tokens.

## Files

| File                 | Purpose                                                       |
| -------------------- | ------------------------------------------------------------- |
| `index.ts`           | `MetaAdapter` implementing `ChannelAdapter`                   |
| `client.ts`          | Graph API fetch wrapper + Page token loader + cache           |
| `provisioning.ts`    | OAuth token exchange, Page subscription, token persistence    |
| `events.ts`          | Webhook entry/messaging parser, echo + receipt filtering      |
| `signature.ts`       | Real HMAC-SHA256 verifier + webhook verify token loader       |
| `token-health.ts`    | Daily token introspection — revocation detection              |
| `errors.ts`          | Graph code/subcode → transient/permanent + side-effect        |
| `__tests__/`         | Vitest: errors, events parser                                 |

## End-to-End Flow

### Connect

```
Tenant clicks "Connect Facebook" in Settings (KAN-632)
      ↓
Nango OAuth session (KAN-617) — popup authenticates user + requests scopes
      ↓
Nango returns short-lived user access token to our callback
      ↓
exchangeForLongLivedUserToken()    — 60-day user token via /oauth/access_token
      ↓
fetchUserPages()                   — GET /me/accounts, filter tasks='MESSAGING'
      ↓
Tenant picks Pages (KAN-633) — multi-select
      ↓
For each selected Page:
  subscribePage()                  — POST /:page_id/subscribed_apps
  storePageToken()                 — Secret Manager: {tenant_id}-meta-{page_id}
  buildMetaConnectionRecord()      — ChannelConnection row per Page
      ↓
All connections returned to UI — status: ACTIVE
```

### Send

```
Pub/Sub action.send
      ↓
subscriber.ts → adapter.send(connection, msg)
      ↓
loadPageToken()
      ↓
Determine messaging_type:
  categories contains "tag:XXX"   → MESSAGE_TAG (outside 24h window)
  otherwise                        → RESPONSE (default, within 24h)
      ↓
POST /me/messages with { recipient, messaging_type, message, [tag] }
      ↓
Return providerMessageId (mid) — subscriber publishes action.executed
```

### Inbound

```
Meta POST /webhooks/meta  (signed HMAC-SHA256)
      ↓
signature verify against App Secret (replay-safe via HMAC)
      ↓
parseMetaWebhook(payload):
  object must be "page"
  per entry: iterate messaging[]
    skip echo (is_echo=true — our own Page outbound)
    skip delivery + read (handled separately in future)
    text message  → InboundEvent
    postback      → InboundEvent with [POSTBACK:payload] prefix
    attachment    → InboundEvent with [type:url] descriptor
      ↓
Webhook router resolves tenantId via page_id → connection lookup
      ↓
Publish inbound.raw to Pub/Sub
```

### Token Health

```
Cloud Scheduler daily → runTokenHealthSweep()
      ↓
For each Meta connection:
  graphFetch('/me') with Page token
    → success → healthy
    → code 190 / HTTP 401 → mark ERROR
      publish connection.health.changed
      invalidate cache
      (tenant gets email to re-connect)
```

## Why We Don't Refresh Tokens

Page access tokens derived from a **long-lived user access token** do not
expire. But they can still be invalidated:
- User revokes the App in Facebook settings
- User removes themselves as Page admin
- User changes Facebook password

So the right strategy isn't "refresh before expiry" — it's "detect revocation
fast and prompt re-connect." Our daily health check does this.

## Required Secrets

| Secret                                       | Payload                                     | Created when    |
| -------------------------------------------- | ------------------------------------------- | --------------- |
| `axisone/meta-app/app-id`                    | Meta App ID (string)                        | One-time ops    |
| `axisone/meta-app/app-secret`                | Meta App Secret (string)                    | One-time ops    |
| `axisone/meta-app/webhook-verify-token`      | Random string for GET challenge              | One-time ops    |
| `{tenant_id}-meta-{page_id}`                 | `{pageAccessToken, pageId, pageName, issuedAt}` | Per Page on connect |

## Enabling the Adapter

1. Complete Meta App Review (KAN-508) — see `docs/meta-app-review/`
2. Place App ID / App Secret / webhook verify token in Secret Manager
3. Configure the Meta App's Webhook in Meta Dashboard:
   - Callback URL: `https://connectors.growth.axisone.com/webhooks/meta`
   - Verify Token: same as stored secret
   - Subscribe to fields: `messages`, `messaging_postbacks`, `messaging_optins`, `messaging_deliveries`, `messaging_reads`, `messaging_handovers`
4. Set `ENABLE_META=true` on Cloud Run
5. Redeploy

## 24-Hour Messaging Window (Policy)

Meta permits messages **WITHOUT** a tag only within 24 hours of the user's
last message to the Page. Outside that window, you MUST pass an approved
`MESSAGE_TAG`:

| Tag                       | Use case                                               |
| ------------------------- | ------------------------------------------------------ |
| `HUMAN_AGENT`             | Human agent responds within 7 days (App Review needed) |
| `CONFIRMED_EVENT_UPDATE`  | Updates about an event the user confirmed              |
| `POST_PURCHASE_UPDATE`    | Updates about a purchase                               |
| `ACCOUNT_UPDATE`          | Account status updates                                 |

Pass via `OutboundMessage.categories: ["tag:HUMAN_AGENT"]`. The adapter
extracts and sets `messaging_type=MESSAGE_TAG` + `tag=HUMAN_AGENT` on the send.

## Ticket Status

| Ticket  | Status     | Notes                                                      |
| ------- | ---------- | ---------------------------------------------------------- |
| KAN-507 | To Do      | Meta App registration — ops task (see docs/meta-app-review)|
| KAN-508 | To Do      | Meta App Review submission — **critical path, 4–8 weeks**  |
| KAN-509 | In Review  | OAuth via Nango — token exchange + Page fetch              |
| KAN-510 | In Review  | Meta adapter `send()` with 24h window + tag support        |
| KAN-511 | In Review  | `subscribePage()` called on connect                        |
| KAN-512 | In Review  | Inbound webhook with HMAC-SHA256 + GET challenge           |
| KAN-513 | In Review  | Token health sweep (refresh-not-needed strategy)           |
| KAN-514 | To Do      | Settings UI — lives in `@growth-ai/web`                    |
| KAN-617 | In Review  | Nango integration (config is ops-side)                     |
| KAN-618 | In Review  | Long-lived user token exchange                             |
| KAN-619 | In Review  | Multi-page selection + per-Page connection                 |
| KAN-620 | In Review  | Graph API wrapper with token injection                     |
| KAN-621 | In Review  | Send with messaging_type + tag handling                    |
| KAN-622 | In Review  | Graph error classifier                                     |
| KAN-623 | In Review  | /:page_id/subscribed_apps call                             |
| KAN-624 | To Do      | Webhook URL + verify token config (ops, one-time)          |
| KAN-625 | In Review  | Disconnect unsubscribes Page                               |
| KAN-626 | In Review  | Real HMAC-SHA256 verifier                                  |
| KAN-627 | In Review  | Entry/messaging batch parser                               |
| KAN-628 | In Review  | Publish normalized events to inbound.raw                   |
| KAN-629 | In Review  | Daily token health cron                                    |
| KAN-630 | In Review  | Token rotation (not applicable — long-lived tokens)        |
| KAN-631 | In Review  | Failure escalation on revocation                           |

## Local Testing

```bash
npm run -w @growth-ai/connectors test

ENABLE_META=true \
GCP_PROJECT_ID=growth-dev \
PUBLIC_WEBHOOK_BASE_URL=https://your-ngrok.ngrok.io \
npm run -w @growth-ai/connectors dev
```

Meta provides a [Test User](https://developers.facebook.com/docs/development/build-and-test/test-users/)
tool for sandbox OAuth + a test Page without full App Review approval.

## Known Follow-ups

| Concern                                                    | Ticket        | Blocker?                                    |
| ---------------------------------------------------------- | ------------- | ------------------------------------------- |
| Meta App Review                                            | KAN-508       | **Critical** — blocks prod launch 4–8 weeks |
| Prisma persistence of connections + page tokens            | KAN-558       | Yes                                         |
| Settings UI (Connect button + Page picker + card states)   | KAN-514/632/633/634 | Ships in web app                      |
| Delivery + read receipt handling (update action status)    | Future        | No                                          |
| Instagram DM (reuses same infra + OAuth)                   | Post-MVP      | No                                          |
