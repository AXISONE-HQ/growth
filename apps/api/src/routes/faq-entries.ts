/**
 * KAN-XXX — FAQ entries REST API.
 *
 * `GET    /api/knowledge/faqs`        — list non-deleted entries (newest first)
 * `GET    /api/knowledge/faqs/:id`    — fetch one (404 on missing or cross-tenant probe)
 * `POST   /api/knowledge/faqs`        — create entry (sync embed; returns terminal status)
 * `PUT    /api/knowledge/faqs/:id`    — update question/answer (re-embeds)
 * `DELETE /api/knowledge/faqs/:id`    — soft-delete
 *
 * Auth: identical to knowledge-sources.ts — Firebase Bearer + x-tenant-id
 * header. Mounted at /api/knowledge by apps/api/src/index.ts so the
 * effective paths share the knowledge namespace.
 *
 * Mirrors the cast-loose Prisma + asAdminPrisma() pattern from
 * knowledge-sources.ts. The synchronous embedding in createFaqEntry /
 * updateFaqEntry adds ~200-500ms to the POST/PUT response — acceptable for
 * single-Q+A entries (well under one 500-token chunk).
 */
import { Hono } from "hono";
import { z } from "zod";
import { initializeApp, getApps, applicationDefault } from "firebase-admin/app";
import { getAuth, type Auth } from "firebase-admin/auth";
import { prisma } from "../prisma.js";

if (getApps().length === 0) {
  initializeApp({
    credential: applicationDefault(),
    projectId: process.env.FIREBASE_PROJECT_ID || "growth-493400",
  });
}
const firebaseAuth: Auth = getAuth();

export const faqEntriesApp = new Hono();

// ─────────────────────────────────────────────
// Auth middleware (mirrors knowledge-sources.ts)
// ─────────────────────────────────────────────

interface AuthContext {
  tenantId: string;
  uid: string;
}

async function authenticate(
  authHeader: string | undefined,
  tenantHeader: string | undefined,
): Promise<AuthContext | { error: string; status: 401 | 400 }> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { error: "Missing Authorization Bearer token", status: 401 };
  }
  if (!tenantHeader) {
    return { error: "Missing x-tenant-id header", status: 400 };
  }
  const token = authHeader.slice(7);
  try {
    const decoded = await firebaseAuth.verifyIdToken(token);
    return { tenantId: tenantHeader, uid: decoded.uid };
  } catch {
    return { error: "Invalid or expired Firebase ID token", status: 401 };
  }
}

// ─────────────────────────────────────────────
// Validation
// ─────────────────────────────────────────────

const QUESTION_MAX_CHARS = 2_000;
const ANSWER_MAX_CHARS = 10_000;

const CreateBodySchema = z.object({
  question: z.string().min(1).max(QUESTION_MAX_CHARS),
  answer: z.string().min(1).max(ANSWER_MAX_CHARS),
});

const UpdateBodySchema = z
  .object({
    question: z.string().min(1).max(QUESTION_MAX_CHARS).optional(),
    answer: z.string().min(1).max(ANSWER_MAX_CHARS).optional(),
  })
  .refine((b) => b.question !== undefined || b.answer !== undefined, {
    message: "At least one of `question` or `answer` is required",
  });

// ─────────────────────────────────────────────
// Service binding via variable-specifier dynamic import
// (KAN-689 cohort discipline; keeps the cross-rootDir module out of the
// apps/api static TS graph per `reference_variable_specifier_dynamic_import`).
// ─────────────────────────────────────────────

interface FaqEntriesService {
  listFaqEntries: (
    prisma: unknown,
    tenantId: string,
    opts?: { offset?: number; limit?: number },
  ) => Promise<Array<{
    id: string;
    tenantId: string;
    question: string;
    answer: string;
    status: string;
    errorDetail: string | null;
    createdAt: Date;
    updatedAt: Date;
  }>>;
  getFaqEntry: (
    prisma: unknown,
    tenantId: string,
    id: string,
  ) => Promise<{
    id: string;
    tenantId: string;
    question: string;
    answer: string;
    status: string;
    errorDetail: string | null;
    createdAt: Date;
    updatedAt: Date;
  } | null>;
  createFaqEntry: (
    prisma: unknown,
    tenantId: string,
    input: { question: string; answer: string },
  ) => Promise<{
    id: string;
    status: string;
    errorDetail: string | null;
  } & Record<string, unknown>>;
  updateFaqEntry: (
    prisma: unknown,
    tenantId: string,
    id: string,
    input: { question?: string; answer?: string },
  ) => Promise<{
    id: string;
    status: string;
    errorDetail: string | null;
  } & Record<string, unknown> | null>;
  deleteFaqEntry: (
    prisma: unknown,
    tenantId: string,
    id: string,
  ) => Promise<boolean>;
  FaqValidationError: typeof Error;
}

async function getService(): Promise<FaqEntriesService> {
  const spec = "../../../../packages/api/src/services/faq-entries.js";
  return (await import(spec)) as unknown as FaqEntriesService;
}

// ─────────────────────────────────────────────
// Audit log emit (best-effort, mirrors knowledge-sources.ts pattern)
// ─────────────────────────────────────────────

interface AuditDelegate {
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<{ id: string }>;
  };
}

