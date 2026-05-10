/**
 * KAN-866 — Account Page Cohort 6: `account.field_updated` push
 * subscriber. Writes AuditLog rows from the wire-format event published
 * by `_applyAccountUpdate` per-changed-field.
 *
 * Mounted at POST `/internal/account-field-updated-subscriber`. Pub/Sub
 * push delivers with OIDC bearer (signed by `pubsub-invoker` SA per the
 * sibling Terraform PR `infra/terraform/account-field-updated.tf`).
 * `verifyPubsubOidc` validates the audience-derived URL match
 * generically (KAN-732 canonical helper).
 *
 * Pattern reuses the canonical Pub/Sub push subscriber shape:
 *   - 401 on missing/invalid OIDC
 *   - Extract envelope `message.data` (base64), decode, parse via Zod
 *   - Look up the AccountProfile.id from tenantId (the wire event
 *     doesn't carry the profile id; the audit payload contract requires
 *     `entityId`)
 *   - Build the audit payload via `buildAccountFieldUpdatedAuditPayload`
 *     (canonical helper from @growth/shared per
 *     `reference_account_audit_log_payload`)
 *   - Insert AuditLog row with `actionType = "account_field_updated"`
 *   - Return 204 (Pub/Sub treats 2xx as ack; non-2xx triggers retry)
 *
 * Idempotency: Pub/Sub at-least-once delivery means duplicate handlers
 * fire eventually. The audit log write is naturally idempotent if we
 * key on `eventId` (eventId is set by the publisher per event) — since
 * AuditLog has no unique constraint on a foreign key for that, we do a
 * SETNX-style claim on Redis before inserting (sibling to KAN-862's
 * detect-handler idempotency pattern).
 */
import { Hono } from "hono";
import { prisma } from "../prisma.js";
import { verifyPubsubOidc } from "../lib/oidc-pubsub-verify.js";
import { getRedisClient } from "../services/redis-client.js";
import {
  AccountFieldUpdatedEventSchema,
  buildAccountFieldUpdatedAuditPayload,
} from "@growth/shared";

export const accountFieldUpdatedSubscriberApp = new Hono();

/** 24h TTL — same as KAN-862 detect-handler idempotency. Covers any
 * realistic Pub/Sub redelivery window without unbounded growth. */
const IDEMP_KEY_TTL_SECONDS = 86400;

interface PubSubPushEnvelope {
  message?: {
    data?: string; // base64-encoded JSON
    messageId?: string;
    publishTime?: string;
  };
  subscription?: string;
}

function decodePubSubData(b64: string): unknown {
  try {
    return JSON.parse(Buffer.from(b64, "base64").toString("utf-8"));
  } catch {
    return null;
  }
}

accountFieldUpdatedSubscriberApp.post(
  "/internal/account-field-updated-subscriber",
  async (c) => {
    if (!(await verifyPubsubOidc(c))) {
      return c.text("unauthorized", 401);
    }

    const envelope = (await c.req.json().catch(() => null)) as PubSubPushEnvelope | null;
    if (!envelope?.message?.data) {
      return c.json({ error: "invalid_envelope" }, 400);
    }

    const decoded = decodePubSubData(envelope.message.data);
    const parsed = AccountFieldUpdatedEventSchema.safeParse(decoded);
    if (!parsed.success) {
      // Bad payload — ack with 200 so Pub/Sub stops retrying. Log loud
      // because this means the publisher schema drifted from the
      // subscriber.
      console.error(
        "[account-field-updated-subscriber] event failed schema parse:",
        parsed.error.message,
      );
      return c.json({ error: "invalid_payload", detail: parsed.error.message }, 200);
    }
    const event = parsed.data;

    // Idempotency claim on eventId — duplicate Pub/Sub redeliveries no-op.
    // Fail-open on Redis outage matches KAN-742 / KAN-862 posture.
    const idempKey = `idemp:account-field-updated:${event.eventId}`;
    let claimed = true;
    try {
      const result = await getRedisClient().set(
        idempKey,
        new Date().toISOString(),
        "EX",
        IDEMP_KEY_TTL_SECONDS,
        "NX",
      );
      claimed = result === "OK";
    } catch (err) {
      console.warn(
        "[account-field-updated-subscriber] Redis SETNX failed — fail-open:",
        err,
      );
    }
    if (!claimed) {
      console.log(
        `[account-field-updated-subscriber] duplicate eventId=${event.eventId} — no-op ack`,
      );
      return c.json({ ok: true, idempotent: true });
    }

    // Look up the AccountProfile.id for entityId. The wire event carries
    // tenantId only; audit payload requires the row id.
    const profile = (await (prisma as any).accountProfile?.findUnique({
      where: { tenantId: event.tenantId },
      select: { id: true },
    })) as { id: string } | null;
    if (!profile) {
      // Missing AccountProfile is a real bug — the publisher fired before
      // the row exists. Ack to stop retries; investigate via logs.
      console.error(
        `[account-field-updated-subscriber] no AccountProfile for tenant ${event.tenantId} — eventId=${event.eventId}`,
      );
      return c.json({ error: "no_account_profile", tenantId: event.tenantId }, 200);
    }

    // Build the canonical audit payload + insert. Note: detectionId is
    // not carried on the wire event (publisher doesn't know about
    // detection acceptance). When source='ai_detection', the upstream
    // `acceptDetection` mutation sets `userId=null` + we'd want
    // detectionId; pending a publisher-side enrichment, this lands as
    // null. KAN-866 follow-up if real audit consumers want detectionId
    // attribution at the field_updated subscriber level.
    const auditPayload = buildAccountFieldUpdatedAuditPayload({
      accountProfileId: profile.id,
      fieldPath: event.fieldPath,
      oldValue: event.oldValue,
      newValue: event.newValue,
      source: event.source,
      userId: event.userId ?? null,
      detectionId: null,
    });

    try {
      await (prisma as any).auditLog?.create({
        data: {
          tenantId: event.tenantId,
          actor:
            event.source === "ai_detection"
              ? "ai:account-detect"
              : event.userId
                ? `user:${event.userId}`
                : "system",
          actionType: "account_field_updated",
          payload: auditPayload as unknown as Record<string, unknown>,
        },
      });
    } catch (err) {
      // DB write failure — return 5xx so Pub/Sub retries.
      console.error(
        "[account-field-updated-subscriber] auditLog.create failed:",
        err,
      );
      return c.json({ error: "db_write_failed" }, 500);
    }

    return c.json({ ok: true, eventId: event.eventId, fieldPath: event.fieldPath });
  },
);
