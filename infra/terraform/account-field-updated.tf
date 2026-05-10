/**
 * KAN-866 — Account Page Cohort 6: account.field_updated topic + push subscription.
 *
 * Sibling Terraform PR for the audit-subscriber wire. Cohort 1 shipped
 * the publisher (`packages/api/src/services/account-field-updated-publisher.ts`)
 * gated behind `ACCOUNT_EVENTS_ENABLED=false`. Cohort 6 lands the topic,
 * push subscription, and IAM bindings so flipping the flag has somewhere
 * to deliver.
 *
 * **Decisions inherited from Cohort 5 (KAN-862) Terraform**:
 *   - Reuse `pubsub-invoker` SA for OIDC dispatch (canonical SA per
 *     `class_structural_elimination/audience_mismatch.md`)
 *   - Explicit `roles/pubsub.publisher` binding on the new topic for
 *     forward-compat with KAN-690 (don't rely on the project-level
 *     roles/editor over-grant)
 *   - Apply via Path A (`-target`) per `feedback_terraform_unmanaged_aspirational_state`
 *
 * Apply pattern (mirrors KAN-862 / account-detect.tf):
 *
 *   terraform plan -var project_id=growth-493400 -var region=us-central1 \
 *     -target=google_pubsub_topic.account_field_updated \
 *     -target=google_pubsub_topic_iam_member.account_field_updated_publisher \
 *     -target=google_pubsub_subscription.account_field_updated_to_audit \
 *     -target=google_pubsub_topic_iam_member.account_field_updated_subscriber
 *
 *   terraform apply -var project_id=growth-493400 -var region=us-central1 \
 *     <same -target list>
 *
 * Cohort 7 (none planned): no further wiring needed once this lands.
 * The subscriber endpoint /internal/account-field-updated-subscriber on
 * growth-api consumes this topic to write AuditLog rows.
 */

# ─── Data — references ─────────────────────────────────────
# pubsub-invoker SA (created imperatively pre-KAN-732). Reused so its
# OIDC tokens validate via the generic verifyPubsubOidc helper.

data "google_service_account" "afu_pubsub_invoker" {
  account_id = "pubsub-invoker"
  project    = var.project_id
}

# Default Compute SA (API runtime today). Data-source pattern follows
# live identity through any future KAN-690 dedicated-SA migration.

data "google_compute_default_service_account" "afu_runtime" {
  project = var.project_id
}

# growth-api Cloud Run service URL — needed for the subscriber's push
# endpoint target.

data "google_cloud_run_v2_service" "afu_growth_api" {
  name     = "growth-api"
  location = var.region
  project  = var.project_id
}

# ─── Topic ─────────────────────────────────────────────────
# 7-day retention per existing convention. Single topic; subscriber
# fans out to the AuditLog write at consumer time.

resource "google_pubsub_topic" "account_field_updated" {
  name    = "account.field_updated"
  project = var.project_id
  labels  = { service = "account-events", kind = "audit" }

  message_retention_duration = "604800s" # 7 days
}

# ─── Topic IAM ─────────────────────────────────────────────
# growth-api runtime publishes via accountEventsEnabled() gate +
# `_applyAccountUpdate` per-changed-field. Explicit publisher binding
# bound to live SA identity (data-source pattern, KAN-862 precedent).

resource "google_pubsub_topic_iam_member" "account_field_updated_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.account_field_updated.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.afu_runtime.email}"
}

# ─── Push subscription → growth-api audit subscriber ───────
# OIDC dispatch as pubsub-invoker; verifyPubsubOidc on the handler
# accepts the token via request-URL audience derivation (KAN-732).
# 5x retry policy with exponential backoff matches the existing
# action.send subscription pattern (connectors.tf:144-152).

resource "google_pubsub_subscription" "account_field_updated_to_audit" {
  name  = "account-field-updated-audit-writer"
  topic = google_pubsub_topic.account_field_updated.name

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s" # 24h

  push_config {
    push_endpoint = "${data.google_cloud_run_v2_service.afu_growth_api.uri}/internal/account-field-updated-subscriber"
    oidc_token {
      service_account_email = data.google_service_account.afu_pubsub_invoker.email
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

resource "google_pubsub_topic_iam_member" "account_field_updated_subscriber" {
  project = var.project_id
  topic   = google_pubsub_topic.account_field_updated.name
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${data.google_service_account.afu_pubsub_invoker.email}"
}

# ─── Output ────────────────────────────────────────────────

output "account_field_updated_topic" {
  value       = google_pubsub_topic.account_field_updated.name
  description = "Pub/Sub topic for account.* field-update audit events. KAN-866."
}

output "account_field_updated_subscription" {
  value       = google_pubsub_subscription.account_field_updated_to_audit.name
  description = "Push subscription delivering account.field_updated to growth-api audit writer. KAN-866."
}
