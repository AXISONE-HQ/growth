/**
 * KAN-1007 — SAE PR3 Pub/Sub bringup
 *
 * Two new topics for the Safe Autonomous Execution wakeup infrastructure:
 *   - campaign.materialize  → durable replacement for KAN-1002 in-process
 *                             fire-and-forget worker (folds KAN-1003)
 *   - decision.run          → wakeup signal for autonomous Decision Engine.
 *                             SHIPS DORMANT in PR3 — no app code publishes
 *                             to this topic until SAE PR5 (`audience.activate`).
 *                             The push subscriber's hard guards refuse to
 *                             evaluate any contact whose Campaign isn't
 *                             status='active' (which no row has until PR5).
 *
 * Both topics get matching `.dlq` companions + push subscriptions to the
 * growth-api Cloud Run service. OIDC audience is derived from the request URL
 * at the API layer via `verifyPubsubOidc` — no env var per audience (per
 * KAN-732 / `feedback_kan_732_audience_class_eliminated`).
 *
 * IAM topology:
 *   - Publisher: runtime Compute SA (mirrors account-detect.tf pattern;
 *     forward-compatible with KAN-690 dedicated `growth-api` SA migration
 *     via data-source resolution)
 *   - Push subscriber: canonical pubsub-invoker SA (reused across all push
 *     subscriptions per `feedback_kan_745_cost_observability_shipped`)
 *
 * Retry/backoff mirrors the proven connectors.tf `action.send` pattern
 * (10s min / 600s max backoff, 5 max delivery attempts before DLQ).
 *
 * Resource ack-deadline = 60s for materialize (DB pagination), 60s for
 * decision.run (one LLM-runtime decision call). Long enough that handler
 * doesn't get re-pushed mid-execution; short enough that a truly stuck
 * handler doesn't burn dispatch quota.
 */

# ─── Shared data sources (mirror account-detect.tf data lookup pattern) ────

data "google_service_account" "sae_pubsub_invoker" {
  account_id = "pubsub-invoker"
  project    = var.project_id
}

data "google_compute_default_service_account" "sae_runtime" {
  project = var.project_id
}

# growth-api Cloud Run service URL — referenced by both push subscriptions
# below. Declared as data to read the live URL rather than hard-coding;
# stable across deploys (Cloud Run service name doesn't change with each
# revision, only the revision hash; push_endpoint uses the service URL).
data "google_cloud_run_v2_service" "sae_growth_api" {
  name     = "growth-api"
  location = var.region
  project  = var.project_id
}

# ─── Topics + DLQs ────────────────────────────────────────────────────────

resource "google_pubsub_topic" "sae_campaign_materialize" {
  name    = "campaign.materialize"
  project = var.project_id
  labels  = { service = "growth-api", kind = "sae", purpose = "materialize" }

  message_retention_duration = "604800s" # 7 days (matches existing convention)
}

resource "google_pubsub_topic" "sae_campaign_materialize_dlq" {
  name    = "campaign.materialize.dlq"
  project = var.project_id
  labels  = { service = "growth-api", kind = "dlq", purpose = "materialize" }

  message_retention_duration = "604800s"
}

resource "google_pubsub_topic" "sae_decision_run" {
  name    = "decision.run"
  project = var.project_id
  labels  = { service = "growth-api", kind = "sae", purpose = "decision-wakeup" }

  message_retention_duration = "604800s"
}

resource "google_pubsub_topic" "sae_decision_run_dlq" {
  name    = "decision.run.dlq"
  project = var.project_id
  labels  = { service = "growth-api", kind = "dlq", purpose = "decision-wakeup" }

  message_retention_duration = "604800s"
}

# ─── Topic IAM — runtime SA gets publisher on main topics ────────────────
# Explicit bindings (forward-compatible with KAN-690 dedicated growth-api SA).
# DLQ publisher is implicitly the Pub/Sub service agent when dead_letter_policy
# fires; no extra grant needed for that path.

resource "google_pubsub_topic_iam_member" "sae_campaign_materialize_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.sae_campaign_materialize.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.sae_runtime.email}"
}

resource "google_pubsub_topic_iam_member" "sae_decision_run_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.sae_decision_run.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.sae_runtime.email}"
}

# ─── Push subscriptions → growth-api ──────────────────────────────────────

resource "google_pubsub_subscription" "sae_campaign_materialize_push" {
  name    = "growth-api-campaign-materialize"
  project = var.project_id
  topic   = google_pubsub_topic.sae_campaign_materialize.name

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s" # 24h (matches connectors.tf action.send)

  push_config {
    push_endpoint = "${data.google_cloud_run_v2_service.sae_growth_api.uri}/pubsub/campaign-materialize"
    oidc_token {
      service_account_email = data.google_service_account.sae_pubsub_invoker.email
    }
    attributes = { "x-goog-version" = "v1" }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.sae_campaign_materialize_dlq.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

resource "google_pubsub_subscription" "sae_decision_run_push" {
  name    = "growth-api-decision-run"
  project = var.project_id
  topic   = google_pubsub_topic.sae_decision_run.name

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s"

  push_config {
    push_endpoint = "${data.google_cloud_run_v2_service.sae_growth_api.uri}/pubsub/decision-run"
    oidc_token {
      service_account_email = data.google_service_account.sae_pubsub_invoker.email
    }
    attributes = { "x-goog-version" = "v1" }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.sae_decision_run_dlq.id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# ─── Subscription IAM — pubsub-invoker SA gets subscriber role on each ────
# Required for Pub/Sub to mint OIDC tokens against this SA when pushing.

resource "google_pubsub_topic_iam_member" "sae_campaign_materialize_invoker" {
  project = var.project_id
  topic   = google_pubsub_topic.sae_campaign_materialize.name
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${data.google_service_account.sae_pubsub_invoker.email}"
}

resource "google_pubsub_topic_iam_member" "sae_decision_run_invoker" {
  project = var.project_id
  topic   = google_pubsub_topic.sae_decision_run.name
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${data.google_service_account.sae_pubsub_invoker.email}"
}

# ─── Cloud Run invoker permission for pubsub-invoker SA ───────────────────
# The pubsub-invoker SA mints OIDC tokens that the growth-api service
# must accept. Granting roles/run.invoker on the service is what lets the
# token-bearing push request reach the handler. Already granted globally
# via the canonical pubsub-invoker pattern — declared here defensively
# in case a fresh SA reset wipes it (per terraform-emergency-edit memory).

resource "google_cloud_run_v2_service_iam_member" "sae_growth_api_invoker" {
  project  = var.project_id
  location = var.region
  name     = data.google_cloud_run_v2_service.sae_growth_api.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${data.google_service_account.sae_pubsub_invoker.email}"
}
