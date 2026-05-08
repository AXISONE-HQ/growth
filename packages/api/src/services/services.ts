/**
 * KAN-XXX — Services service.
 *
 * Services as first-class entities (their own table; parallel to FaqEntry
 * from KAN-849). Each entry produces exactly one KnowledgeChunk linked via
 * the polymorphic `serviceId` parent FK; the embedder runs SYNCHRONOUSLY
 * on create/update so the operator gets a deterministic ready state on POST.
 *
 * **Synchronous embedding rationale:**
 * Service rows are short (title + description + bullet items, all under one
 * 500-token chunk in practice). Single embed() call ≈ 150-300ms. Sync flow
 * gives the admin UI a deterministic "ready" status without polling.
 *
 * **XOR parent invariant:**
 * KnowledgeChunk has `(source_id, faq_entry_id, service_id) IS NOT NULL = 1`
 * as a DB-layer CHECK constraint. This service only writes chunks with
 * `service_id=<id>`, others NULL. Sibling writes in faq-entries.ts and
 * knowledge-ingestion-service.ts only ever populate the inverse sides.
 *
 * **Tenant safety:** every read/write filters explicitly on `tenantId`;
 * Prisma middleware in `packages/db/src/middleware/tenant.ts` provides
 * defense-in-depth on the typed-client paths. $executeRaw paths bind the
 * tenant ID via parameterized $N substitution (no string concat).
 */
