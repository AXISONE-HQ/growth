/**
 * KAN-1216c ProductVariant CRUD service — Slice 2 PR 1c of KAN-1212 epic.
 *
 * Sibling to product-service.ts (KAN-1216b) which establishes M4
 * (soft_delete_archive_only_crud_discipline). This module seeds TWO memos:
 * M1 (content-hash dedup) at the createVariant site + M2 (price-inheritance
 * runtime resolution) at the resolveEffectivePrice helper.
 *
 * # M1 — service_layer_content_hash_dedup_discipline (canonical anchor)
 *
 * Variants are differentiated by `attributes` JSON. Two variants with
 * identical attributes within the same Product MUST be deduplicated at
 * write time.
 *
 * ## Detection
 *
 * `createVariant()` computes `sha256(JSON.stringify(attributes)).slice(0, 16)`
 * matching 3 sibling-service precedents:
 *   - knowledge-retrieval-service.ts:146 — queryHash dedup
 *   - feasibility-context-service.ts:111 — hashGoalShape
 *   - message-shaper.ts:262 — sha256 collision detection
 *
 * Index: `(productId, attributesHash)` composite (schema:3753) supports
 * O(log N) findFirst lookup.
 *
 * ## Response — Path α (idempotent-return) LOCKED
 *
 * On hash HIT: return existing variant + `{ isDedup: true }` flag. SKIP
 * AuditLog write (no duplicate row). On hash MISS: INSERT + AuditLog
 * fires with `actionType: 'product_variant.created'`.
 *
 * Rationale: mirrors campaign-commit.ts:338-371 soft-window idempotency
 * (5-min window on same tenantId+name+status returns existing IDs).
 * Tenant-friendly for bulk-import retries + operator double-click.
 *
 * Path β (reject-collision) rejected — user-hostile; breaks idempotency.
 *
 * # M2 — variant_price_inheritance_runtime_resolution_contract (Memo 43 extension)
 *
 * `ProductVariant.price` is nullable with DIFFERENT semantic from
 * `Product.price` (per Memo 43 schema doctrine):
 *   - Product.price=null   → "unpriced" (terminal)
 *   - ProductVariant.price=null → "INHERIT from parent Product.price"
 *
 * `resolveEffectivePrice()` codifies the runtime contract at READ time
 * with the locked rule: `variant.price ?? product.price ?? null`. NEVER
 * coalesce to 0 at any bottom level; null is operator-meaningful.
 *
 * Eager-load contract: callers MUST include parent Product via
 * `{ include: { product: { select: { price: true } } } }` before calling
 * the resolver — prevents N+1 on bulk variant list queries.
 *
 * # M4 lock extension (from KAN-1216b product-service)
 *
 * Siblings adopt verbatim:
 * 1. Archive is terminal (no resurrection via update)
 * 2. Archive does NOT cascade (variants outlive parent soft-delete at FK
 *    level — schema FK Cascade only fires on hard DELETE, not status change)
 * 3. Defensive boundary validation (Zod parse at SERVICE entry, not router-only)
 * 4. AuditLog hook contract (writeInTx atomicity)
 *
 * # Module discipline
 *
 * Pure Prisma module — `@growth/shared` types only. No tRPC, no Pub/Sub.
 * Loaded via variable-specifier dynamic import (KAN-689 cohort) from
 * apps/api/src/router.ts. Hooks injected by caller.
 */
import { createHash } from "node:crypto";
import {
  VariantAttributesSchema,
  type ProductVariant,
  type VariantAttributes,
} from "@growth/shared";
import { z } from "zod";

// ─────────────────────────────────────────────
// Hook contracts (mirrors product-service.ts; same AuditLogHook shape)
// ─────────────────────────────────────────────

export interface AuditLogWriteInput {
  tenantId: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
  reasoning: string;
}

export interface AuditLogHook {
  writeInTx: (
    tx: unknown,
    input: AuditLogWriteInput,
  ) => Promise<{ id: string }>;
}

export interface ProductVariantServiceHooks {
  auditLog: AuditLogHook;
}

// ─────────────────────────────────────────────
// Prisma surface (typed loosely; same posture as product-service.ts)
// ─────────────────────────────────────────────

interface ProductVariantPrismaTx {
  productVariant: {
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    findFirst: (args: unknown) => Promise<unknown>;
  };
  product: {
    findFirst: (args: unknown) => Promise<unknown>;
  };
  auditLog: {
    create: (args: unknown) => Promise<{ id: string }>;
  };
}

