/**
 * KAN-862 — Account Page Cohort 5: detect-from-website infra.
 *
 * Sibling Terraform PR for the code-side detect-from-website pipeline.
 * Lands first (Path A imperative-apply per
 * `feedback_terraform_unmanaged_aspirational_state` + `feedback_dry_run_infra`)
 * so the code PR's tests + smoke don't reference unprovisioned topics or
 * a missing Cloud Tasks queue.
 *
 * Apply pattern (mirrors KAN-854 / storage.tf):
 *
 *   terraform plan -var project_id=growth-493400 -var region=us-central1 \
 *     -target=google_pubsub_topic.account_detect_started \
 *     -target=google_pubsub_topic.account_detect_progress \
 *     -target=google_pubsub_topic.account_detect_completed \
 *     -target=google_pubsub_topic.account_detect_failed \
 *     -target=google_pubsub_topic.account_detect_dead_letter \
 *     -target=google_cloud_tasks_queue.account_detect \
 *     -target=google_pubsub_topic_iam_member.account_detect_started_publisher \
 *     -target=google_pubsub_topic_iam_member.account_detect_progress_publisher \
 *     -target=google_pubsub_topic_iam_member.account_detect_completed_publisher \
 *     -target=google_pubsub_topic_iam_member.account_detect_failed_publisher \
 *     -target=google_pubsub_topic_iam_member.account_detect_dead_letter_publisher \
 *     -target=google_project_iam_member.account_detect_runtime_cloudtasks_enqueuer \
 *     -target=google_service_account_iam_member.account_detect_runtime_actas_pubsub_invoker \
 *     -target=google_service_account_iam_member.cloudtasks_agent_token_creator_on_pubsub_invoker
 *
 *   terraform apply -var project_id=growth-493400 -var region=us-central1 \
 *     <same -target list>
 *
 * **Decisions locked (Fred greenlit pre-flight):**
 *
 *   - Worker shape: endpoint on growth-api (Option B) — no new Cloud Run service
 *   - SA reuse: `pubsub-invoker` SA for Cloud Tasks OIDC dispatch (canonical
 *     SA per `class_structural_elimination/audience_mismatch.md`); no new
 *     `account-detect-invoker` SA created
 *   - Pub/Sub publish IAM: explicit `roles/pubsub.publisher` bindings on each
 *     of the 5 new topics, bound to the API's runtime SA (default Compute SA
 *     today; data-source pattern per storage.tf so it follows live identity
 *     when KAN-690 migrates to a dedicated `growth-api` SA)
 *
 * **Cohort 6 follow-up (out of scope here):**
 *
 *   - Push subscriptions on the 4 progress/completed/failed/dead-letter
 *     topics → audit-log subscriber (KAN-690 / Cohort 6)
 *   - DriftBanner UI subscribes to `account.detect_completed` for the
 *     "N proposals" badge (Cohort 6)
 */

# ─── Data — references to existing resources ────────────────
# pubsub-invoker SA already exists (created imperatively pre-KAN-732).
# Reused for Cloud Tasks OIDC issuance — its tokens validate via the
# generic `verifyPubsubOidc` middleware that the new
# /internal/account-detect-handler endpoint reuses.

data "google_service_account" "account_detect_pubsub_invoker" {
  account_id = "pubsub-invoker"
  project    = var.project_id
}

# Default Compute SA — the API's runtime SA today. Data-source pattern
# (mirrors storage.tf's data.google_compute_default_service_account.default
# for forward-compat with KAN-690's dedicated `growth-api` SA migration).
# We declare a separate data source here rather than referencing
# storage.tf's because Terraform doesn't share data resources across
# `-target` apply boundaries cleanly.

data "google_compute_default_service_account" "account_detect_runtime" {
  project = var.project_id
}

# Project-level data source — needed to resolve the Cloud Tasks
# service-agent email at plan time, which embeds project_number.
# Cloud Tasks Service Agent format:
#   service-{PROJECT_NUMBER}@gcp-sa-cloudtasks.iam.gserviceaccount.com
# The agent is created automatically by GCP when the Cloud Tasks API
# is first enabled in the project (already enabled — pubsub-invoker
# Cloud Scheduler usage requires it transitively).

data "google_project" "current" {
  project_id = var.project_id
}

# growth-api Cloud Run service — referenced for documentation/future
# subscription wiring (Cohort 6). Cohort 5 doesn't bind a push
# subscription itself; the topics are publish-only here.

# ─── Pub/Sub topics ─────────────────────────────────────────
# 7-day retention per existing convention (matches connectors.tf DLQs).
# All 5 topics are publish-only from the growth-api runtime in this
# cohort; subscriptions land in Cohort 6.

resource "google_pubsub_topic" "account_detect_started" {
  name    = "account.detect_started"
  project = var.project_id
  labels  = { service = "account-detect", kind = "lifecycle" }

  message_retention_duration = "604800s" # 7 days
}

resource "google_pubsub_topic" "account_detect_progress" {
  name    = "account.detect_progress"
  project = var.project_id
  labels  = { service = "account-detect", kind = "lifecycle" }

  message_retention_duration = "604800s"
}

resource "google_pubsub_topic" "account_detect_completed" {
  name    = "account.detect_completed"
  project = var.project_id
  labels  = { service = "account-detect", kind = "lifecycle" }

  message_retention_duration = "604800s"
}

resource "google_pubsub_topic" "account_detect_failed" {
  name    = "account.detect_failed"
  project = var.project_id
  labels  = { service = "account-detect", kind = "lifecycle" }

  message_retention_duration = "604800s"
}

