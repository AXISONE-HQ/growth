/**
 * Connectors Service — GCP resources.
 *
 * Usage:
 *   terraform init
 *   terraform plan -var project_id=growth-prod -var region=us-central1
 *   terraform apply
 *
 * Idempotent: re-running apply is safe.
 *
 * Covers Jira: KAN-478 (Secret Manager IAM), KAN-479 (Pub/Sub),
 * KAN-482 (Cloud Run + Cloud Build), KAN-524 (service account).
 */

terraform {
  required_version = ">= 1.5"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.40"
    }
  }
}

# ─── Variables ──────────────────────────────────────────────
variable "project_id" {
  description = "GCP project ID (e.g. growth-prod, growth-dev)"
  type        = string
}

variable "region" {
  description = "Primary region"
  type        = string
  default     = "us-central1"
}

variable "vpc_connector_name" {
  description = "Name of existing VPC connector (shared with apps/api)"
  type        = string
  default     = "growth-vpc-connector"
}

variable "github_owner" {
  type    = string
  default = "AXISONE-HQ"
}

variable "github_repo" {
  type    = string
  default = "growth"
}

# ─── Provider ───────────────────────────────────────────────
provider "google" {
  project = var.project_id
  region  = var.region
}

# ─── Service Account for Connectors (KAN-478, KAN-524) ─────
resource "google_service_account" "connectors" {
  account_id   = "connectors-sa"
  display_name = "Connectors Service"
  description  = "Runtime SA for @growth-ai/connectors Cloud Run service"
}

# Grant core IAM roles
resource "google_project_iam_member" "connectors_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.connectors.email}"
}

resource "google_project_iam_member" "connectors_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:${google_service_account.connectors.email}"
}

resource "google_project_iam_member" "connectors_pubsub_subscriber" {
  project = var.project_id
  role    = "roles/pubsub.subscriber"
  member  = "serviceAccount:${google_service_account.connectors.email}"
}

resource "google_project_iam_member" "connectors_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.connectors.email}"
}

resource "google_project_iam_member" "connectors_logs_writer" {
  project = var.project_id
  role    = "roles/logging.logWriter"
  member  = "serviceAccount:${google_service_account.connectors.email}"
}

resource "google_project_iam_member" "connectors_trace_agent" {
  project = var.project_id
  role    = "roles/cloudtrace.agent"
  member  = "serviceAccount:${google_service_account.connectors.email}"
}

# ─── Pub/Sub Topics (KAN-479, KAN-527) ─────────────────────
locals {
  topics = [
    "action.send",
    "action.executed",
    "inbound.raw",
    "connection.health.changed",
  ]
}

resource "google_pubsub_topic" "main" {
  for_each = toset(local.topics)
  name     = each.value
  labels   = { service = "connectors" }
}

# DLQ topic per main topic
resource "google_pubsub_topic" "dlq" {
  for_each = toset(local.topics)
  name     = "${each.value}.dlq"
  labels   = { service = "connectors", kind = "dlq" }

  message_retention_duration = "604800s" # 7 days
}

# Subscription: action.send → Connectors push endpoint
resource "google_pubsub_subscription" "action_send_to_connectors" {
  name  = "connectors-action-send"
  topic = google_pubsub_topic.main["action.send"].name

  ack_deadline_seconds       = 60
  message_retention_duration = "86400s" # 24h

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.connectors.uri}/pubsub/action-send"
    oidc_token {
      service_account_email = google_service_account.connectors.email
    }
    attributes = { "x-goog-version" = "v1" }
  }

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dlq["action.send"].id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}

# ─── Secret placeholders (KAN-478) ─────────────────────────
# Actual values uploaded manually with `gcloud secrets versions add`.
# Terraform manages the secret container + IAM; operators supply the payload.

locals {
  platform_secrets = [
    "connectors-internal-trpc-token",
    "twilio-master",
    "sendgrid-master",
    "sendgrid-webhook-public-key",
    "unsubscribe-signing-key",
    "axisone/meta-app/app-id",
    "axisone/meta-app/app-secret",
    "axisone/meta-app/webhook-verify-token",
  ]
}

resource "google_secret_manager_secret" "platform" {
  for_each  = toset(local.platform_secrets)
  secret_id = replace(each.value, "/", "-") # Secret Manager doesn't allow "/" — we normalize for the resource name

  replication {
    auto {}
  }

  labels = { service = "connectors" }
}

# Grant connectors-sa accessor on each platform secret
resource "google_secret_manager_secret_iam_member" "connectors_access" {
  for_each  = google_secret_manager_secret.platform
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.connectors.email}"
}

