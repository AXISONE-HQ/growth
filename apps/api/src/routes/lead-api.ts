/**
 * KAN-742 — POST /api/v1/leads — public Lead API endpoint.
 *
 * Authenticates via X-AxisOne-API-Key header. Optional dedup via
 * X-AxisOne-Idempotency-Key. Per-tenant rate limit (1000 req/min default).
 * On accept: upsert Contact + emit lead.received event (same shape as
 * KAN-741 inbox source — using @growth/shared LeadReceivedEvent for
 * drift safety from day 1).
 *
 * Versioned route at /api/v1/leads — future breaking changes ship as v2
 * without disturbing existing integrations.
 */
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { PubSub } from "@google-cloud/pubsub";
import {
  LEAD_RECEIVED_TOPIC,
  buildLeadReceivedEvent,
  type LeadReceivedEvent,
} from "@growth/shared";
import { prisma } from "../prisma.js";
import {
  verifyApiKey,
  touchLastUsedAt,
  type AuthenticatedApiKey,
} from "../services/api-key-auth.js";
import { checkRateLimit } from "../services/api-rate-limit.js";
import { claimIdempotencyKey, recordIdempotencyResult } from "../services/api-idempotency.js";

// KAN-1141 PR 0 — Normalizer module loaded via the cross-rootDir variable-
// specifier loader pattern (KAN-689 era). Type-mirror declared locally so
// apps/api tsc doesn't pull packages/api/src into its rootDir.
interface NormalizerLeadApiModule {
  normalizeInboundLeadApi: (
    tenantId: string,
    payload: {
      email: string;
      firstName?: string | null;
      lastName?: string | null;
      metadata?: Record<string, unknown>;
      apiKeyTag?: string | null;
    },
  ) => Promise<{
    source: string;
    extracted: {
      firstName: string | null;
      lastName: string | null;
      companyName: string | null;
      phone: string | null;
      intentSummary: string | null;
      qualificationSignals: string[];
    };
    extractionConfidence: 'high' | 'medium' | 'low';
    extractionError: string | null;
  }>;
}
let _normalizerModule: NormalizerLeadApiModule | null = null;
async function loadNormalizerModule(): Promise<NormalizerLeadApiModule> {
  if (_normalizerModule) return _normalizerModule;
  const spec = '../../../../packages/api/src/services/lead-normalizer.js';
  _normalizerModule = (await import(spec)) as NormalizerLeadApiModule;
  return _normalizerModule;
}

/** Test seam — inject mock normalizer. */
export function __setNormalizerForTest(mod: NormalizerLeadApiModule | null): void {
  _normalizerModule = mod;
}

/**
 * KAN-1141 PR 0 Q5(a) FIX — Flatten arbitrary caller `metadata` (Record<string, unknown>)
 * into the wire schema's `customFields: Record<string, string>` shape. Per-value
 * stringify: string values pass through; everything else gets JSON.stringify'd.
 *
 * Pre-PR-0: this flattening did not exist. The route published `metadata.customerMetadata`
 * (which is NOT a wire-schema field), and Zod's default .strip() silently dropped it
 * during buildLeadReceivedEvent's parse step. Net effect: every PROD Lead-API caller's
 * metadata payload was lost on the wire since KAN-742 shipped. PR 0 closes the bug.
 */
export function flattenMetadataToCustomFields(
  metadata: Record<string, unknown> | undefined,
): Record<string, string> | undefined {
  if (!metadata) return undefined;
  const entries = Object.entries(metadata).map(([k, v]) => [
    k,
    typeof v === 'string' ? v : JSON.stringify(v),
  ] as const);
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries);
}

export const leadApiApp = new Hono();

const LeadInputSchema = z.object({
  email: z.string().email(),
  firstName: z.string().max(100).optional(),
  lastName: z.string().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});

let _pubsub: PubSub | null = null;
function getPubSubClient(): PubSub {
  if (!_pubsub) {
    _pubsub = new PubSub({
      projectId: process.env.GCP_PROJECT_ID,
      ...(process.env.PUBSUB_EMULATOR_HOST ? { apiEndpoint: process.env.PUBSUB_EMULATOR_HOST } : {}),
    });
  }
  return _pubsub;
}

// ─────────────────────────────────────────────
// Test seam — inject mock publisher
// ─────────────────────────────────────────────

let _publishLeadReceived: ((event: LeadReceivedEvent) => Promise<string>) | null = null;

export function __setLeadPublisherForTest(fn: ((event: LeadReceivedEvent) => Promise<string>) | null): void {
  _publishLeadReceived = fn;
}

async function publishLeadReceived(event: LeadReceivedEvent): Promise<string> {
  if (_publishLeadReceived) return _publishLeadReceived(event);
  const data = Buffer.from(JSON.stringify(event));
  return getPubSubClient().topic(LEAD_RECEIVED_TOPIC).publishMessage({
    data,
    attributes: {
      eventType: event.eventType,
      tenantId: event.tenantId,
      contactId: event.contactId,
      source: event.source,
      version: event.version,
    },
  });
}

// ─────────────────────────────────────────────
// POST /api/v1/leads
// ─────────────────────────────────────────────

