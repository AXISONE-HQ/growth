/**
 * Cross-service Cloud Monitoring alert policies + notification channels.
 *
 * Usage (operator-imperative, mirrors connectors.tf):
 *   cd infra/terraform
 *   terraform init   # state backend operator-managed
 *   terraform plan   -var project_id=growth-493400 -var fred_email=fred@axisone.ca
 *   terraform apply  -var project_id=growth-493400 -var fred_email=fred@axisone.ca
 *
 * Idempotent: re-running apply is safe.
 *
 * Covers Jira: KAN-759 (agentic-cost-threshold-breach alert policy).
 *
 * ─── Path-2 decision (KAN-759 audit) ────────────────────────
 *
 * Uses `condition_matched_log` for log-based alerting (single resource) over
 * the older Path-1 approach (`google_logging_metric` + `condition_threshold`
 * against the metric). Verified upstream:
 *   - notification_rate_limit is REQUIRED for LogMatch conditions (not
 *     optional) — terraform-provider-google docs.
 *   - "Each combination of extracted values is treated as a separate rule
 *     for the purposes of triggering notifications" — per-tenant dedup is
 *     documented behavior when label_extractors expose tenantId.
 *   - period in notification_rate_limit gates re-fire frequency per
 *     extracted-label-value group (per-tenant in our case).
 *
 * ─── Discipline (`feedback_terraform_emergency_edit_protocol`) ──
 *
 * Hybrid Terraform-as-truth: pure Terraform-only is aspirational under
 * solo-engineer pressure. UI edits permitted under emergency, but MUST be
 * reflected back into this file within one sprint, drift noticed each apply.
 *
 * ─── Runbook: agentic-cost-threshold-breach ─────────────────
 *
 * When this alert fires (you'll get an email at the address below):
 *
 *   1. Check `/settings/observability` for the breaching tenant. The email
 *      subject + body include `tenantId` from the label extractor.
 *   2. Identify which `callerTagPrefix` is dominant (agentic vs agentic-tool
 *      vs csv-import vs knowledge-worker). The shadow_ratio in the message
 *      tells you how far over 2.5× the breach went.
 *   3. Decide:
 *      (a) Tenant config change to disable agentic mode (kill-switch:
 *          `tenant.autoApproveEnabled = false`) — heaviest hammer, blocks
 *          all agentic activity for the tenant.
 *      (b) Investigate why agentic loop is iterating more than expected —
 *          review recent Decision rows for the tenant + look for tool-use
 *          loops or hallucinated action types.
 *      (c) Accept-and-move-on if the 2.5× was a one-time spike (e.g., one
 *          tenant ran a bulk-ingest test). The notification_rate_limit will
 *          suppress re-fires for 1h per tenant; if it doesn't fire again,
 *          it was transient.
 *
 *   See KAN-745 PR B (PR #78) for the threshold-alarm.ts emitter logic.
 *
 * ─── Post-apply synthetic-breach smoke test ──────────────────
 *
 * Per `feedback_oidc_audience_smoke_test_required` discipline (real-delivery
 * smoke for any new ops-alerting infra). Fire 2 synthetic breaches for
 * 2 different tenants 60s apart to verify per-tenant dedup:
 *
 *   gcloud logging write growth-api '[agentic-cost] tenant=test-tenant-a shadow_ratio=3.0x window=2026-04-30T14:00:00.000Z agentic=$10.00 non_agentic=$3.00 threshold=2.5' \
 *     --severity=WARNING \
 *     --payload-type=json \
 *     --project=growth-493400
 *
 * (synthetic payload must include the structured labels — see the smoke
 * helper script if added; until then, trigger via real shadow traffic on a
 * test tenant.)
 *
 * EXPECTED: TWO emails arrive in Fred's inbox within 5 min, one per tenantId.
 * If only ONE email arrives, per-tenant dedup is broken — fix-forward to
 * Path 1 (log-based metric + group_by_fields). Document outcome in
 * `decision_kan_759_terraform_alert_path` memory entry.
 *
 * ─── IAM prerequisites (operator running terraform apply) ────
 *
 * Per `reference_iam_over_grant_with_followup`:
 *   - roles/monitoring.alertPolicyEditor on growth-493400
 *   - roles/monitoring.notificationChannelEditor on growth-493400
 *
 * Verify before apply:
 *   gcloud projects get-iam-policy growth-493400 \
 *     --flatten='bindings[].members' \
 *     --filter='bindings.members:user:fred@axisone.ca' \
 *     --format='value(bindings.role)' | grep monitoring
 */