function emitAudit(
  tenantId: string,
  uid: string,
  actionType: string,
  payload: Record<string, unknown>,
): void {
  void (prisma as unknown as AuditDelegate).auditLog
    .create({
      data: {
        tenantId,
        actor: "human_operator",
        actionType,
        payload: { ...payload, byUid: uid },
      },
    })
    .catch((err: unknown) => {
      console.warn(
        `[faq-entries] audit-emit-failed action=${actionType} err=${(err as Error)?.message ?? String(err)}`,
      );
    });
}

// ─────────────────────────────────────────────
// GET /faqs
// ─────────────────────────────────────────────

faqEntriesApp.get("/faqs", async (c) => {
  const auth = await authenticate(
    c.req.header("authorization"),
    c.req.header("x-tenant-id"),
  );
  if ("error" in auth) {
    return c.json({ error: auth.error }, auth.status);
  }
  const { tenantId } = auth;

  const offset = parseIntSafe(c.req.query("offset")) ?? 0;
  const limit = parseIntSafe(c.req.query("limit")) ?? 50;

  const svc = await getService();
  const entries = await svc.listFaqEntries(prisma, tenantId, { offset, limit });
  return c.json({ faqs: entries });
});

// ─────────────────────────────────────────────
// GET /faqs/:id
// ─────────────────────────────────────────────

faqEntriesApp.get("/faqs/:id", async (c) => {
  const auth = await authenticate(
    c.req.header("authorization"),
    c.req.header("x-tenant-id"),
  );
  if ("error" in auth) {
    return c.json({ error: auth.error }, auth.status);
  }
  const { tenantId } = auth;

  const id = c.req.param("id");
  const svc = await getService();
  const entry = await svc.getFaqEntry(prisma, tenantId, id);
  if (!entry) {
    return c.json({ error: "FAQ entry not found" }, 404);
  }
  return c.json({ faq: entry });
});

// ─────────────────────────────────────────────
// POST /faqs
// ─────────────────────────────────────────────

faqEntriesApp.post("/faqs", async (c) => {
  const auth = await authenticate(
    c.req.header("authorization"),
    c.req.header("x-tenant-id"),
  );
  if ("error" in auth) {
    return c.json({ error: auth.error }, auth.status);
  }
  const { tenantId, uid } = auth;

  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Malformed JSON body" }, 400);
  }
  const parsed = CreateBodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request body", details: parsed.error.issues },
      400,
    );
  }

  const svc = await getService();
  try {
    const entry = await svc.createFaqEntry(prisma, tenantId, parsed.data);
    emitAudit(tenantId, uid, "knowledge.faq_created", {
      faqEntryId: entry.id,
      status: entry.status,
    });
    // Status is terminal (ready or error) on return; both shapes use 201 for
    // the resource being created — the body carries the status so the client
    // can surface error details inline if needed.
    return c.json({ faq: entry }, 201);
  } catch (err) {
    if (
      (err as Error)?.name === "FaqValidationError" ||
      err instanceof svc.FaqValidationError
    ) {
      return c.json({ error: (err as Error).message }, 400);
    }
    console.error(`[faq-entries] create failed tenantId=${tenantId} err=${(err as Error)?.message ?? String(err)}`);
    return c.json({ error: "Failed to create FAQ entry" }, 500);
  }
});

// ─────────────────────────────────────────────
// PUT /faqs/:id
// ─────────────────────────────────────────────

faqEntriesApp.put("/faqs/:id", async (c) => {
  const auth = await authenticate(
    c.req.header("authorization"),
    c.req.header("x-tenant-id"),
  );
  if ("error" in auth) {
    return c.json({ error: auth.error }, auth.status);
  }
  const { tenantId, uid } = auth;

  const id = c.req.param("id");
  let json: unknown;
  try {
    json = await c.req.json();
  } catch {
    return c.json({ error: "Malformed JSON body" }, 400);
  }
  const parsed = UpdateBodySchema.safeParse(json);
  if (!parsed.success) {
    return c.json(
      { error: "Invalid request body", details: parsed.error.issues },
      400,
    );
  }

  const svc = await getService();
  try {
    const entry = await svc.updateFaqEntry(prisma, tenantId, id, parsed.data);
    if (!entry) {
      return c.json({ error: "FAQ entry not found" }, 404);
    }
    emitAudit(tenantId, uid, "knowledge.faq_updated", {
      faqEntryId: entry.id,
      status: entry.status,
    });
    return c.json({ faq: entry });
  } catch (err) {
    if (
      (err as Error)?.name === "FaqValidationError" ||
      err instanceof svc.FaqValidationError
    ) {
      return c.json({ error: (err as Error).message }, 400);
    }
    console.error(`[faq-entries] update failed id=${id} tenantId=${tenantId} err=${(err as Error)?.message ?? String(err)}`);
    return c.json({ error: "Failed to update FAQ entry" }, 500);
  }
});

// ─────────────────────────────────────────────
// DELETE /faqs/:id
// ─────────────────────────────────────────────

faqEntriesApp.delete("/faqs/:id", async (c) => {
  const auth = await authenticate(
    c.req.header("authorization"),
    c.req.header("x-tenant-id"),
  );
  if ("error" in auth) {
    return c.json({ error: auth.error }, auth.status);
  }
  const { tenantId, uid } = auth;

  const id = c.req.param("id");
  const svc = await getService();
  const ok = await svc.deleteFaqEntry(prisma, tenantId, id);
  if (!ok) {
    return c.json({ error: "FAQ entry not found" }, 404);
  }
  emitAudit(tenantId, uid, "knowledge.faq_deleted", { faqEntryId: id });
  return c.json({ id, status: "deleted" });
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function parseIntSafe(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}
