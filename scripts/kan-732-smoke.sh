#!/usr/bin/env bash
# KAN-732 — single-shot real-delivery smoke test for all 4 push subscribers.
#
# Run AFTER deploy-api auto-fires + new growth-api revision serves. Publishes
# a synthetic event to each topic; verifies a 200 (NOT 401) on each push
# endpoint within ~30s of publish.
#
# Per `feedback_oidc_audience_smoke_test_required` (3 prior incidents) — this
# is the canonical pre-Done gate. Single-subscriber smoke is insufficient
# because KAN-732 refactors all 4 verifiers simultaneously; any bug in
# expectedAudience() or the shared helper breaks ALL 4 at once.
#
# Usage:
#   ./scripts/kan-732-smoke.sh
#
# Exit code: 0 if all 4 pass, 1 if any fails. Operator-friendly + CI-friendly.

set -euo pipefail

PROJECT="growth-493400"
TENANT_ID="${SMOKE_TENANT_ID:-9ca85088-f65b-4bac-b098-fff742281ede}" # axisone-growth
NOW_ISO=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
PRICING_VERSION="2026-04-29-v1"

# Topic → minimal valid synthetic event (base64-decodable JSON matching the
# zod schema each subscriber expects).
declare -a SUBS=(
  # name|topic|push_endpoint_path|payload_json
  "action-decided|action.decided|/pubsub/action-decided|{\"eventId\":\"smoke-ad-001\",\"eventType\":\"action.decided\",\"version\":\"1.0\",\"publishedAt\":\"${NOW_ISO}\",\"tenantId\":\"${TENANT_ID}\",\"contactId\":\"00000000-0000-0000-0000-000000000001\",\"objectiveId\":\"smoke-obj\",\"decisionId\":\"dec_smoke_001\",\"action\":{\"actionType\":\"send_email\",\"channel\":\"email\",\"payload\":{}},\"decision\":{\"selectedStrategy\":\"smoke\",\"confidenceScore\":0.5,\"strategyReasoning\":\"smoke\",\"actionReasoning\":\"smoke\"},\"routing\":{\"agentType\":\"comm\",\"priority\":\"medium\",\"maxRetries\":3,\"timeoutMs\":15000}}"
  "action-executed|action.executed|/pubsub/action-executed|{\"topic\":\"action.executed\",\"timestamp\":\"${NOW_ISO}\",\"tenantId\":\"${TENANT_ID}\",\"actionId\":\"00000000-0000-0000-0000-000000000002\",\"decisionId\":\"dec_smoke_002\",\"contactId\":\"00000000-0000-0000-0000-000000000001\",\"connectionId\":\"00000000-0000-0000-0000-000000000003\",\"channel\":\"EMAIL\",\"provider\":\"resend\",\"status\":\"sent\",\"attemptNumber\":1}"
  "knowledge-ingest|knowledge.ingest.requested|/pubsub/knowledge-ingest|{\"eventId\":\"smoke-ki-001\",\"eventType\":\"knowledge.ingest.requested\",\"version\":\"1.0\",\"tenantId\":\"${TENANT_ID}\",\"ingestionId\":\"smoke-ing-001\",\"sourceId\":\"smoke-src-001\",\"path\":\"qa_pair\",\"payload\":{},\"enqueuedAt\":\"${NOW_ISO}\"}"
  "llm-call|llm.call|/pubsub/llm-call|{\"eventId\":\"smoke-llm-001\",\"eventType\":\"llm.call\",\"publishedAt\":\"${NOW_ISO}\",\"tenantId\":\"${TENANT_ID}\",\"provider\":\"anthropic\",\"model\":\"claude-sonnet-4-6\",\"tier\":\"reasoning\",\"inputTokens\":10,\"outputTokens\":5,\"costUsd\":0.0001,\"pricingVersion\":\"${PRICING_VERSION}\",\"latencyMs\":100,\"success\":true,\"fallbackUsed\":false,\"callerTag\":\"smoke:kan-732\"}"
)

echo "=== KAN-732 4-subscriber real-delivery smoke ==="
echo "Project: $PROJECT"
echo "Tenant: $TENANT_ID"
echo "Now: $NOW_ISO"
echo

PUBLISH_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "[publish] sending synthetic events..."
for entry in "${SUBS[@]}"; do
  IFS='|' read -r name topic _path payload <<< "$entry"
  echo -n "  $name → $topic ... "
  if gcloud pubsub topics publish "$topic" --message="$payload" --project="$PROJECT" >/dev/null 2>&1; then
    echo "published"
  else
    echo "PUBLISH FAILED"
    exit 1
  fi
done
echo

echo "[wait] giving Pub/Sub 20s to deliver + log..."
sleep 20
echo

# Query Cloud Logging for the most recent push to each endpoint.
PASS=0
FAIL=0
for entry in "${SUBS[@]}"; do
  IFS='|' read -r name _topic path _payload <<< "$entry"
  status=$(gcloud logging read "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"growth-api\" AND httpRequest.requestUrl=~\"${path}\" AND timestamp>=\"${PUBLISH_TIME}\"" \
    --limit=1 --format='value(httpRequest.status)' --project="$PROJECT" --freshness=5m 2>/dev/null | head -1)
  if [ "$status" = "200" ]; then
    echo "  $name $path → HTTP 200 ✓ PASS"
    PASS=$((PASS + 1))
  elif [ -z "$status" ]; then
    echo "  $name $path → no log entry within 5m window ✗ FAIL (delivery lost or delayed)"
    FAIL=$((FAIL + 1))
  else
    echo "  $name $path → HTTP $status ✗ FAIL"
    FAIL=$((FAIL + 1))
  fi
done
echo

echo "=== Summary: $PASS pass, $FAIL fail ==="
if [ $FAIL -gt 0 ]; then
  echo
  echo "Diagnostics:"
  echo "  • Confirm each subscription's audience matches its pushEndpoint:"
  echo "    for sub in action.decided.message-composer action.executed.outcome-writer \\"
  echo "               knowledge.ingest.requested.worker llm-call-cost-aggregator-sub; do"
  echo "      gcloud pubsub subscriptions describe \$sub --project=$PROJECT \\"
  echo "        --format='value(pushConfig.pushEndpoint, pushConfig.oidcToken.audience)'"
  echo "    done"
  echo "  • Look for [oidc-pubsub-verify] audience mismatch warnings in Cloud Logging:"
  echo "    gcloud logging read 'jsonPayload.\"logging.googleapis.com/labels\".event=\"oidc-pubsub-audience-mismatch\"' \\"
  echo "      --project=$PROJECT --freshness=10m"
  exit 1
fi

echo "All 4 push subscribers verified. KAN-732 audience-mismatch class structurally eliminated."
exit 0