# ─── Variables (additive — connectors.tf already declares project_id + region) ──

variable "fred_email" {
  description = "Email address for KAN-759 ops alert notifications. Sprint 5 single-tenant default; per-tenant routing follow-up tracked separately."
  type        = string
  default     = "fred@axisone.ca"
}

# ─── Notification channel (KAN-759) ─────────────────────────

resource "google_monitoring_notification_channel" "email_fred" {
  display_name = "Ops alerts — Fred (email)"
  type         = "email"
  description  = "Sprint 5 single-tenant ops channel. Per-tenant routing deferred until multi-tenant traffic justifies the per-channel mapping."

  labels = {
    email_address = var.fred_email
  }

  user_labels = {
    sprint = "5"
    owner  = "fred"
  }
}

# ─── Alert policy (KAN-759) ─────────────────────────────────

resource "google_monitoring_alert_policy" "agentic_cost_threshold_breach" {
  display_name = "agentic-cost: shadow_ratio breach (per-tenant)"
  combiner     = "OR"
  enabled      = true

  conditions {
    display_name = "agentic-cost-threshold-breach log entry"

    # Path 2 — direct log-based alerting via condition_matched_log.
    # Single resource (vs Path 1 which needs a separate google_logging_metric).
    condition_matched_log {
      filter = <<-EOT
        resource.type="cloud_run_revision"
        AND resource.labels.service_name="growth-api"
        AND jsonPayload."logging.googleapis.com/labels".event="agentic-cost-threshold-breach"
      EOT

      # Per-tenant dedup: each unique extracted tenantId becomes a separate
      # "rule" for notification purposes (per upstream provider docs).
      label_extractors = {
        "tenantId" = "EXTRACT(jsonPayload.\"logging.googleapis.com/labels\".tenantId)"
      }
    }
  }

  alert_strategy {
    # Required for LogMatch conditions per upstream Terraform provider docs.
    # period gates re-fire frequency per (extracted-label-value) group →
    # per-tenant in our case. 3600s = max 1 alert per tenant per hour.
    notification_rate_limit {
      period = "3600s"
    }

    # Auto-close after 1 day with no matching log entries. Cloud Monitoring
    # auto-resolves when condition clears; this caps how long an unresolved
    # alert lingers if the log stream goes quiet.
    auto_close = "86400s"
  }

  notification_channels = [
    google_monitoring_notification_channel.email_fred.name,
  ]

  documentation {
    content   = <<-EOT
      **Triage runbook** (full version in monitoring.tf header):

      1. Open `/settings/observability` filtered to the tenant from the alert label `tenantId`.
      2. Identify dominant `callerTagPrefix` (agentic / agentic-tool / csv-import / knowledge-worker).
      3. Decide: (a) kill-switch tenant agentic mode, (b) investigate loop iteration, (c) accept-and-move-on if one-time spike.

      KAN-745 PR B emitter source: `packages/api/src/services/observability/threshold-alarm.ts`.
      KAN-759 alert policy source: `infra/terraform/monitoring.tf`.
    EOT
    mime_type = "text/markdown"
  }

  user_labels = {
    sprint  = "5"
    ticket  = "kan-759"
    service = "growth-api"
  }
}

# ─── Outputs ────────────────────────────────────────────────

output "email_fred_channel" {
  value       = google_monitoring_notification_channel.email_fred.name
  description = "Channel resource name. Reference from connectors.tf alert policies once KAN-771 lands (currently scoped OUT pending pre-apply state check)."
}

output "agentic_cost_alert_policy" {
  value       = google_monitoring_alert_policy.agentic_cost_threshold_breach.name
  description = "Alert policy resource name. Use with `gcloud alpha monitoring policies describe NAME` for state check."
}