# Dead-letter topic — Cloud Tasks doesn't have native dead-lettering, so
# the handler catches "this is attempt 3 and we still failed" and
# explicitly publishes to this topic for manual review. Cohort 6 wires
# an alert/audit subscriber.

resource "google_pubsub_topic" "account_detect_dead_letter" {
  name    = "account.detect_dead_letter"
  project = var.project_id
  labels  = { service = "account-detect", kind = "dlq" }

  message_retention_duration = "604800s"
}

# ─── Pub/Sub topic IAM — runtime SA gets publisher on each ────
# Explicit bindings (Fred decision 5: forward-compatible, not relying
# on the project-level roles/editor over-grant tracked by KAN-690).
# Bound to the data-sourced live identity so the binding follows the
# API's runtime SA through any future KAN-690 migration.

resource "google_pubsub_topic_iam_member" "account_detect_started_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.account_detect_started.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.account_detect_runtime.email}"
}

resource "google_pubsub_topic_iam_member" "account_detect_progress_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.account_detect_progress.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.account_detect_runtime.email}"
}

resource "google_pubsub_topic_iam_member" "account_detect_completed_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.account_detect_completed.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.account_detect_runtime.email}"
}

resource "google_pubsub_topic_iam_member" "account_detect_failed_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.account_detect_failed.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.account_detect_runtime.email}"
}

resource "google_pubsub_topic_iam_member" "account_detect_dead_letter_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.account_detect_dead_letter.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${data.google_compute_default_service_account.account_detect_runtime.email}"
}

# ─── Cloud Tasks queue ──────────────────────────────────────
# Per spec §6 / Fred's brief item 5:
#   - max-dispatches-per-second: 5
#   - max-concurrent-dispatches: 10
#   - max-attempts: 3
#   - min-backoff: 30s, max-backoff: 600s
#
# This is the FIRST Cloud Tasks queue in the codebase. Pattern
# established here for future queue use (e.g., scheduled exports,
# delayed sends beyond the 5-min cron cadence).

resource "google_cloud_tasks_queue" "account_detect" {
  name     = "account-detect"
  location = var.region
  project  = var.project_id

  rate_limits {
    max_dispatches_per_second = 5
    max_concurrent_dispatches = 10
  }

  retry_config {
    max_attempts       = 3
    min_backoff        = "30s"
    max_backoff        = "600s"
    max_doublings      = 4
    max_retry_duration = "1800s" # 30 min hard cap on retries
  }
}

# ─── IAM — Cloud Tasks dispatch ─────────────────────────────
# Three bindings cover the full Cloud Tasks + OIDC trust chain:
#
#   1. Caller (growth-api SA) needs `roles/cloudtasks.enqueuer` to call
#      CloudTasksClient.createTask from the detectFromWebsite mutation.
#
#   2. Caller (growth-api SA) needs `roles/iam.serviceAccountUser` on
#      pubsub-invoker so it can include `oidcToken: { serviceAccountEmail:
#      pubsub-invoker@... }` in the task body. GCP enforces this at
#      createTask time — without it, the API throws
#      `iam.serviceAccounts.actAs` before the task is queued. (Pre-Fred-
#      review v1 of this file mistakenly granted enqueuer to pubsub-invoker
#      itself; that was an over-grant + the actual missing binding was
#      this actAs grant for the API SA.)
#
#   3. Cloud Tasks Service Agent (`service-{PROJECT_NUMBER}@gcp-sa-
#      cloudtasks.iam.gserviceaccount.com`) needs `roles/iam.service
#      AccountTokenCreator` on pubsub-invoker so it can mint OIDC tokens
#      at dispatch time. This is dispatch-time impersonation by the GCP
#      service agent — distinct from the V4-signed-URL self-impersonation
#      pattern at storage.tf:105 (which is signing-time, where the API
#      SA signs as itself). Pre-Fred-review v1 had this binding shape
#      wrong (member was pubsub-invoker on itself); fixed here to point
#      at the Cloud Tasks Service Agent.

resource "google_project_iam_member" "account_detect_runtime_cloudtasks_enqueuer" {
  project = var.project_id
  role    = "roles/cloudtasks.enqueuer"
  member  = "serviceAccount:${data.google_compute_default_service_account.account_detect_runtime.email}"
}

resource "google_service_account_iam_member" "account_detect_runtime_actas_pubsub_invoker" {
  service_account_id = data.google_service_account.account_detect_pubsub_invoker.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${data.google_compute_default_service_account.account_detect_runtime.email}"
}

resource "google_service_account_iam_member" "cloudtasks_agent_token_creator_on_pubsub_invoker" {
  service_account_id = data.google_service_account.account_detect_pubsub_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-cloudtasks.iam.gserviceaccount.com"
}

# ─── Output ─────────────────────────────────────────────────

output "account_detect_queue_name" {
  value       = google_cloud_tasks_queue.account_detect.name
  description = "Cloud Tasks queue for detect-from-website dispatch. KAN-862."
}

output "account_detect_topics" {
  value = {
    started     = google_pubsub_topic.account_detect_started.name
    progress    = google_pubsub_topic.account_detect_progress.name
    completed   = google_pubsub_topic.account_detect_completed.name
    failed      = google_pubsub_topic.account_detect_failed.name
    dead_letter = google_pubsub_topic.account_detect_dead_letter.name
  }
  description = "Lifecycle Pub/Sub topics for account-detect pipeline. KAN-862."
}
