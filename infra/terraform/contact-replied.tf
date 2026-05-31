/**
 * KAN-1037-PR3 — M3-2.5c reply-loop-closure: contact.replied topic +
 * push subscription. PR3 of 5 in the M3-2.5c sequence:
 *   - PR1 (#244, merged 2026-05-31): escalation.originalAction lets
 *     accept-without-modify dispatch via the engine's structured action.
 *   - PR2 (#245, merged 2026-05-31): autoresponder filter at the Resend
 *     inbound webhook — keeps machine-generated replies out of the
 *     downstream `lead.received` chain.
 *   - PR3 (THIS): event-plumbing layer. Publishes `contact.replied` from
 *     `lead-received-push.ts` on every `inbound_correlated` outcome
 *     (both first-turn at L1102 and multi-turn at L942 paths). Push
 *     subscription delivers to growth-api's `/pubsub/contact-replied`
 *     endpoint where a SKELETON handler writes audit + sets cooldown
 *     gate but does NOT yet invoke `runDecisionForContact`. PR4 wires
 *     the actual engine re-evaluation here — separation lets PR3 verify
 *     the event-driven trigger fires correctly BEFORE introducing the
 *     engine prompt modality shift (PRD §7 quality risk).
 *   - PR4 (queued post-verify): latestInbound in RunForContactInput +
 *     prompt extension + gated empirical smoke.
 *   - PR5 (queued post-PR4): Last reply panel UI on /customers/[id].
 *
 * **Decisions inherited from KAN-866 (account-field-updated.tf):**
 *   - Reuse `pubsub-invoker` SA for OIDC dispatch (canonical SA per
 *     `class_structural_elimination/audience_mismatch.md` — KAN-732
 *     audience-mismatch class structurally impossible).
 *   - Explicit `roles/pubsub.publisher` binding on the new topic for
 *     forward-compat with KAN-690 (don't rely on the project-level
 *     `roles/editor` over-grant on the compute default SA).
 *   - Apply via Path A (`-target`) per
 *     `feedback_terraform_unmanaged_aspirational_state` — the broader
 *     `connectors.tf` gap (lead.received, contact-ingested, etc.
 *     provisioned imperatively pre-Terraform-as-truth aspiration)
 *     remains; PR3 ships net-new resources WITH IaC coverage from
 *     day one rather than expanding the gap. Backfill of existing
 *     gcloud-provisioned topics is a separate hygiene effort.
 *
 * **Apply pattern** (mirrors KAN-866):
 *
 *   terraform plan -var project_id=growth-493400 -var region=us-central1 \
 *     -target=google_pubsub_topic.contact_replied \
 *     -target=google_pubsub_topic_iam_member.contact_replied_publisher \
 *     -target=google_pubsub_subscription.contact_replied_to_decision_run \
 *     -target=google_pubsub_topic_iam_member.contact_replied_subscriber
 *
 *   terraform apply -var project_id=growth-493400 -var region=us-central1 \
 *     <same -target list>
 *
 * **Sequencing:** apply Terraform BEFORE merging PR3's code. The
 * subscription will queue messages but the `/pubsub/contact-replied`
 * endpoint doesn't exist yet (pre-code-deploy). Pub/Sub holds messages
 * up to `message_retention_duration` (24h on this subscription),
 * retries on push-endpoint 404 with exponential backoff per the
 * standard policy. Once the code deploys, any messages queued during
 * the gap get drained on the first retry tick.
 */

# ─── Data — references ─────────────────────────────────────
# pubsub-invoker SA (created imperatively pre-KAN-732). Reused so its
# OIDC tokens validate via the generic verifyPubsubOidc helper at
# `apps/api/src/lib/oidc-pubsub-verify.ts` — same SA + same helper
# across action-decided, action-executed, knowledge-ingest, llm-call,
# lead-received (KAN-774), account-field-updated (KAN-866), and now
# contact-replied. Audience-mismatch class stays structurally impossible.

data "google_service_account" "cr_pubsub_invoker" {
  account_id = "pubsub-invoker"
  project    = var.project_id
}

# Default Compute SA — the growth-api runtime identity that calls
# `pubsubClient.publish('contact.replied', ...)` from the
# `lead-received-push.ts` subscriber. Data-source pattern follows live
# identity through any future KAN-690 dedicated-SA migration.

data "google_compute_default_service_account" "cr_runtime" {
  project = var.project_id
}

# growth-api Cloud Run service URL — needed for the subscriber's push
# endpoint target.

data "google_cloud_run_v2_service" "cr_growth_api" {
  name     = "growth-api"
  location = var.region
  project  = var.project_id
}

# ─── Topic ─────────────────────────────────────────────────
# 7-day retention per existing convention. Single topic; subscriber
# fans out to the Redis-gated decision-run trigger at consumer time.

resource "google_pubsub_topic" "contact_replied" {
  name    = "contact.replied"
  project = var.project_id
  labels  = { service = "m3-2-5c", kind = "engine-trigger" }

  message_retention_duration = "604800s" # 7 days
}

# ─── Topic IAM ─────────────────────────────────────────────
# growth-api runtime publishes from `lead-received-push.ts` when
# `writeSidecarAndCorrelate` returns `inbound_correlated`. Explicit
# publisher binding bound to live SA identity (data-source pattern,
# KAN-866 precedent).

resource "google_pubsub_topic_iam_member" "contact_replied_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.contact_replied.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.cr_runtime.email}"
}

# ─── Push subscription → growth-api /pubsub/contact-replied ────
# OIDC dispatch as pubsub-invoker; verifyPubsubOidc on the handler
# accepts the token via request-URL audience derivation (KAN-732).
# Retry policy matches existing subscribers (10s/600s exponential).
#
# 24h message retention: an inbound reply that can't be processed
# within 24h is almost certainly a tenant-side issue (Redis outage,
# subscriber crashloop, etc.) — operator intervention required by
# then anyway. Matches the KAN-866 audit subscriber retention.

resource "google_pubsub_subscription" "contact_replied_to_decision_run" {
  name  = "contact-replied-decision-run-trigger"
  topic = google_pubsub_topic.contact_replied.name

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s" # 24h

  push_config {
    push_endpoint = "${data.google_cloud_run_v2_service.cr_growth_api.uri}/pubsub/contact-replied"
    oidc_token {
      service_account_email = data.google_service_account.cr_pubsub_invoker.email
      # audience defaults to the URL — matches verifyPubsubOidc derivation
    }
    attributes = { "x-goog-version" = "v1" }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# Subscriber IAM: `roles/pubsub.subscriber` on the topic for the
# pubsub-invoker SA so it's authorized to receive pushes from this
# subscription. (Push subscriptions don't strictly require the role —
# they push regardless of subscriber IAM — but explicit binding is
# defense-in-depth + makes the trust chain auditable.)

resource "google_pubsub_topic_iam_member" "contact_replied_subscriber" {
  project = var.project_id
  topic   = google_pubsub_topic.contact_replied.name
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${data.google_service_account.cr_pubsub_invoker.email}"
}

# ─── Output ────────────────────────────────────────────────

output "contact_replied_topic" {
  value       = google_pubsub_topic.contact_replied.name
  description = "Pub/Sub topic for M3-2.5c contact.replied engine re-evaluation trigger. KAN-1037-PR3."
}

output "contact_replied_subscription" {
  value       = google_pubsub_subscription.contact_replied_to_decision_run.name
  description = "Push subscription delivering contact.replied to growth-api /pubsub/contact-replied. KAN-1037-PR3."
}
