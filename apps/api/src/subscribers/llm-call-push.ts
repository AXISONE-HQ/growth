/**
 * llm.call push subscriber — KAN-745 PR B
 *
 * Cloud Run Pub/Sub push endpoint. Subscription provisioned operator-side:
 *   gcloud pubsub subscriptions create llm-call-cost-aggregator-sub \
 *     --topic=llm.call \
 *     --push-endpoint=$GROWTH_API_URL/pubsub/llm-call \
 *     --push-auth-service-account=growth-api-pubsub@growth-493400.iam.gserviceaccount.com \
 *     --push-auth-token-audience=$GROWTH_API_URL/pubsub/llm-call
 *
 * The audience MUST equal the env var `LLM_CALL_AUDIENCE` set on the
 * growth-api Cloud Run service (per-subscriber audience per the KAN-741
 * pattern; KAN-732 will retire this when canonical request-URL-derived
 * audience lands).
 *
 * Flow: Pub/Sub push → POST /pubsub/llm-call → verify OIDC → base64-decode →
 *       handleLlmCallEvent (validates, UPSERTs rollup, evaluates threshold) → 200.
 *
 * Per `feedback_oidc_audience_smoke_test_required` (KAN-731 lesson): mocked
 * OIDC verify in unit tests cannot catch audience mismatch. Real-delivery
 * smoke before declaring wired is mandatory — see KAN-745 PR B's pre-Done
 * gate in the closure.
 *
 * Error policy:
 *   - 200 (ack) on malformed envelope / invalid event / DB failure (per
 *     handleLlmCallEvent's never-throw posture; structured-log captures the
 *     incident for ops). Avoids redelivery storms.
 *   - 401 on missing/invalid OIDC token
 *   - 500 on top-level handler crashes (shouldn't happen — handleLlmCallEvent
 *     catches everything)
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { OAuth2Client } from 'google-auth-library';
import { prisma } from '../prisma.js';

// Variable-specifier dynamic import keeps the aggregator out of the
// apps/api static graph (TS6059 cohort hygiene). Manually-declared types
// per the established pattern.
interface AggregatorModule {
  handleLlmCallEvent: (
    prisma: unknown,
    raw: unknown,
  ) => Promise<{ ok: boolean; reason?: string }>;
}
let _aggregatorModule: AggregatorModule | null = null;
async function loadAggregatorModule(): Promise<AggregatorModule> {
  if (_aggregatorModule) return _aggregatorModule;
  const spec = '../../../../packages/api/src/services/observability/llm-cost-aggregator.js';
  _aggregatorModule = (await import(spec)) as AggregatorModule;
  return _aggregatorModule;
}

export const llmCallPushApp = new Hono();

const oauth = new OAuth2Client();
const PushEnvelopeSchema = z.object({
  message: z.object({
    data: z.string(),
    attributes: z.record(z.string()).optional(),
    messageId: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

async function verifyOidc(authHeader: string | undefined, audience: string): Promise<boolean> {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const token = authHeader.slice('Bearer '.length);
  try {
    const ticket = await oauth.verifyIdToken({ idToken: token, audience });
    return !!ticket.getPayload();
  } catch {
    return false;
  }
}

llmCallPushApp.post('/llm-call', async (c) => {
  const skipAuth = process.env.NODE_ENV === 'test' || process.env.PUBSUB_PUSH_SKIP_AUTH === 'true';
  if (!skipAuth) {
    // Per-subscriber audience env var per the KAN-741 pattern (mirrors
    // KNOWLEDGE_INGEST_AUDIENCE in knowledge-ingest-push.ts:114). The
    // initial KAN-745 PR B shipped against APP_API_URL which is
    // action-decided's audience — semantically wrong for llm-call.
    // Subscription audience: https://growth-api-biut5gfhuq-uc.a.run.app/pubsub/llm-call
    // KAN-732 (canonical request-URL-derived audience) eliminates this class
    // structurally; until then, per-subscriber env var is the workaround.
    const audience = process.env.LLM_CALL_AUDIENCE;
    if (!audience) {
      console.error('[llm-call-push] LLM_CALL_AUDIENCE unset — rejecting');
      return c.text('server misconfigured', 500);
    }
    const ok = await verifyOidc(c.req.header('authorization'), audience);
    if (!ok) return c.text('unauthorized', 401);
  }

  let envelope: z.infer<typeof PushEnvelopeSchema>;
  try {
    envelope = PushEnvelopeSchema.parse(await c.req.json());
  } catch (err) {
    console.error('[llm-call-push] malformed envelope', err);
    return c.text('ok', 200);
  }

  let raw: unknown;
  try {
    const decoded = Buffer.from(envelope.message.data, 'base64').toString('utf8');
    raw = JSON.parse(decoded);
  } catch (err) {
    console.error('[llm-call-push] malformed llm.call payload (base64/json)', err);
    return c.text('ok', 200);
  }

  // handleLlmCallEvent validates, UPSERTs, evaluates threshold; never throws.
  const { handleLlmCallEvent } = await loadAggregatorModule();
  const result = await handleLlmCallEvent(prisma, raw);
  if (!result.ok) {
    // Reason is logged by the handler; ack to avoid redelivery storms on
    // malformed events. DB errors are also ack'd — operator should see the
    // structured-error log + investigate; redelivery won't help if the DB
    // is down across multiple retries.
    return c.text('ok', 200);
  }
  return c.text('ok', 200);
});