interface ProductVariantPrisma {
  $transaction: <T>(fn: (tx: ProductVariantPrismaTx) => Promise<T>) => Promise<T>;
  productVariant: {
    findFirst: (args: unknown) => Promise<unknown>;
  };
}

// ─────────────────────────────────────────────
// Input schemas (E3 — defensive boundary validation per KAN-1216b pattern)
// ─────────────────────────────────────────────

export const CreateVariantInputSchema = z.object({
  productId: z.string().uuid(),
  attributes: VariantAttributesSchema,
  price: z.number().nullable().optional(),
});
export type CreateVariantInput = z.infer<typeof CreateVariantInputSchema>;

export const UpdateVariantInputSchema = z.object({
  attributes: VariantAttributesSchema.optional(),
  price: z.number().nullable().optional(),
});
export type UpdateVariantInput = z.infer<typeof UpdateVariantInputSchema>;

// ─────────────────────────────────────────────
// Errors (mirrors product-service.ts error class pattern)
// ─────────────────────────────────────────────

export class VariantNotFoundError extends Error {
  constructor(public variantId: string) {
    super(`Variant not found: ${variantId}`);
    this.name = "VariantNotFoundError";
  }
}

export class ProductForVariantNotFoundError extends Error {
  constructor(public productId: string) {
    super(`Parent product not found: ${productId}`);
    this.name = "ProductForVariantNotFoundError";
  }
}

export class ArchivedParentProductError extends Error {
  constructor(public productId: string) {
    super(`Cannot create/update variants under archived product: ${productId}`);
    this.name = "ArchivedParentProductError";
  }
}

// ─────────────────────────────────────────────
// M1 detection helper — compute content hash
// ─────────────────────────────────────────────

/**
 * Compute the content hash for variant attributes. 16 hex chars matches
 * 3 sibling-service precedents (knowledge-retrieval, feasibility-context,
 * message-shaper) per Memo 39 codebase-precedent.
 */
export function computeAttributesHash(attributes: VariantAttributes): string {
  return createHash("sha256")
    .update(JSON.stringify(attributes))
    .digest("hex")
    .slice(0, 16);
}

// ─────────────────────────────────────────────
// M2 resolver — runtime price inheritance
// ─────────────────────────────────────────────

/**
 * Resolves the effective price for a variant by walking the inheritance
 * chain: variant.price (own override) → product.price (parent inherit) → null.
 *
 * **Memo 43 + M2 lock**: null is TERMINAL at the bottom; NEVER coalesce
 * to 0. An unpriced variant is operator-meaningfully distinct from a
 * 0-priced variant. Reporting + UI display must surface the difference.
 *
 * **Eager-load contract**: callers MUST `include: { product: { select:
 * { price: true } } }` before calling — prevents N+1 on bulk list queries
 * (KAN-1220 grid UI at tenant scale).
 *
 * Test contract (mandatory in integration tests):
 *   - variant.price=49, product.price=99 → 49 (variant overrides)
 *   - variant.price=null, product.price=99 → 99 (inherit from product)
 *   - variant.price=null, product.price=null → null (unpriced terminal)
 *   - variant.price=49, product.price=null → 49 (variant standalone)
 */
export function resolveEffectivePrice(
  variant: { price: number | null },
  product: { price: number | null },
): number | null {
  return variant.price ?? product.price ?? null;
}

// ─────────────────────────────────────────────
// findVariantByHash — dedup-lookup helper
// ─────────────────────────────────────────────

export async function findVariantByHash(
  prisma: ProductVariantPrisma,
  tenantId: string,
  productId: string,
  attributesHash: string,
): Promise<ProductVariant | null> {
  const variant = (await prisma.productVariant.findFirst({
    where: { tenantId, productId, attributesHash },
  })) as ProductVariant | null;
  return variant;
}

// ─────────────────────────────────────────────
// createVariant — M1 dedup-or-insert + AuditLog (conditional on !isDedup)
// ─────────────────────────────────────────────

export interface CreateVariantResult {
  variant: ProductVariant;
  auditLogId: string;
  /** True if existing variant returned (idempotent re-create per Path α). */
  isDedup: boolean;
}

