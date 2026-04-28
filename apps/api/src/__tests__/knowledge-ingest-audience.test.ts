/**
 * KAN-731 fix-forward — env-var pattern test for the knowledge-ingest
 * subscriber's OIDC audience.
 *
 * Catches future env-var typos (KNOWLEDGE_INGREST_AUDIENCE,
 * KNOWLEDGE_INGEST_AUDIANCE, etc.) at test time. Doesn't validate against
 * real Pub/Sub — that's KAN-733's smoke-test scope. The audience config
 * was invisible to the prior unit tests (they mocked OIDC verify),
 * which is exactly why KAN-731 happened.
 *
 * Pattern this test asserts:
 *   - The subscriber file references `KNOWLEDGE_INGEST_AUDIENCE` (typo-safe)
 *   - The default fallback URL matches the actual deployed endpoint
 *
 * Until KAN-732's request-URL-derived audience refactor lands, every new
 * subscriber should add a similar test for its dedicated env var.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const subscriberPath = resolve(__dirname, "../subscribers/knowledge-ingest-push.ts");
const subscriberSrc = readFileSync(subscriberPath, "utf8");

describe("knowledge-ingest subscriber OIDC audience config", () => {
  it("references KNOWLEDGE_INGEST_AUDIENCE env var (no typo)", () => {
    expect(subscriberSrc).toContain("process.env.KNOWLEDGE_INGEST_AUDIENCE");
  });

  it("default fallback matches the deployed Cloud Run endpoint URL", () => {
    expect(subscriberSrc).toContain("/pubsub/knowledge-ingest");
    expect(subscriberSrc).toContain("growth-api-biut5gfhuq-uc.a.run.app");
  });

  it("does NOT reuse APP_API_URL (which is action-decided's audience)", () => {
    // Anchor for KAN-731's RCA — make sure the regression can't reintroduce.
    expect(subscriberSrc).not.toContain("process.env.APP_API_URL");
  });
});
