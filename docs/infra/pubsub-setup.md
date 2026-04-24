# GCP Pub/Sub — Topic & Subscription Setup

**Ticket:** [KAN-658](https://axisone-team.atlassian.net/browse/KAN-658) (subtask of [KAN-656](https://axisone-team.atlassian.net/browse/KAN-656)).
**Project:** `growth-493400` (project number `1086551891973`).
**Provisioned:** 2026-04-24.

This document is the authoritative, reproducible record of the Pub/Sub infrastructure that carries the decision → execution → outcome pipeline. Run the commands here to recreate the setup from scratch.

## Topology

```
┌────────────────────┐   publishes   ┌──────────────────┐   pulled by   ┌─────────────────────┐
│ Decision Engine    │──────────────▶│ action.decided   │──────────────▶│ message-composer    │
│ (runDecisionFor-   │               └──────────────────┘               │ (to be built —      │
│  Contact)          │                                                  │  KAN-660)           │
└────────────────────┘                                                  └─────────────────────┘
                                                                                 │
                                                                                 │ publishes
                                                                                 ▼
                                                                        ┌──────────────────┐
                                                                        │ action.send      │
                                                                        └──────────────────┘
                                                                                 │
                                                                                 │ pulled by
                                                                                 ▼
                                                                        ┌─────────────────────┐
                                                                        │ sendgrid-adapter    │
                                                                        │ (stub today —       │
                                                                        │  apps/connectors)   │
                                                                        └─────────────────────┘
                                                                                 │
                                                                                 │ publishes
                                                                                 ▼
                                                                        ┌──────────────────┐
                                                                        │ action.executed  │
                                                                        └──────────────────┘
                                                                                 │
                                                                                 │ pulled by
                                                                                 ▼
                                                                        ┌─────────────────────┐
                                                                        │ outcome-writer      │
                                                                        │ (KAN-657)           │
                                                                        └─────────────────────┘

Any subscription that fails 5× → action.deadletter → action.deadletter.audit (forensic).
```

## Resources created

### Topics

| Topic                | Purpose                                                                |
| -------------------- | ---------------------------------------------------------------------- |
| `action.decided`     | Decision Engine emits here when a decision outcome is `EXECUTED`.      |
| `action.send`        | Message Composer emits here with a fully-formed outbound message.      |
| `action.executed`    | Channel adapters emit here after attempted send (success or failure).  |
| `action.deadletter`  | DLQ for all three above — receives messages after 5 failed deliveries. |

### Subscriptions

| Subscription                         | Topic               | Consumer                     | DLQ                 | Max retries | Ack   | Backoff       |
| ------------------------------------ | ------------------- | ---------------------------- | ------------------- | ----------: | ----: | ------------- |
| `action.decided.message-composer`    | `action.decided`    | Message Composer (KAN-660)   | `action.deadletter` |           5 |  30s  | 10s → 600s    |
| `action.send.sendgrid-adapter`       | `action.send`       | SendGrid adapter             | `action.deadletter` |           5 |  30s  | 10s → 600s    |
| `action.executed.outcome-writer`     | `action.executed`   | Outcome writer (KAN-657)     | `action.deadletter` |           5 |  30s  | 10s → 600s    |
| `action.deadletter.audit`            | `action.deadletter` | Forensic audit (human-read)  | —                   |         n/a |  60s  | defaults      |

### IAM bindings

The Pub/Sub service agent (`service-1086551891973@gcp-sa-pubsub.iam.gserviceaccount.com`) was granted:

- `roles/pubsub.publisher` on `action.deadletter` (so the service can forward dead-lettered messages)
- `roles/pubsub.subscriber` on each of the three source subscriptions (so the service can ack messages it's forwarding to DLQ)

Without these, subscriptions still get created, but dead-lettering silently fails at runtime.

## Gotcha: `max-retry-delay` is capped at 600s

KAN-658 specifies exponential backoff `10s, 30s, 2m, 10m, 30m`. **Pub/Sub's API hard-caps `maxBackoffDuration` at 600 seconds (10 minutes)** — not a gcloud CLI limitation. The steps above configure `min=10s, max=600s`, which brackets the first four values in the spec but cannot reach the 30m fifth step. Pub/Sub interpolates an exponential curve between the bounds; exact per-attempt delays can't be pinned via the API.

If 30-minute waits are required (e.g., for aggressive rate-limit recovery), add application-level retry logic on top of Pub/Sub's retries. Not in scope for KAN-658.

## Reproduction — exact commands

```sh
PROJECT=growth-493400
PROJECT_NUMBER=1086551891973                   # or: gcloud projects describe "$PROJECT" --format='value(projectNumber)'
PUBSUB_SA="service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com"

# Ensure gcloud targets the right project.
gcloud config set project "$PROJECT"

# ─── Topics ────────────────────────────────────────────────────────────
gcloud pubsub topics create action.decided    --project="$PROJECT"
gcloud pubsub topics create action.send       --project="$PROJECT"
gcloud pubsub topics create action.executed   --project="$PROJECT"
gcloud pubsub topics create action.deadletter --project="$PROJECT"

# ─── IAM: Pub/Sub SA publisher on DLQ topic ───────────────────────────
gcloud pubsub topics add-iam-policy-binding action.deadletter \
    --project="$PROJECT" \
    --member="serviceAccount:$PUBSUB_SA" \
    --role=roles/pubsub.publisher

# ─── Source subscriptions (pull, DLQ-protected, bounded backoff) ──────
for spec in \
  "action.decided.message-composer:action.decided" \
  "action.send.sendgrid-adapter:action.send" \
  "action.executed.outcome-writer:action.executed"; do
  sub="${spec%%:*}"
  topic="${spec##*:}"
  gcloud pubsub subscriptions create "$sub" \
      --project="$PROJECT" \
      --topic="$topic" \
      --ack-deadline=30 \
      --min-retry-delay=10s \
      --max-retry-delay=600s \
      --dead-letter-topic=action.deadletter \
      --max-delivery-attempts=5
done

# ─── IAM: Pub/Sub SA subscriber on source subs (for DLQ forwarding) ───
for sub in action.decided.message-composer action.send.sendgrid-adapter action.executed.outcome-writer; do
  gcloud pubsub subscriptions add-iam-policy-binding "$sub" \
      --project="$PROJECT" \
      --member="serviceAccount:$PUBSUB_SA" \
      --role=roles/pubsub.subscriber
done

# ─── DLQ forensic subscription (so dead messages don't age out silently) ─
gcloud pubsub subscriptions create action.deadletter.audit \
    --project="$PROJECT" \
    --topic=action.deadletter \
    --ack-deadline=60
```

## Verification

```sh
# Topics.
gcloud pubsub topics list --project="$PROJECT" \
  --filter='name ~ "/topics/action\."' --format="value(name)"

# Subscriptions + DLQ + backoff.
gcloud pubsub subscriptions list --project="$PROJECT" \
  --filter='name ~ "/subscriptions/action\."' \
  --format="table(name.basename(),topic.basename(),deadLetterPolicy.deadLetterTopic.basename(),deadLetterPolicy.maxDeliveryAttempts,ackDeadlineSeconds,retryPolicy.minimumBackoff,retryPolicy.maximumBackoff)"

# End-to-end publish test.
gcloud pubsub topics publish action.decided --project="$PROJECT" --message='smoke test'
```

Expected verification output (what was recorded on 2026-04-24):

```
NAME                             TOPIC              DEAD_LETTER_TOPIC  MAX_DELIVERY_ATTEMPTS  ACK_DEADLINE_SECONDS  MINIMUM_BACKOFF  MAXIMUM_BACKOFF
action.executed.outcome-writer   action.executed    action.deadletter  5                      30                    10s              600s
action.send.sendgrid-adapter     action.send        action.deadletter  5                      30                    10s              600s
action.deadletter.audit          action.deadletter                                            60
action.decided.message-composer  action.decided     action.deadletter  5                      30                    10s              600s
```

## Teardown (if needed)

```sh
for sub in action.decided.message-composer action.send.sendgrid-adapter action.executed.outcome-writer action.deadletter.audit; do
  gcloud pubsub subscriptions delete "$sub" --project="$PROJECT" --quiet
done
for topic in action.decided action.send action.executed action.deadletter; do
  gcloud pubsub topics delete "$topic" --project="$PROJECT" --quiet
done
```

## Metrics

Subscription metrics auto-populate in Cloud Monitoring within ~5 minutes of first message activity. Relevant dashboards:

- `pubsub.googleapis.com/subscription/num_undelivered_messages` — watch for drift on source subs (would indicate consumer isn't pulling) or on `action.deadletter` (would indicate real failures happening upstream).
- `pubsub.googleapis.com/subscription/oldest_unacked_message_age` — watch for growing values (consumer is stuck / crash-looping).
- `pubsub.googleapis.com/subscription/dead_letter_message_count` — every increment here represents a message that failed 5× delivery; investigate via `action.deadletter.audit`.

## What's NOT done in KAN-658 (follow-up scope)

Infrastructure only. The following are separate tickets:

- **KAN-659:** wire `run-decision-for-contact.ts` to publish on real `@google-cloud/pubsub` client (replacing `InMemoryPubSubClient` in the wedge adapter).
- **KAN-660:** Message Composer service — pulls from `action.decided.message-composer`, composes the outbound message using the playbook step's `instruction`, publishes the fully-formed message on `action.send`. This is the bridge the wedge currently lacks.
- **KAN-657:** Outcome writer — pulls from `action.executed.outcome-writer`, upserts into the `outcomes` table.
- **SendGrid adapter stub → real:** `apps/connectors/src/pubsub/subscriber.ts:51` currently logs `action.send received (stub)`. Needs to actually invoke `sgMail.send` with the composed message.

Until those ship, published messages to `action.decided` have no consumer — they'll accumulate in the `action.decided.message-composer` subscription backlog and eventually age out per the 7-day default retention.
