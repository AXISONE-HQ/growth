/**
 * KAN-707 PR A — Knowledge ingest push subscriber (STUB).
 *
 * Cloud Run Pub/Sub push endpoint. Subscription:
 *   knowledge.ingest.requested.worker (push to /pubsub/knowledge-ingest)
 *
 * PR A scope: stub only. Verifies OIDC, parses the envelope, logs the event,
 * 200-OKs to ack the message. No actual ingestion logic — that's PR B's job
 * (URL crawl, doc parse, Q&A pair embedding).
 *
 * Mirrors `action-decided-push.ts` for the OIDC + envelope-parsing pattern.
 *
 * Operational guardrail (KAN-715): `PUBSUB_PUSH_SKIP_AUTH=true` MUST NOT be
 * set in any prod env. The env var stays in the test bypass for vitest only.
 * If accidentally set in prod, the next push request will accept any token —
 * that's the foot-gun. Add to KAN-715's audit checklist.
 *
 * Error policy:
 *   - 401 on missing or invalid OIDC token (Pub/Sub will retry → DLQ after 5)
 *   - 200 + log on malformed envelope / unknown ingestionId (poison-message
 *     defense — don't loop a bad message forever)
 *   - 500 on unexpected server errors (Pub/Sub retries with backoff)
 */
import { Hono } from "hono";
import { z } from "zod";
import { OAuth2Client } from "google-auth-library";

export const knowledgeIngestPushApp = new Hono();

const oauth = new OAuth2Client();

const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const IngestRequestedEventSchema = z.object({
  eventId: z.string(),
  eventType: z.literal("knowledge.ingest.requested"),
  version: z.string(),
  tenantId: z.string(),
  ingestionId: z.string(),
  sourceId: z.string(),
  path: z.enum(["url", "document", "qa_pair"]),
  payload: z.unknown(),
  enqueuedAt: z.string(),
});

async function verifyOidc(authHeader: string | undefined, audience: string): Promise<boolean> {
  if (!authHeader?.startsWith("Bearer ")) return false;
  const token = authHeader.slice("Bearer ".length);
  try {
    const ticket = await oauth.verifyIdToken({ idToken: token, audience });
    return !!ticket.getPayload();
  } catch {
    return false;
  }
}

knowledgeIngestPushApp.post("/knowledge-ingest", async (c) => {
  const skipAuth = process.env.NODE_ENV === "test" || process.env.PUBSUB_PUSH_SKIP_AUTH === "true";
  if (!skipAuth) {
    const audience = process.env.APP_API_URL ?? "https://growth-api-biut5gfhuq-uc.a.run.app";
    const ok = await verifyOidc(c.req.header("authorization"), audience);
    if (!ok) return c.text("unauthorized", 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error("[knowledge-ingest-push] malformed envelope", err);
    return c.text("ok", 200);
  }

  let event: z.infer<typeof IngestRequestedEventSchema>;
  try {
    const decoded = Buffer.from(envelope.message.data, "base64").toString("utf8");
    event = IngestRequestedEventSchema.parse(JSON.parse(decoded));
  } catch (err) {
    console.error("[knowledge-ingest-push] malformed knowledge.ingest.requested payload", err);
    return c.text("ok", 200);
  }

  // PR A stub: log the event + 200. PR B replaces this body with the actual
  // dispatch to the URL crawl / doc upload / Q&A ingestion implementations.
  console.log(
    `[knowledge-ingest-push] STUB received eventId=${event.eventId} tenantId=${event.tenantId} ingestionId=${event.ingestionId} path=${event.path}`,
  );
  return c.text("ok", 200);
});
