/**
 * KAN-732 — canonical request-URL-derived OIDC audience for Pub/Sub push subscribers.
 *
 * Replaces 4 subscriber-local `verifyOidc` helpers + 3 per-subscriber audience
 * env vars (`APP_API_URL`, `KNOWLEDGE_INGEST_AUDIENCE`, `LLM_CALL_AUDIENCE`)
 * with a single shared helper that derives the expected audience from the
 * inbound request URL — the canonical Cloud Run + Pub/Sub pattern.
 *
 * **Why this exists (3 incidents motivating the structural fix):**
 *   - KAN-731 (Sprint 2.2) — knowledge-ingest reused APP_API_URL → 401s
 *   - KAN-741 (Sprint 3) — lead-inbox same pattern → fix-forward
 *   - KAN-745 PR B (Sprint 4) — llm-call shipped reading APP_API_URL again
 *     → PR #79 fix-forward
 *
 * Per-subscriber audience env var pattern scales linearly + creates a
 * copy-paste-from-action-decided trap. Future push subscribers inherit
 * this helper for free; the audience-mismatch class becomes impossible.
 *
 * **Resolution order for the Host:**
 *   1. `X-Forwarded-Host` header (load balancer / VPC egress proxy carry the
 *      original host)
 *   2. `Host` header (default Cloud Run)
 *   3. Throw → caller responds 401 (defensive; should not happen on Cloud Run)
 *
 * The path component matches `c.req.path` exactly — the same string Pub/Sub
 * used to push (e.g., `/pubsub/llm-call`). Trailing slashes stripped to
 * canonicalize against the OIDC token's `aud` claim.
 *
 * **Defensive WARNING log** fires when computed audience ≠ token's `aud`
 * claim. Structured payload with `expectedAudience` + `tokenAudience` +
 * `requestUrl` + `subscriberRoute` so Cloud Logging surfaces the diagnostic
 * without operators needing to grep raw 401s.
 */
import { OAuth2Client } from "google-auth-library";
import type { Context } from "hono";

const oauth = new OAuth2Client();

/**
 * Compute the expected OIDC audience from the inbound HTTP request.
 * Throws if no Host header is present (defensive — Cloud Run always sets it).
 */
export function expectedAudience(c: Context): string {
  const host = c.req.header("x-forwarded-host") ?? c.req.header("host");
  if (!host) {
    throw new Error("[oidc-pubsub-verify] no Host header — cannot compute audience");
  }
  // Canonicalize: strip trailing slash so audience match doesn't fail on
  // path normalization differences. Cloud Run + Pub/Sub never include
  // trailing slashes today, but the canonical form is stable.
  const path = c.req.path.replace(/\/$/, "");
  return `https://${host}${path}`;
}

/**
 * Verify the OIDC Bearer token on a Pub/Sub push request.
 *
 * Returns true on valid token + matching audience. Returns false on:
 *   - missing or malformed Bearer header
 *   - missing Host (cannot compute expected audience)
 *   - expired or invalid token (verifyIdToken throws)
 *   - audience mismatch (logged as structured WARNING for ops diagnostic)
 *
 * Test bypass: `NODE_ENV === 'test'` OR `PUBSUB_PUSH_SKIP_AUTH === 'true'`
 * returns true unconditionally. Existing convention from the 4 subscribers
 * being refactored.
 */
export async function verifyPubsubOidc(c: Context): Promise<boolean> {
  if (process.env.NODE_ENV === "test" || process.env.PUBSUB_PUSH_SKIP_AUTH === "true") {
    return true;
  }

  const authHeader = c.req.header("authorization");
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);

  let expected: string;
  try {
    expected = expectedAudience(c);
  } catch (err) {
    console.warn("[oidc-pubsub-verify] no Host header on request — cannot verify audience", {
      severity: "WARNING",
      "logging.googleapis.com/labels": {
        service: "growth-api",
        event: "oidc-pubsub-verify-no-host",
      },
      requestUrl: c.req.url,
      subscriberRoute: c.req.path,
      err: (err as Error)?.message,
    });
    return false;
  }

  try {
    const ticket = await oauth.verifyIdToken({ idToken: token, audience: expected });
    const payload = ticket.getPayload();
    if (!payload) return false;
    // verifyIdToken validates aud already, but we also do a defensive log
    // when the token's aud doesn't match — useful diagnostic when the
    // subscription's audience config drifts from the actual route.
    const tokenAud = payload.aud;
    if (tokenAud !== expected) {
      logAudienceMismatch({
        expectedAudience: expected,
        tokenAudience: typeof tokenAud === "string" ? tokenAud : JSON.stringify(tokenAud),
        requestUrl: c.req.url,
        subscriberRoute: c.req.path,
      });
      return false;
    }
    return true;
  } catch (err) {
    // verifyIdToken throws on aud mismatch (among other token errors).
    // Capture as a structured-warning for ops diagnostic — distinguish from
    // generic 401s in Cloud Logging.
    const message = (err as Error)?.message ?? "unknown verify error";
    if (message.includes("aud") || message.toLowerCase().includes("audience")) {
      logAudienceMismatch({
        expectedAudience: expected,
        tokenAudience: "unknown (verifyIdToken threw)",
        requestUrl: c.req.url,
        subscriberRoute: c.req.path,
        verifyError: message,
      });
    }
    return false;
  }
}

/**
 * Structured WARNING log on audience mismatch. Cloud Logging picks up the
 * `logging.googleapis.com/labels` payload so KAN-759-style alert policies
 * can target this event by label.
 *
 * Exported for tests + for any caller that wants to emit the same
 * diagnostic shape from a different verification path.
 */
export interface AudienceMismatchPayload {
  expectedAudience: string;
  tokenAudience: string;
  requestUrl: string;
  subscriberRoute: string;
  verifyError?: string;
}

export function logAudienceMismatch(payload: AudienceMismatchPayload): void {
  console.warn(
    `[oidc-pubsub-verify] audience mismatch — expected=${payload.expectedAudience} token_aud=${payload.tokenAudience} route=${payload.subscriberRoute}`,
    {
      severity: "WARNING",
      "logging.googleapis.com/labels": {
        service: "growth-api",
        event: "oidc-pubsub-audience-mismatch",
        subscriberRoute: payload.subscriberRoute,
      },
      ...payload,
    },
  );
}