import type { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { embed, EmbeddingFailedError } from "./knowledge-embedder.js";

// ─────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────

export type ServicePriceUnit =
  | "PER_HOUR"
  | "PER_MONTH"
  | "PER_PROJECT"
  | "PER_UNIT"
  | "FIXED"
  | "CUSTOM";

export interface ServiceRow {
  id: string;
  tenantId: string;
  title: string;
  description: string;
  /** Numeric value when priceUnit ≠ CUSTOM; null when priceUnit=CUSTOM. */
  price: number | null;
  priceUnit: ServicePriceUnit;
  /** Required iff priceUnit=CUSTOM. */
  priceCustomLabel: string | null;
  /** Availability window — both nullable (Ongoing when both null). */
  startDate: Date | null;
  endDate: Date | null;
  includedItems: string[];
  excludedItems: string[];
  status: "queued" | "embedding" | "ready" | "error";
  errorDetail: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListServicesOptions {
  /** Skip count (pagination). Default 0. */
  offset?: number;
  /** Page size. Default 50, capped at 200. */
  limit?: number;
}

export interface CreateServiceInput {
  title: string;
  description: string;
  price: number | null;
  priceUnit: ServicePriceUnit;
  priceCustomLabel?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  includedItems?: string[];
  excludedItems?: string[];
}

export interface UpdateServiceInput {
  title?: string;
  description?: string;
  price?: number | null;
  priceUnit?: ServicePriceUnit;
  priceCustomLabel?: string | null;
  startDate?: Date | null;
  endDate?: Date | null;
  includedItems?: string[];
  excludedItems?: string[];
}

// ─────────────────────────────────────────────
// Cast-loose Prisma access — same posture as faq-entries.ts
// ─────────────────────────────────────────────

interface ServiceDelegate {
  findMany: (args: {
    where: Record<string, unknown>;
    orderBy: Record<string, unknown>;
    skip?: number;
    take?: number;
  }) => Promise<ServiceRow[]>;
  findFirst: (args: {
    where: Record<string, unknown>;
  }) => Promise<ServiceRow | null>;
  create: (args: { data: Record<string, unknown> }) => Promise<ServiceRow>;
  update: (args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }) => Promise<ServiceRow>;
  count: (args: { where: Record<string, unknown> }) => Promise<number>;
}

interface KnowledgeChunkDelegate {
  deleteMany: (args: {
    where: { serviceId: string };
  }) => Promise<{ count: number }>;
}

function delegates(prisma: PrismaClient): {
  service: ServiceDelegate;
  chunk: KnowledgeChunkDelegate;
} {
  const cast = prisma as unknown as {
    service: ServiceDelegate;
    knowledgeChunk: KnowledgeChunkDelegate;
  };
  return { service: cast.service, chunk: cast.knowledgeChunk };
}

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const TITLE_MAX_CHARS = 200;
const DESCRIPTION_MAX_CHARS = 2_000;
const PRICE_LABEL_MAX_CHARS = 200;
const ITEM_MAX_CHARS = 500;
const MAX_ITEMS_PER_LIST = 50;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 200;

const PRICE_UNIT_VALUES: ServicePriceUnit[] = [
  "PER_HOUR",
  "PER_MONTH",
  "PER_PROJECT",
  "PER_UNIT",
  "FIXED",
  "CUSTOM",
];

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

export async function listServices(
  prisma: PrismaClient,
  tenantId: string,
  options: ListServicesOptions = {},
): Promise<ServiceRow[]> {
  const { service } = delegates(prisma);
  const limit = Math.min(options.limit ?? DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
  return service.findMany({
    where: { tenantId, deletedAt: null },
    orderBy: { createdAt: "desc" },
    skip: options.offset ?? 0,
    take: limit,
  });
}

export async function getService(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<ServiceRow | null> {
  const { service } = delegates(prisma);
  return service.findFirst({
    where: { id, tenantId, deletedAt: null },
  });
}

export async function createService(
  prisma: PrismaClient,
  tenantId: string,
  input: CreateServiceInput,
): Promise<ServiceRow> {
  const normalized = normalizeAndValidate(input);

  const { service } = delegates(prisma);
  const row = await service.create({
    data: {
      tenantId,
      title: normalized.title,
      description: normalized.description,
      price: normalized.price,
      priceUnit: normalized.priceUnit,
      priceCustomLabel: normalized.priceCustomLabel,
      startDate: normalized.startDate,
      endDate: normalized.endDate,
      includedItems: normalized.includedItems,
      excludedItems: normalized.excludedItems,
      status: "queued",
    },
  });

  return embedAndFinalize(prisma, row);
}

export async function updateService(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
  input: UpdateServiceInput,
): Promise<ServiceRow | null> {
  const existing = await getService(prisma, tenantId, id);
  if (!existing) return null;

  const merged: CreateServiceInput = {
    title: input.title ?? existing.title,
    description: input.description ?? existing.description,
    price: input.price === undefined ? existing.price : input.price,
    priceUnit: input.priceUnit ?? existing.priceUnit,
    priceCustomLabel:
      input.priceCustomLabel === undefined
        ? existing.priceCustomLabel
        : input.priceCustomLabel,
    startDate: input.startDate === undefined ? existing.startDate : input.startDate,
    endDate: input.endDate === undefined ? existing.endDate : input.endDate,
    includedItems: input.includedItems ?? existing.includedItems,
    excludedItems: input.excludedItems ?? existing.excludedItems,
  };
  const normalized = normalizeAndValidate(merged);

  // No-op short-circuit: if nothing changed (after normalization), skip the
  // re-embed round-trip.
  if (rowsEqual(existing, normalized)) {
    return existing;
  }

  const { service } = delegates(prisma);
  const updated = await service.update({
    where: { id },
    data: {
      title: normalized.title,
      description: normalized.description,
      price: normalized.price,
      priceUnit: normalized.priceUnit,
      priceCustomLabel: normalized.priceCustomLabel,
      startDate: normalized.startDate,
      endDate: normalized.endDate,
      includedItems: normalized.includedItems,
      excludedItems: normalized.excludedItems,
      status: "queued",
      errorDetail: null,
    },
  });

  return embedAndFinalize(prisma, updated);
}

export async function deleteService(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
): Promise<boolean> {
  const existing = await getService(prisma, tenantId, id);
  if (!existing) return false;

  const { service } = delegates(prisma);
  await service.update({
    where: { id },
    data: { deletedAt: new Date() },
  });
  return true;
}

// ─────────────────────────────────────────────
// Validation + normalization
// ─────────────────────────────────────────────

interface NormalizedService {
  title: string;
  description: string;
  price: number | null;
  priceUnit: ServicePriceUnit;
  priceCustomLabel: string | null;
  startDate: Date | null;
  endDate: Date | null;
  includedItems: string[];
  excludedItems: string[];
}

function normalizeAndValidate(input: CreateServiceInput): NormalizedService {
  const title = input.title.trim();
  const description = input.description.trim();

  if (!title) throw new ServiceValidationError("Title is required.");
  if (title.length > TITLE_MAX_CHARS) {
    throw new ServiceValidationError(
      `Title is too long (max ${TITLE_MAX_CHARS} chars).`,
    );
  }
  if (!description) throw new ServiceValidationError("Description is required.");
  if (description.length > DESCRIPTION_MAX_CHARS) {
    throw new ServiceValidationError(
      `Description is too long (max ${DESCRIPTION_MAX_CHARS.toLocaleString()} chars).`,
    );
  }

  if (!PRICE_UNIT_VALUES.includes(input.priceUnit)) {
    throw new ServiceValidationError(
      `priceUnit must be one of ${PRICE_UNIT_VALUES.join(", ")}.`,
    );
  }

  // Pricing constraint: CUSTOM requires priceCustomLabel + nullable price;
  // every other unit requires numeric price + null priceCustomLabel.
  let price: number | null = null;
  let priceCustomLabel: string | null = null;
  if (input.priceUnit === "CUSTOM") {
    const label = (input.priceCustomLabel ?? "").trim();
    if (!label) {
      throw new ServiceValidationError(
        "priceCustomLabel is required when priceUnit is CUSTOM.",
      );
    }
    if (label.length > PRICE_LABEL_MAX_CHARS) {
      throw new ServiceValidationError(
        `priceCustomLabel is too long (max ${PRICE_LABEL_MAX_CHARS} chars).`,
      );
    }
    priceCustomLabel = label;
    price = null;
  } else {
    if (input.price === null || input.price === undefined) {
      throw new ServiceValidationError(
        "price is required when priceUnit is not CUSTOM.",
      );
    }
    if (!Number.isFinite(input.price) || input.price < 0) {
      throw new ServiceValidationError("price must be a non-negative number.");
    }
    price = roundCents(input.price);
    priceCustomLabel = null;
  }

  // Date window: both nullable (Ongoing); when both set, end must not
  // precede start. App layer doesn't validate "in the past" — services
  // can be retroactively documented for historical context.
  const startDate = input.startDate ?? null;
  const endDate = input.endDate ?? null;
  if (startDate && endDate && endDate.getTime() < startDate.getTime()) {
    throw new ServiceValidationError("endDate cannot precede startDate.");
  }

  // Bullet arrays: trim each entry, drop blanks, cap count + per-item length.
  const includedItems = sanitizeItems(input.includedItems ?? [], "includedItems");
  const excludedItems = sanitizeItems(input.excludedItems ?? [], "excludedItems");

  return {
    title,
    description,
    price,
    priceUnit: input.priceUnit,
    priceCustomLabel,
    startDate,
    endDate,
    includedItems,
    excludedItems,
  };
}

function sanitizeItems(items: string[], fieldName: string): string[] {
  const cleaned = items.map((s) => s.trim()).filter((s) => s.length > 0);
  if (cleaned.length > MAX_ITEMS_PER_LIST) {
    throw new ServiceValidationError(
      `${fieldName} has too many entries (max ${MAX_ITEMS_PER_LIST}).`,
    );
  }
  for (const item of cleaned) {
    if (item.length > ITEM_MAX_CHARS) {
      throw new ServiceValidationError(
        `${fieldName} entry too long (max ${ITEM_MAX_CHARS} chars per item).`,
      );
    }
  }
  return cleaned;
}

function roundCents(n: number): number {
  return Math.round(n * 100) / 100;
}

function rowsEqual(existing: ServiceRow, next: NormalizedService): boolean {
  return (
    existing.title === next.title &&
    existing.description === next.description &&
    numericEqual(existing.price, next.price) &&
    existing.priceUnit === next.priceUnit &&
    existing.priceCustomLabel === next.priceCustomLabel &&
    dateEqual(existing.startDate, next.startDate) &&
    dateEqual(existing.endDate, next.endDate) &&
    arraysEqual(existing.includedItems, next.includedItems) &&
    arraysEqual(existing.excludedItems, next.excludedItems)
  );
}

function numericEqual(a: number | null, b: number | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return roundCents(a) === roundCents(b);
}

function dateEqual(a: Date | null, b: Date | null): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  return a.getTime() === b.getTime();
}

function arraysEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export class ServiceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServiceValidationError";
  }
}

