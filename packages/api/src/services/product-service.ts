/**
 * KAN-1216b Product CRUD service — Slice 2 PR 1b of KAN-1212 epic.
 *
 * # M4 — soft_delete_archive_only_crud_discipline (canonical anchor)
 *
 * First CRUD anchor of the catalog arc. Establishes 4 disciplines that
 * sibling KAN-1216c (Variant) + KAN-1216d (Category) adopt verbatim:
 *
 * 1. **Archive is terminal.** `archiveProduct()` sets status='archived' +
 *    archivedAt=now(). NO unarchive procedure — reverse path deferred to
 *    KAN-1212 follow-up. Hard-delete intentionally absent; FK integrity
 *    + audit trail preservation are load-bearing.
 *
 * 2. **Archive does NOT cascade.** Product.variants stay live when their
 *    parent archives. Operator UI default filter (archivedAt IS NULL)
 *    handles visibility. Integration test asserts variant.archivedAt
 *    stays NULL post-parent-archive. (KAN-1214 schema doctrine.)
 *
 * 3. **Defensive boundary validation.** Zod parse runs at SERVICE entry
 *    (not router-only). Defends against tRPC bypass paths (future
 *    subscriber consumers, batch importers). Pattern is NEW discipline
 *    vs campaign-commit; siblings 1216c/d adopt.
 *
 * 4. **AuditLog hook contract.** `{ auditLog: { writeInTx } }` injected
 *    by router. actionType = `'product.{created|updated|archived}'`.
 *    Payload shape: full snapshot for create/archive; `{before, after}`
 *    delta for updates.
 *
 * Cross-refs: Memo 38 (archetype), Memo 44 (sub-cat 6 dispatch).
 * Substrate: KAN-1213 (Product), KAN-1214 (Variant), KAN-1215 (Category).
 * Sibling CRUD seeders: KAN-1216c (M1+M2), KAN-1216d (M3).
 *
 * # Module discipline
 *
 * Pure service module — Prisma + @growth/shared types only. No tRPC,
 * no Pub/Sub, no logger. Loaded via variable-specifier dynamic import
 * (KAN-689 cohort) from apps/api/src/router.ts. Hooks injected by caller.
 */
import { ProductSchema, PRODUCT_STATUSES, type Product } from "@growth/shared";
import { z } from "zod";

// ─────────────────────────────────────────────
// Hook contracts (injected by tRPC layer; mirrors campaign-commit:84-99)
// ─────────────────────────────────────────────

export interface AuditLogWriteInput {
  tenantId: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
  reasoning: string;
}

export interface AuditLogHook {
  /** Tx-aware write — receives the active TransactionClient so the audit
   *  row commits/rolls-back atomically with the product write. */
  writeInTx: (
    tx: unknown,
    input: AuditLogWriteInput,
  ) => Promise<{ id: string }>;
}

export interface ProductServiceHooks {
  auditLog: AuditLogHook;
}

// ─────────────────────────────────────────────
// Prisma surface (typed loosely — same posture as campaign-commit.ts)
// ─────────────────────────────────────────────

interface ProductPrismaTx {
  product: {
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    findFirst: (args: unknown) => Promise<unknown>;
  };
  auditLog: {
    create: (args: unknown) => Promise<{ id: string }>;
  };
}

interface ProductPrisma {
  $transaction: <T>(fn: (tx: ProductPrismaTx) => Promise<T>) => Promise<T>;
}

// ─────────────────────────────────────────────
// Input schemas (E3 — defensive boundary validation)
//
// Zod parse runs at service entry, not router-only. Defends against tRPC
// bypass paths (future subscriber consumers, batch importers).
// ─────────────────────────────────────────────

const PRODUCT_NAME_MAX = 255;
const PRODUCT_DESCRIPTION_MAX = 4000;
const CURRENCY_LENGTH = 3;

export const CreateProductInputSchema = z.object({
  name: z.string().min(1).max(PRODUCT_NAME_MAX),
  description: z.string().max(PRODUCT_DESCRIPTION_MAX).nullable().optional(),
  status: z.enum(PRODUCT_STATUSES).default("draft"),
  price: z.number().nullable().optional(),
  currency: z.string().length(CURRENCY_LENGTH).default("USD"),
  externalUrl: z.string().url().nullable().optional(),
  primaryImageUrl: z.string().url().nullable().optional(),
  customFields: z.record(z.unknown()).default({}),
});
export type CreateProductInput = z.infer<typeof CreateProductInputSchema>;

export const UpdateProductInputSchema = z.object({
  name: z.string().min(1).max(PRODUCT_NAME_MAX).optional(),
  description: z.string().max(PRODUCT_DESCRIPTION_MAX).nullable().optional(),
  status: z.enum(PRODUCT_STATUSES).optional(),
  price: z.number().nullable().optional(),
  currency: z.string().length(CURRENCY_LENGTH).optional(),
  externalUrl: z.string().url().nullable().optional(),
  primaryImageUrl: z.string().url().nullable().optional(),
  customFields: z.record(z.unknown()).optional(),
});
export type UpdateProductInput = z.infer<typeof UpdateProductInputSchema>;