# ─── Cloud Run Service ─────────────────────────────────────
resource "google_cloud_run_v2_service" "connectors" {
  name     = "growth-connectors"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"

  template {
    service_account = google_service_account.connectors.email

    scaling {
      min_instance_count = 0
      max_instance_count = 10
    }

    vpc_access {
      connector = "projects/${var.project_id}/locations/${var.region}/connectors/${var.vpc_connector_name}"
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = "gcr.io/${var.project_id}/growth-connectors:latest"

      ports {
        container_port = 8081
      }

      resources {
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "PORT"
        value = "8081"
      }
      env {
        name  = "PUBLIC_WEBHOOK_BASE_URL"
        value = "https://connectors.growth.axisone.com"
      }

      env {
        name = "INTERNAL_TRPC_AUTH_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.platform["connectors-internal-trpc-token"].secret_id
            version = "latest"
          }
        }
      }

      # DATABASE_URL and REDIS_URL come from secrets managed by the main app's Terraform.
      # Reference by name only; operator ensures IAM binding before first deploy.
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = "growth-database-url"
            version = "latest"
          }
        }
      }
      env {
        name = "REDIS_URL"
        value_source {
          secret_key_ref {
            secret  = "growth-redis-url"
            version = "latest"
          }
        }
      }

      # Feature flags — default off; flip once secrets are in place
      env {
        name  = "ENABLE_TWILIO"
        value = "false"
      }
      env {
        name  = "ENABLE_SENDGRID"
        value = "false"
      }
      env {
        name  = "ENABLE_META"
        value = "false"
      }

      startup_probe {
        http_get {
          path = "/healthz"
          port = 8081
        }
        period_seconds    = 3
        timeout_seconds   = 2
        failure_threshold = 5
      }

      liveness_probe {
        http_get {
          path = "/healthz"
          port = 8081
        }
        period_seconds    = 30
        timeout_seconds   = 5
        failure_threshold = 3
      }
    }

    timeout = "30s"
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    # Image is managed by Cloud Build — ignore revision churn during apply
    ignore_changes = [
      template[0].containers[0].image,
      template[0].revision,
      client,
      client_version,
    ]
  }
}

# ─── Cloud Build Trigger (KAN-482) ─────────────────────────
resource "google_cloudbuild_trigger" "connectors" {
  name        = "growth-connectors-main"
  description = "Build + deploy @growth-ai/connectors on push to main"
  location    = "global"

  github {
    owner = var.github_owner
    name  = var.github_repo

    push {
      branch = "^main$"
    }
  }

  # Only fire on changes to the connectors service or its dependencies
  included_files = [
    "apps/connectors/**",
    "packages/connector-contracts/**",
    "packages/db/**",
    "cloudbuild-connectors.yaml",
  ]

  filename = "cloudbuild-connectors.yaml"
}

# ─── Cloud Scheduler — token health + 10DLC polling ────────
resource "google_cloud_scheduler_job" "meta_token_health" {
  name             = "connectors-meta-token-health"
  description      = "Daily Meta Page token health sweep (KAN-629)"
  schedule         = "0 4 * * *" # 04:00 UTC daily
  time_zone        = "Etc/UTC"
  attempt_deadline = "540s"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.connectors.uri}/internal/meta/token-health"
    oidc_token {
      service_account_email = google_service_account.connectors.email
    }
  }
}

resource "google_cloud_scheduler_job" "twilio_compliance_poll" {
  name             = "connectors-twilio-10dlc-poll"
  description      = "Poll 10DLC Brand + Campaign status (KAN-571)"
  schedule         = "0 */4 * * *" # every 4h
  time_zone        = "Etc/UTC"
  attempt_deadline = "540s"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.connectors.uri}/internal/twilio/compliance-poll"
    oidc_token {
      service_account_email = google_service_account.connectors.email
    }
  }
}

resource "google_cloud_scheduler_job" "connection_health_sweep" {
  name             = "connectors-connection-health"
  description      = "Daily ChannelConnection health check (KAN-560)"
  schedule         = "0 4 * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "540s"

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.connectors.uri}/internal/health-sweep"
    oidc_token {
      service_account_email = google_service_account.connectors.email
    }
  }
}

# ─── Monitoring dashboard + alert policies (KAN-481, KAN-534, KAN-535) ──
resource "google_monitoring_alert_policy" "connectors_error_rate" {
  display_name = "connectors: 5xx error rate > 5%"
  combiner     = "OR"

  conditions {
    display_name = "5xx rate"
    condition_threshold {
      filter          = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"growth-connectors\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.05
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_RATE"
      }
    }
  }

  notification_channels = [] # Wire up via separate resource when PagerDuty channel is configured
  enabled               = true
}

resource "google_monitoring_alert_policy" "dlq_depth" {
  display_name = "connectors: DLQ depth > 100"
  combiner     = "OR"

  conditions {
    display_name = "DLQ message backlog"
    condition_threshold {
      filter          = "resource.type=\"pubsub_subscription\" AND metric.type=\"pubsub.googleapis.com/subscription/num_undelivered_messages\" AND resource.labels.subscription_id=~\".*\\\\.dlq.*\""
      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 100
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
    }
  }

  notification_channels = []
  enabled               = true
}

# ─── Outputs ───────────────────────────────────────────────
output "service_url" {
  value       = google_cloud_run_v2_service.connectors.uri
  description = "Private Cloud Run URL — main app calls this for tRPC"
}

output "service_account_email" {
  value       = google_service_account.connectors.email
  description = "Attach this to Cloud Build deploys + Pub/Sub OIDC"
}

output "secrets_to_populate" {
  value       = [for s in local.platform_secrets : s]
  description = "Secrets created empty — upload payload with `gcloud secrets versions add NAME --data-file=-`"
}