leadApiApp.post("/", async (c) => {
  // ── 1. API key auth
  const apiKey = c.req.header("x-axisone-api-key") ?? c.req.header("X-AxisOne-API-Key");
  if (!apiKey) {
    return c.json({ error: "Missing X-AxisOne-API-Key header" }, 401);
  }
  const auth = await verifyApiKey(apiKey);
  if (!auth) {
    // Neutral message — never reveals whether the prefix matched or hash failed
    return c.json({ error: "Invalid API key" }, 401);
  }
  // Fire-and-forget lastUsedAt update
  touchLastUsedAt(auth.apiKeyId);

  // ── 2. Rate limit (per-tenant)
  const rateLimit = await checkRateLimit(auth.tenantId);
  c.header("X-RateLimit-Limit", String(rateLimit.limit));
  c.header("X-RateLimit-Remaining", String(rateLimit.remaining));
  c.header("X-RateLimit-Reset", String(rateLimit.resetAt));
  if (!rateLimit.allowed) {
    return c.json(
      { error: "rate_limit_exceeded", resetAt: rateLimit.resetAt, limit: rateLimit.limit },
      429,
    );
  }

  // ── 3. Body validation
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }
  const parsed = LeadInputSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.format() }, 400);
  }
  const { email, firstName, lastName, metadata } = parsed.data;

  // Defensive metadata size cap (10KB)
  if (metadata && JSON.stringify(metadata).length > 10 * 1024) {
    return c.json({ error: "metadata exceeds 10KB cap" }, 413);
  }

  // ── 4. Idempotency check
  const idempotencyKey = c.req.header("x-axisone-idempotency-key") ?? c.req.header("X-AxisOne-Idempotency-Key");
  if (idempotencyKey) {
    const claim = await claimIdempotencyKey(auth.tenantId, idempotencyKey);
    if (!claim.fresh) {
      if (claim.storedLeadId) {
        return c.json({ leadId: claim.storedLeadId, status: "duplicate" }, 200);
      }
      // PENDING — concurrent in-flight request
      return c.json({ error: "request in flight; retry shortly" }, 409);
    }
  }

  // ── 5. Upsert Contact
  let contactId: string;
  try {
    contactId = await upsertContact(auth, { email, firstName, lastName });
  } catch (err) {
    console.error("[lead-api] contact upsert failed:", err);
    return c.json({ error: "Failed to record lead" }, 500);
  }

  // ── 6. KAN-1141 PR 0 — Run the lead-normalizer for symmetry with the
  //    email path (KAN-742 V1 promise completion). Pure pre-parser; no LLM
  //    per Q3a(i). If the normalizer throws (unlikely — pure function),
  //    fall through with publish-raw posture per "AI is the operator,
  //    humans are escalation" doctrine.
  let normalizationFailure: string | null = null;
  try {
    const { normalizeInboundLeadApi } = await loadNormalizerModule();
    await normalizeInboundLeadApi(auth.tenantId, {
      email,
      firstName: firstName ?? null,
      lastName: lastName ?? null,
      metadata,
      apiKeyTag: auth.keyPrefix,
    });
  } catch (err) {
    // Defensive — pure pre-parser shouldn't throw. Log + continue with raw
    // event publish per locked failure-mode disposition (Q2).
    normalizationFailure = (err as Error)?.message ?? String(err);
    console.warn("[lead-api] normalizer threw (publishing raw event):", normalizationFailure);
  }

  // ── 7. Emit lead.received event (drift-safe via @growth/shared)
  //
  // KAN-1141 PR 0 Q5(a) FIX — caller metadata now flows via `customFields`
  // (the wire schema's canonical field for caller-supplied data, present
  // since KAN-741). Pre-PR-0 the route published `metadata.customerMetadata`
  // which is NOT a wire-schema field — Zod's default .strip() silently
  // dropped it. Latent bug: every PROD Lead-API caller's metadata has been
  // lost on the wire since KAN-742 shipped. PR 0 closes the gap. Per-value
  // stringify via `flattenMetadataToCustomFields` maps arbitrary JSON to
  // the wire schema's Record<string, string> shape losslessly.
  //
  // apiKeyTag = keyPrefix (already plaintext; the indexed lookup field).
  // Publishing keyPrefix lets downstream identify which key submitted each
  // lead — useful for forensic/audit. NEVER publishes the full plaintext key.
  const customFields = flattenMetadataToCustomFields(metadata);
  const event = buildLeadReceivedEvent({
    eventId: `evt_${randomUUID()}`,
    tenantId: auth.tenantId,
    contactId,
    source: "lead_api",
    metadata: {
      apiKeyTag: auth.keyPrefix,
      attachmentCount: 0,
      ...(customFields ? { customFields } : {}),
    },
  });
  try {
    await publishLeadReceived(event);
  } catch (err) {
    // Audit row + Contact persisted; publish failure logged. Idempotency
    // key still gets stored — replay returns the leadId, no double-publish.
    console.error("[lead-api] publish failed:", err);
  }

  // ── 7. Record idempotency result (best-effort)
  if (idempotencyKey) {
    await recordIdempotencyResult(auth.tenantId, idempotencyKey, contactId);
  }

  return c.json({ leadId: contactId, status: "accepted" }, 200);
});

async function upsertContact(
  auth: AuthenticatedApiKey,
  input: { email: string; firstName?: string; lastName?: string },
): Promise<string> {
  const existing = await prisma.contact.findFirst({
    where: { tenantId: auth.tenantId, email: input.email },
    select: { id: true },
  });
  if (existing) {
    await prisma.contact.update({
      where: { id: existing.id },
      data: { updatedAt: new Date() },
    });
    return existing.id;
  }
  const created = await prisma.contact.create({
    data: {
      tenantId: auth.tenantId,
      email: input.email,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      source: "lead_api",
      lifecycleStage: "lead",
    },
  });
  return created.id;
}