// ─────────────────────────────────────────────
// createProduct — INSERT + AuditLog (atomic via $transaction)
// ─────────────────────────────────────────────

export interface CreateProductResult {
  product: Product;
  auditLogId: string;
}

export async function createProduct(
  prisma: ProductPrisma,
  tenantId: string,
  input: CreateProductInput,
  actor: string,
  hooks: ProductServiceHooks,
): Promise<CreateProductResult> {
  // M4 lock #3: defensive boundary validation at service entry.
  const parsed = CreateProductInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const product = (await tx.product.create({
      data: {
        tenantId,
        name: parsed.name,
        description: parsed.description ?? null,
        status: parsed.status,
        price: parsed.price ?? null,
        currency: parsed.currency,
        externalUrl: parsed.externalUrl ?? null,
        primaryImageUrl: parsed.primaryImageUrl ?? null,
        customFields: parsed.customFields,
      },
    })) as Product;

    // M4 lock #4: AuditLog hook — full snapshot for create.
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product.created",
      payload: { productId: product.id, snapshot: product as unknown as Record<string, unknown> },
      reasoning: `operator ${actor} created product ${product.name}`,
    });

    return { product, auditLogId: audit.id };
  });
}

// ─────────────────────────────────────────────
// updateProduct — partial UPDATE + AuditLog before/after delta
// ─────────────────────────────────────────────

export interface UpdateProductResult {
  product: Product;
  auditLogId: string;
}

export class ProductNotFoundError extends Error {
  constructor(public productId: string) {
    super(`Product not found: ${productId}`);
    this.name = "ProductNotFoundError";
  }
}

export class ArchivedProductMutationError extends Error {
  constructor(public productId: string) {
    super(`Cannot update archived product: ${productId}`);
    this.name = "ArchivedProductMutationError";
  }
}

export async function updateProduct(
  prisma: ProductPrisma,
  tenantId: string,
  productId: string,
  input: UpdateProductInput,
  actor: string,
  hooks: ProductServiceHooks,
): Promise<UpdateProductResult> {
  const parsed = UpdateProductInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const before = (await tx.product.findFirst({
      where: { id: productId, tenantId },
    })) as Product | null;
    if (!before) throw new ProductNotFoundError(productId);
    // M4 lock #1: archive is terminal — no resurrection via update.
    if (before.status === "archived") {
      throw new ArchivedProductMutationError(productId);
    }

    const after = (await tx.product.update({
      where: { id: productId },
      data: {
        ...(parsed.name !== undefined && { name: parsed.name }),
        ...(parsed.description !== undefined && {
          description: parsed.description,
        }),
        ...(parsed.status !== undefined && { status: parsed.status }),
        ...(parsed.price !== undefined && { price: parsed.price }),
        ...(parsed.currency !== undefined && { currency: parsed.currency }),
        ...(parsed.externalUrl !== undefined && {
          externalUrl: parsed.externalUrl,
        }),
        ...(parsed.primaryImageUrl !== undefined && {
          primaryImageUrl: parsed.primaryImageUrl,
        }),
        ...(parsed.customFields !== undefined && {
          customFields: parsed.customFields,
        }),
      },
    })) as Product;

    // M4 lock #4: AuditLog hook — delta {before, after} for updates.
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product.updated",
      payload: {
        productId,
        before: before as unknown as Record<string, unknown>,
        after: after as unknown as Record<string, unknown>,
      },
      reasoning: `operator ${actor} updated product ${after.name}`,
    });

    return { product: after, auditLogId: audit.id };
  });
}

// ─────────────────────────────────────────────
// archiveProduct — soft-delete via status='archived' + archivedAt=now()
// ─────────────────────────────────────────────

export interface ArchiveProductResult {
  product: Product;
  auditLogId: string;
  /** True if the product was already archived (idempotent re-archive). */
  alreadyArchived: boolean;
}

export async function archiveProduct(
  prisma: ProductPrisma,
  tenantId: string,
  productId: string,
  actor: string,
  hooks: ProductServiceHooks,
): Promise<ArchiveProductResult> {
  return prisma.$transaction(async (tx) => {
    const before = (await tx.product.findFirst({
      where: { id: productId, tenantId },
    })) as Product | null;
    if (!before) throw new ProductNotFoundError(productId);

    // M4 lock #1: archive is idempotent — return existing state on re-archive
    // without logging a duplicate audit row.
    if (before.status === "archived") {
      return { product: before, auditLogId: "", alreadyArchived: true };
    }

    const now = new Date();
    const after = (await tx.product.update({
      where: { id: productId },
      data: {
        status: "archived",
        archivedAt: now,
      },
    })) as Product;

    // M4 lock #2: NO cascade to variants. Variants stay live; operator UI
    // filters via WHERE archivedAt IS NULL. Integration test asserts
    // variant.archivedAt stays NULL after parent archive.
    //
    // M4 lock #4: AuditLog hook — full snapshot for archive.
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product.archived",
      payload: { productId, archivedAt: now.toISOString() },
      reasoning: `operator ${actor} archived product ${after.name}`,
    });

    return { product: after, auditLogId: audit.id, alreadyArchived: false };
  });
}
