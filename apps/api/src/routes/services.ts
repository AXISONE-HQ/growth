/**
 * KAN-XXX — Services REST API.
 *
 * `GET    /api/knowledge/services`        — list non-deleted entries (newest first)
 * `GET    /api/knowledge/services/:id`    — fetch one (404 on missing or cross-tenant)
 * `POST   /api/knowledge/services`        — create (sync embed; returns terminal status)
 * `PUT    /api/knowledge/services/:id`    — update (re-embeds)
 * `DELETE /api/knowledge/services/:id`    — soft-delete
 *
 * Auth: identical to faq-entries.ts and knowledge-sources.ts — Firebase
 * Bearer + x-tenant-id header. Mounted at /api/knowledge by
 * apps/api/src/index.ts so the effective paths share the knowledge namespace.
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

export const servicesApp = new Hono();

// ─────────────────────────────────────────────
// Auth middleware (mirrors faq-entries.ts)
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

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2_000;
const PRICE_LABEL_MAX = 200;
const ITEM_MAX = 500;
const MAX_ITEMS = 50;

const PriceUnitEnum = z.enum([
  "PER_HOUR",
  "PER_MONTH",
  "PER_PROJECT",
  "PER_UNIT",
  "FIXED",
  "CUSTOM",
]);

// YYYY-MM-DD ISO date string. Coerced to Date in the route handler.
const IsoDateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD");

const ItemArraySchema = z
  .array(z.string().max(ITEM_MAX))
  .max(MAX_ITEMS)
  .optional();

const CreateBodySchema = z.object({
  title: z.string().min(1).max(TITLE_MAX),
  description: z.string().min(1).max(DESCRIPTION_MAX),
  price: z.number().nonnegative().nullable().optional(),
  priceUnit: PriceUnitEnum,
  priceCustomLabel: z.string().max(PRICE_LABEL_MAX).nullable().optional(),
  startDate: IsoDateString.nullable().optional(),
  endDate: IsoDateString.nullable().optional(),
  includedItems: ItemArraySchema,
  excludedItems: ItemArraySchema,
});

const UpdateBodySchema = z
  .object({
    title: z.string().min(1).max(TITLE_MAX).optional(),
    description: z.string().min(1).max(DESCRIPTION_MAX).optional(),
    price: z.number().nonnegative().nullable().optional(),
    priceUnit: PriceUnitEnum.optional(),
    priceCustomLabel: z.string().max(PRICE_LABEL_MAX).nullable().optional(),
    startDate: IsoDateString.nullable().optional(),
    endDate: IsoDateString.nullable().optional(),
    includedItems: ItemArraySchema,
    excludedItems: ItemArraySchema,
  })
  .refine(
    (b) => Object.keys(b).length > 0,
    { message: "At least one field is required" },
  );

// ─────────────────────────────────────────────
// Service binding via variable-specifier dynamic import
// (cross-rootDir hygiene per `reference_variable_specifier_dynamic_import`).
// ─────────────────────────────────────────────

interface ServicesService {
  listServices: (
    prisma: unknown,
    tenantId: string,
    opts?: { offset?: number; limit?: number },
  ) => Promise<unknown[]>;
  getService: (
    prisma: unknown,
    tenantId: string,
    id: string,
  ) => Promise<unknown | null>;
  createService: (
    prisma: unknown,
    tenantId: string,
    input: Record<string, unknown>,
  ) => Promise<{ id: string; status: string; errorDetail: string | null } & Record<string, unknown>>;
  updateService: (
    prisma: unknown,
    tenantId: string,
    id: string,
    input: Record<string, unknown>,
  ) => Promise<({ id: string; status: string; errorDetail: string | null } & Record<string, unknown>) | null>;
  deleteService: (
    prisma: unknown,
    tenantId: string,
    id: string,
  ) => Promise<boolean>;
  ServiceValidationError: typeof Error;
}

async function getService(): Promise<ServicesService> {
  const spec = "../../../../packages/api/src/services/services.js";
  return (await import(spec)) as unknown as ServicesService;
}

// ─────────────────────────────────────────────
// Body coercion — convert ISO date strings to Date, normalize the input
// shape into what the service module expects.
// ─────────────────────────────────────────────

function coerceCreate(body: z.infer<typeof CreateBodySchema>): Record<string, unknown> {
  return {
    title: body.title,
    description: body.description,
    price: body.price ?? null,
    priceUnit: body.priceUnit,
    priceCustomLabel: body.priceCustomLabel ?? null,
    startDate: body.startDate ? new Date(body.startDate) : null,
    endDate: body.endDate ? new Date(body.endDate) : null,
    includedItems: body.includedItems ?? [],
    excludedItems: body.excludedItems ?? [],
  };
}

function coerceUpdate(body: z.infer<typeof UpdateBodySchema>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (body.title !== undefined) out.title = body.title;
  if (body.description !== undefined) out.description = body.description;
  if (body.price !== undefined) out.price = body.price;
  if (body.priceUnit !== undefined) out.priceUnit = body.priceUnit;
  if (body.priceCustomLabel !== undefined) out.priceCustomLabel = body.priceCustomLabel;
  if (body.startDate !== undefined) {
    out.startDate = body.startDate ? new Date(body.startDate) : null;
  }
  if (body.endDate !== undefined) {
    out.endDate = body.endDate ? new Date(body.endDate) : null;
  }
  if (body.includedItems !== undefined) out.includedItems = body.includedItems;
  if (body.excludedItems !== undefined) out.excludedItems = body.excludedItems;
  return out;
}

// ─────────────────────────────────────────────
// Audit emit (best-effort)
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
        `[services] audit-emit-failed action=${actionType} err=${(err as Error)?.message ?? String(err)}`,
      );
    });
}

// ─────────────────────────────────────────────
// GET /services
// ─────────────────────────────────────────────

servicesApp.get("/services", async (c) => {
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
  const services = await svc.listServices(prisma, tenantId, { offset, limit });
  return c.json({ services });
});

// ─────────────────────────────────────────────
// GET /services/:id
// ─────────────────────────────────────────────

servicesApp.get("/services/:id", async (c) => {
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
  const entry = await svc.getService(prisma, tenantId, id);
  if (!entry) {
    return c.json({ error: "Service not found" }, 404);
  }
  return c.json({ service: entry });
});

// ─────────────────────────────────────────────
// POST /services
// ─────────────────────────────────────────────

servicesApp.post("/services", async (c) => {
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
    const entry = await svc.createService(prisma, tenantId, coerceCreate(parsed.data));
    emitAudit(tenantId, uid, "knowledge.service_created", {
      serviceId: entry.id,
      status: entry.status,
    });
    return c.json({ service: entry }, 201);
  } catch (err) {
    if (
      (err as Error)?.name === "ServiceValidationError" ||
      err instanceof svc.ServiceValidationError
    ) {
      return c.json({ error: (err as Error).message }, 400);
    }
    console.error(
      `[services] create failed tenantId=${tenantId} err=${(err as Error)?.message ?? String(err)}`,
    );
    return c.json({ error: "Failed to create service" }, 500);
  }
});

// ─────────────────────────────────────────────
// PUT /services/:id
// ─────────────────────────────────────────────

servicesApp.put("/services/:id", async (c) => {
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
    const entry = await svc.updateService(
      prisma,
      tenantId,
      id,
      coerceUpdate(parsed.data),
    );
    if (!entry) {
      return c.json({ error: "Service not found" }, 404);
    }
    emitAudit(tenantId, uid, "knowledge.service_updated", {
      serviceId: entry.id,
      status: entry.status,
    });
    return c.json({ service: entry });
  } catch (err) {
    if (
      (err as Error)?.name === "ServiceValidationError" ||
      err instanceof svc.ServiceValidationError
    ) {
      return c.json({ error: (err as Error).message }, 400);
    }
    console.error(
      `[services] update failed id=${id} tenantId=${tenantId} err=${(err as Error)?.message ?? String(err)}`,
    );
    return c.json({ error: "Failed to update service" }, 500);
  }
});

// ─────────────────────────────────────────────
// DELETE /services/:id
// ─────────────────────────────────────────────

servicesApp.delete("/services/:id", async (c) => {
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
  const ok = await svc.deleteService(prisma, tenantId, id);
  if (!ok) {
    return c.json({ error: "Service not found" }, 404);
  }
  emitAudit(tenantId, uid, "knowledge.service_deleted", { serviceId: id });
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