export async function createVariant(
  prisma: ProductVariantPrisma,
  tenantId: string,
  input: CreateVariantInput,
  actor: string,
  hooks: ProductVariantServiceHooks,
): Promise<CreateVariantResult> {
  // E3: defensive boundary validation at service entry.
  const parsed = CreateVariantInputSchema.parse(input);
  const hash = computeAttributesHash(parsed.attributes);

  return prisma.$transaction(async (tx) => {
    // Validate parent product exists in tenant + not archived (M4 #1 ext).
    const product = (await tx.product.findFirst({
      where: { id: parsed.productId, tenantId },
    })) as { id: string; status: string } | null;
    if (!product) throw new ProductForVariantNotFoundError(parsed.productId);
    if (product.status === "archived") {
      throw new ArchivedParentProductError(parsed.productId);
    }

    // M1 Path α: dedup check via composite index.
    const existing = (await tx.productVariant.findFirst({
      where: { tenantId, productId: parsed.productId, attributesHash: hash },
    })) as ProductVariant | null;
    if (existing) {
      // Idempotent-return; skip AuditLog (no duplicate row).
      return { variant: existing, auditLogId: "", isDedup: true };
    }

    // Hash miss: INSERT new variant.
    const variant = (await tx.productVariant.create({
      data: {
        tenantId,
        productId: parsed.productId,
        attributes: parsed.attributes,
        attributesHash: hash,
        price: parsed.price ?? null,
      },
    })) as ProductVariant;

    // M4 #4: AuditLog hook — full snapshot for create.
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product_variant.created",
      payload: {
        variantId: variant.id,
        productId: parsed.productId,
        attributesHash: hash,
      },
      reasoning: `operator ${actor} created variant under product ${parsed.productId}`,
    });

    return { variant, auditLogId: audit.id, isDedup: false };
  });
}

// ─────────────────────────────────────────────
// updateVariant — partial UPDATE + AuditLog before/after delta
// ─────────────────────────────────────────────

export interface UpdateVariantResult {
  variant: ProductVariant;
  auditLogId: string;
}

export async function updateVariant(
  prisma: ProductVariantPrisma,
  tenantId: string,
  variantId: string,
  input: UpdateVariantInput,
  actor: string,
  hooks: ProductVariantServiceHooks,
): Promise<UpdateVariantResult> {
  const parsed = UpdateVariantInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const before = (await tx.productVariant.findFirst({
      where: { id: variantId, tenantId },
    })) as ProductVariant | null;
    if (!before) throw new VariantNotFoundError(variantId);

    // If attributes change, recompute hash.
    const newHash = parsed.attributes
      ? computeAttributesHash(parsed.attributes)
      : undefined;

    const after = (await tx.productVariant.update({
      where: { id: variantId },
      data: {
        ...(parsed.attributes !== undefined && {
          attributes: parsed.attributes,
        }),
        ...(newHash !== undefined && { attributesHash: newHash }),
        ...(parsed.price !== undefined && { price: parsed.price }),
      },
    })) as ProductVariant;

    // M4 #4: AuditLog hook — delta {before, after} for updates.
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product_variant.updated",
      payload: {
        variantId,
        before: before as unknown as Record<string, unknown>,
        after: after as unknown as Record<string, unknown>,
      },
      reasoning: `operator ${actor} updated variant ${variantId}`,
    });

    return { variant: after, auditLogId: audit.id };
  });
}

// ─────────────────────────────────────────────
// archiveVariant — DELETE row (variants have no archivedAt per KAN-1214 schema)
// ─────────────────────────────────────────────
//
// Per KAN-1214 schema doctrine, ProductVariant has NO archivedAt column —
// variant lifecycle is fully owned by parent Product.status. The
// "archive a variant" operation conceptually is a hard-delete + audit.
// Future M5 memo (if variant-level archive becomes needed at KAN-1218 UX)
// would add archivedAt to the schema; for MVP we expose this as a typed
// service-level error pointing operators at parent archive instead.

export class VariantArchiveNotSupportedError extends Error {
  constructor(public variantId: string) {
    super(
      `Variant-level archive not supported in MVP; archive parent product instead. ` +
        `Variant: ${variantId}`,
    );
    this.name = "VariantArchiveNotSupportedError";
  }
}

/**
 * Stub for variant-level archive. NOT IMPLEMENTED in MVP per KAN-1214
 * schema design (variants inherit parent lifecycle). Throws typed error
 * to surface the architectural choice.
 *
 * If KAN-1218 UX surfaces variant-level archive as required:
 *   1. Add `archivedAt DateTime?` to ProductVariant schema (KAN-1216a-style
 *      additive migration)
 *   2. Update this function to soft-delete via status + archivedAt mirror
 *   3. Update integration test scenarios to cover variant-level archive
 *   4. Bank as fix-forward memo (variant-archive-deferred precedent)
 */
export async function archiveVariant(
  _prisma: ProductVariantPrisma,
  _tenantId: string,
  variantId: string,
  _actor: string,
  _hooks: ProductVariantServiceHooks,
): Promise<never> {
  throw new VariantArchiveNotSupportedError(variantId);
}