// ─────────────────────────────────────────────
// Embed text builder — locked format per cohort spec §3
// ─────────────────────────────────────────────

const PRICE_UNIT_LABELS: Record<ServicePriceUnit, string> = {
  PER_HOUR: "per hour",
  PER_MONTH: "per month",
  PER_PROJECT: "per project",
  PER_UNIT: "per unit",
  FIXED: "fixed price",
  CUSTOM: "", // handled by priceCustomLabel branch
};

/**
 * Render a Service into the embedding text body. Skips empty bullet
 * sections entirely (no orphan "What's included:" header). Exported for
 * the test suite to pin the exact format.
 */
export function buildServiceEmbedText(s: {
  title: string;
  description: string;
  price: number | null;
  priceUnit: ServicePriceUnit;
  priceCustomLabel: string | null;
  startDate: Date | null;
  endDate: Date | null;
  includedItems: string[];
  excludedItems: string[];
}): string {
  const parts: string[] = [];
  parts.push(`Service: ${s.title}`);
  parts.push("");
  parts.push(`Description: ${s.description}`);
  parts.push("");
  parts.push(`Pricing: ${formatPricing(s)}`);
  parts.push("");
  parts.push(`Availability: ${formatAvailability(s.startDate, s.endDate)}`);
  if (s.includedItems.length > 0) {
    parts.push("");
    parts.push("What's included:");
    for (const item of s.includedItems) parts.push(`- ${item}`);
  }
  if (s.excludedItems.length > 0) {
    parts.push("");
    parts.push("What's excluded:");
    for (const item of s.excludedItems) parts.push(`- ${item}`);
  }
  return parts.join("\n");
}

