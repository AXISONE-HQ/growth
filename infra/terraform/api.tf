/**
 * growth-api Service — GCP resources for IaC-managed scheduler jobs.
 *
 * Phase 2 sprint (KAN-814) ships the deferred_send queue + cron HTTP
 * trigger. Cloud Scheduler hits growth-api `/internal/cron/...` with
 * OIDC; the existing pubsub-invoker SA has the right shape (its OIDC
 * tokens validate against verifyPubsubOidc which is generic).
 *
 * Usage (imperative-apply pattern per `feedback_terraform_unmanaged_aspirational_state`):
 *   terraform plan -var project_id=growth-493400 -var region=us-central1 \
 *     -target=google_cloud_scheduler_job.deferred_send_evaluator
 *   terraform apply -var project_id=growth-493400 -var region=us-central1 \
 *     -target=google_cloud_scheduler_job.deferred_send_evaluator
 *
 * If connectors.tf is still unmanaged-aspirational, this file gets
 * applied via -target so it doesn't drag the rest of the IaC into the
 * apply set. KAN-772 reconciles the broader unmanaged-aspirational state.
 *
 * Cross-reference: connectors.tf has 3 sibling Cloud Scheduler jobs
 * (meta-token-health, twilio-10dlc-poll, connection-health-sweep) — same
 * shape, different service.
 */

# ─── Data — references to existing resources ────────────────
# pubsub-invoker SA already exists (created imperatively pre-KAN-732).
# We reuse it because its OIDC tokens are already trusted by
# verifyPubsubOidc on growth-api — the verifier is generic and works for
# Cloud Scheduler tokens too.

data "google_service_account" "pubsub_invoker" {
  account_id = "pubsub-invoker"
  project    = var.project_id
}

# growth-api Cloud Run service URL is needed for the scheduler's HTTP
# target. We don't manage the Cloud Run service itself in this file
# (deploy-api.yml owns that) — just reference it by name.

data "google_cloud_run_v2_service" "growth_api" {
  name     = "growth-api"
  location = var.region
  project  = var.project_id
}

# ─── Cloud Scheduler — KAN-814 deferred-send evaluator ──────
# Fires every 5 minutes. POSTs to /internal/cron/deferred-send-evaluator
# with an OIDC bearer token. growth-api's verifyPubsubOidc accepts the
# token (audience derived from request URL).
#
# When `attempts >= 12` on a deferred row, the evaluator marks it expired
# (24h max retry budget given the 5-min cron + 2h retry interval cadence).

resource "google_cloud_scheduler_job" "deferred_send_evaluator" {
  name             = "growth-api-deferred-send-evaluator"
  description      = "KAN-814 — re-evaluate Send Policy on pending deferred_send rows"
  schedule         = "*/5 * * * *" # every 5 minutes
  time_zone        = "Etc/UTC"
  attempt_deadline = "540s"
  project          = var.project_id
  region           = var.region

  retry_config {
    retry_count = 1 # we want fast retries; the queue itself is idempotent
  }

  http_target {
    http_method = "POST"
    uri         = "${data.google_cloud_run_v2_service.growth_api.uri}/internal/cron/deferred-send-evaluator"
    oidc_token {
      service_account_email = data.google_service_account.pubsub_invoker.email
      # audience defaults to the URL — matches verifyPubsubOidc's expected
      # audience derivation (request.url-based).
    }
  }
}
