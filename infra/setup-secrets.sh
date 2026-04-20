#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# Create 8 Secret Manager containers + grant connectors-sa access.
# Paste into GCP Cloud Shell (https://shell.cloud.google.com) or
# run locally if you have gcloud authenticated to the project.
#
# Safe to re-run — idempotent (create commands skip if secret exists).
# ─────────────────────────────────────────────────────────────

set -euo pipefail

PROJECT_ID="${PROJECT_ID:-growth-493400}"
SA="connectors-sa@${PROJECT_ID}.iam.gserviceaccount.com"

gcloud config set project "$PROJECT_ID"

SECRETS=(
  "connectors-internal-trpc-token"
  "twilio-master"
  "sendgrid-master"
  "sendgrid-webhook-public-key"
  "unsubscribe-signing-key"
  "axisone-meta-app-app-id"
  "axisone-meta-app-app-secret"
  "axisone-meta-app-webhook-verify-token"
)

echo "Creating ${#SECRETS[@]} secrets + IAM bindings for $SA..."

for secret in "${SECRETS[@]}"; do
  # Create secret container (skip if exists)
  if gcloud secrets describe "$secret" --quiet >/dev/null 2>&1; then
    echo "  ✓ $secret (exists)"
  else
    gcloud secrets create "$secret" \
      --replication-policy="automatic" \
      --labels="service=connectors"
    echo "  + $secret (created)"
  fi

  # Grant connectors-sa accessor role
  gcloud secrets add-iam-policy-binding "$secret" \
    --member="serviceAccount:$SA" \
    --role="roles/secretmanager.secretAccessor" \
    --quiet >/dev/null
done

echo ""
echo "✅ All 8 secrets exist with IAM bindings."
echo ""
echo "NEXT: populate each secret with its real payload. Examples:"
echo ""
echo "  # Generate + store internal tRPC token"
echo "  openssl rand -hex 32 | gcloud secrets versions add connectors-internal-trpc-token --data-file=-"
echo ""
echo "  # Twilio master (replace ACxxxx + token with real values)"
echo "  echo '{\"accountSid\":\"ACxxxx\",\"authToken\":\"xxxx\"}' | \\"
echo "    gcloud secrets versions add twilio-master --data-file=-"
echo ""
echo "  # SendGrid master API key"
echo "  echo -n 'SG.xxxxx' | gcloud secrets versions add sendgrid-master --data-file=-"
echo ""
echo "  # Unsubscribe signing key"
echo "  openssl rand -hex 32 | gcloud secrets versions add unsubscribe-signing-key --data-file=-"
echo ""
echo "  # Meta App credentials"
echo "  echo -n '\$META_APP_ID' | gcloud secrets versions add axisone-meta-app-app-id --data-file=-"
echo "  echo -n '\$META_APP_SECRET' | gcloud secrets versions add axisone-meta-app-app-secret --data-file=-"
echo "  openssl rand -hex 32 | gcloud secrets versions add axisone-meta-app-webhook-verify-token --data-file=-"