function formatPricing(s: {
  price: number | null;
  priceUnit: ServicePriceUnit;
  priceCustomLabel: string | null;
}): string {
  if (s.priceUnit === "CUSTOM") {
    return s.priceCustomLabel ?? "Contact for pricing";
  }
  const priceStr = s.price !== null ? `$${s.price.toFixed(2)}` : "(price not set)";
  return `${priceStr} ${PRICE_UNIT_LABELS[s.priceUnit]}`.trim();
}

function formatAvailability(startDate: Date | null, endDate: Date | null): string {
  if (!startDate && !endDate) return "Ongoing";
  const startStr = startDate ? toIsoDate(startDate) : "Open-ended start";
  const endStr = endDate ? toIsoDate(endDate) : "Open-ended end";
  return `${startStr} to ${endStr}`;
}

function toIsoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────
// Sync embed → chunk write → status finalize
// ─────────────────────────────────────────────

async function embedAndFinalize(
  prisma: PrismaClient,
  row: ServiceRow,
): Promise<ServiceRow> {
  const { service, chunk } = delegates(prisma);

  await service.update({
    where: { id: row.id },
    data: { status: "embedding" },
  });

  try {
    const embedText = buildServiceEmbedText(row);
    const embedded = await embed([
      { position: 0, text: embedText, tokenCount: 0 },
    ]);
    const vec = embedded[0]!.embedding;

    await prisma.$transaction(async (tx) => {
      const txCast = tx as unknown as PrismaClient;
      const txDelegates = delegates(txCast);
      await txDelegates.chunk.deleteMany({ where: { serviceId: row.id } });

      const chunkId = randomUUID();
      const embeddingLiteral = `[${vec.join(",")}]`;
      const metadataJson = JSON.stringify({ tokenCount: embedded[0]!.tokenCount });
      await txCast.$executeRaw`
        INSERT INTO knowledge_chunk (
          id, tenant_id, source_id, faq_entry_id, service_id, chunk_text, position, category,
          status, question_text, embedding, metadata, created_at
        ) VALUES (
          ${chunkId},
          ${row.tenantId},
          NULL,
          NULL,
          ${row.id},
          ${embedText},
          0,
          'service',
          'ready',
          NULL,
          ${embeddingLiteral}::vector(1536),
          ${metadataJson}::jsonb,
          NOW()
        )
      `;

      await txDelegates.service.update({
        where: { id: row.id },
        data: { status: "ready", errorDetail: null },
      });
    });

    return (await service.findFirst({ where: { id: row.id, tenantId: row.tenantId } }))!;
  } catch (err) {
    const reason =
      err instanceof EmbeddingFailedError
        ? `embedding-failed: ${err.message}`
        : (err as Error)?.message ?? String(err);
    await service.update({
      where: { id: row.id },
      data: {
        status: "error",
        errorDetail: reason.slice(0, 1000),
      },
    });
    void chunk.deleteMany({ where: { serviceId: row.id } });
    return (await service.findFirst({ where: { id: row.id, tenantId: row.tenantId } }))!;
  }
}
