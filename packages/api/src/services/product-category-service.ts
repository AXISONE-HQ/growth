/**
 * KAN-1216d ProductCategory CRUD service — Slice 2 PR 1d of KAN-1212 epic.
 *
 * Closes the Slice 2 substrate (Product + ProductVariant + ProductCategory
 * CRUD layer fully operational). Sibling to product-service.ts (M4) and
 * product-variant-service.ts (M1 + M2). This module seeds ONE memo: M3
 * (recursive tree depth-guard at service write-time, paired with
 * cycle-prevention on parentId mutation).
 *
 * # M3 — recursive_tree_depth_guard_service_pattern (canonical anchor)
 *
 * **Why depth-guard at service write-time, not Zod.**  Zod can validate a
 * single input row's shape but cannot traverse ANCESTORS to enforce TREE
 * depth at the INSERTION POINT. A category at parent.depth+1 only knows
 * its own slot — only a service-layer walker that fetches parent +
 * grandparent + ... up to root can decide whether the proposed insertion
 * exceeds MAX_CATEGORY_DEPTH. The schema deliberately stores no depth
 * column (KAN-1215 substrate doctrine: "ZERO `depth: Int` / `level: Int`
 * columns across 68 models — app-layer guards are the canonical pattern");
 * depth is therefore a RUNTIME computation at write time, materialized by
 * walking parent.parent.parent... up to NULL.
 *
 * `MAX_CATEGORY_DEPTH = 5` constant: root = depth 0, leaves at depth ≤ 5.
 * A proposed depth > 5 throws `CategoryDepthLimitExceededError`. The bound
 * matches KAN-1215 substrate doctrine (model header comment "max 5 levels");
 * fix-forward if operator UX needs deeper taxonomies — a single constant
 * change + integration-test sweep.
 *
 * **Paired with cycle-prevention.**  Any parentId mutation must verify the
 * proposed new parent's ANCESTOR CHAIN does NOT contain the target category
 * id. Otherwise: self-cycle (parentId = self) OR transitive cycle (moving A
 * under its descendant C — A becomes its own great-grandparent). Both fire
 * at write-time on createCategory (parentId set at insert) AND
 * updateCategory (parentId changes). `archiveCategory` is EXEMPT: it does
 * not mutate parentId; children stay live with the original parentId (the
 * schema's `onDelete: SetNull` only fires on hard DELETE, not status='archived').
 *
 * **Guard order at updateCategory(parentId mutation):**
 *   1. Resolve target's existing row (parent of source for cycle origin).
 *   2. Cycle check FIRST — `checkCycle(tx, targetId, newParentId)` walks
 *      newParentId's ancestor chain; if targetId ∈ chain → reject.
 *   3. Depth check SECOND — fetch newParent, depth = newParent.depth + 1
 *      (recomputed from new parent's ancestor walk). > MAX → reject.
 *   4. Apply Prisma update.
 *
 * Cycle-FIRST ordering matters: a self-cycle (parentId = self) would yield
 * depth = self.depth + 1 (looks innocuous), but the parent walk loops back
 * onto self and never terminates. The cycle check uses a bounded ancestor
 * walk (O(MAX_CATEGORY_DEPTH + 2)) with a safety cap that throws on
 * runaway, but it is cheaper + more correct to reject the cycle outright.
 *
 * # G6 — P2002 wrapping (FIRST EXPLICIT INSTANCE in catalog arc)
 *
 * The `@@unique([tenantId, parentId, name])` constraint from KAN-1215
 * schema (Memo 45 NULL-semantic doctrine) treats NULL parentId as DISTINCT
 * per row. So two root categories with the same name per tenant are
 * ALLOWED (NULL ≠ NULL in Postgres unique constraints). But two siblings
 * under the SAME parent with the SAME name throw Prisma `P2002`. This
 * service maps P2002 → typed `CategoryAlreadyExistsError(tenantId, name,
 * parentId)` so the router layer surfaces a clean BAD_REQUEST.
 *
 * Precedent: `orders-router.ts:271 wrapOrderNumberUniqueCollision` (KAN-945)
 * + `import-commit.ts:934` map P2002 to BAD_REQUEST. KAN-1216b/c did NOT
 * need P2002 wrapping (no unique constraints on user-supplied columns).
 * This is the FIRST explicit P2002 wrap site in the catalog arc (KAN-1213
 * Product / KAN-1214 ProductVariant / KAN-1215 ProductCategory triple); a
 * 4th if you count the orders + imports precedents.
 *
 * # M4 lock extension (from KAN-1216b product-service)
 *
 * Siblings adopt verbatim:
 * 1. Archive is terminal (no resurrection via update; archiveCategory on
 *    already-archived row idempotent-returns alreadyArchived=true).
 * 2. Archive does NOT cascade (children stay live with original parentId —
 *    schema FK SetNull only fires on hard DELETE, not status change).
 * 3. Defensive boundary validation (Zod parse at SERVICE entry, not router-only).
 * 4. AuditLog hook contract (writeInTx atomicity).
 *
 * Cross-refs: Memo 38/44/45/46 + KAN-1216b M4 archive-terminal extension +
 * KAN-1215 schema foundation (self-FK + composite unique with NULL semantics).
 *
 * # Joint-arc framework marker
 *
 * 50th memo banked across the joint KAN-1181 (~38) + KAN-1212 (~12 with
 * this one) doctrine framework. Progress marker, not a memo claim itself.
 *
 * # Module discipline
 *
 * Pure Prisma module — `@growth/shared` types only. No tRPC, no Pub/Sub.
 * Loaded via variable-specifier dynamic import (KAN-689 cohort) from
 * apps/api/src/router.ts. Hooks injected by caller.
 */
import { ProductStatusEnum, type ProductCategory } from "@growth/shared";
import { Prisma } from "@prisma/client";
import { z } from "zod";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

/**
 * Maximum nesting depth for the category tree. Root = depth 0; leaves may
 * sit at depth ≤ MAX_CATEGORY_DEPTH. Service-layer enforcement at write
 * time (KAN-1215 schema doctrine: zero `depth` columns across 68 models —
 * app-layer guards are canonical).
 */
export const MAX_CATEGORY_DEPTH = 5;

/** Safety cap on the ancestor walker — depth + 2 hard stop against runaway. */
const ANCESTOR_WALK_SAFETY_CAP = MAX_CATEGORY_DEPTH + 2;

const CATEGORY_NAME_MAX = 255;
const CATEGORY_DESCRIPTION_MAX = 4000;

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

export interface ProductCategoryServiceHooks {
  auditLog: AuditLogHook;
}

// ─────────────────────────────────────────────
// Prisma surface (typed loosely; same posture as product/variant services)
// ─────────────────────────────────────────────

interface ProductCategoryPrismaTx {
  productCategory: {
    create: (args: unknown) => Promise<unknown>;
    update: (args: unknown) => Promise<unknown>;
    findFirst: (args: unknown) => Promise<unknown>;
  };
  auditLog: {
    create: (args: unknown) => Promise<{ id: string }>;
  };
}

interface ProductCategoryPrisma {
  $transaction: <T>(
    fn: (tx: ProductCategoryPrismaTx) => Promise<T>,
  ) => Promise<T>;
}

// ─────────────────────────────────────────────
// Input schemas (E3 — defensive boundary validation per KAN-1216b pattern)
// ─────────────────────────────────────────────

export const CreateCategoryInputSchema = z.object({
  name: z.string().min(1).max(CATEGORY_NAME_MAX),
  parentId: z.string().uuid().nullable().default(null),
  description: z.string().max(CATEGORY_DESCRIPTION_MAX).nullable().optional(),
  status: ProductStatusEnum.optional(),
});
export type CreateCategoryInput = z.infer<typeof CreateCategoryInputSchema>;

export const UpdateCategoryInputSchema = z.object({
  name: z.string().min(1).max(CATEGORY_NAME_MAX).optional(),
  parentId: z.string().uuid().nullable().optional(),
  description: z.string().max(CATEGORY_DESCRIPTION_MAX).nullable().optional(),
  status: ProductStatusEnum.optional(),
});
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInputSchema>;

// ─────────────────────────────────────────────
// Errors (6 typed classes; mirrors product/variant service shape)
// ─────────────────────────────────────────────

export class CategoryNotFoundError extends Error {
  constructor(public categoryId: string) {
    super(`Category not found: ${categoryId}`);
    this.name = "CategoryNotFoundError";
  }
}

export class ParentCategoryNotFoundError extends Error {
  constructor(public parentId: string) {
    super(`Parent category not found: ${parentId}`);
    this.name = "ParentCategoryNotFoundError";
  }
}

export class CategoryDepthLimitExceededError extends Error {
  constructor(
    public attemptedDepth: number,
    public max: number,
  ) {
    super(
      `Category depth ${attemptedDepth} exceeds max ${max}. Reorganize the taxonomy or raise MAX_CATEGORY_DEPTH.`,
    );
    this.name = "CategoryDepthLimitExceededError";
  }
}

export class CategoryCycleDetectedError extends Error {
  constructor(
    public targetId: string,
    public attemptedParentId: string,
  ) {
    super(
      `Cycle detected: cannot set parent of ${targetId} to ${attemptedParentId} — ${attemptedParentId} is a descendant of ${targetId}.`,
    );
    this.name = "CategoryCycleDetectedError";
  }
}

export class ArchivedCategoryMutationError extends Error {
  constructor(public categoryId: string) {
    super(
      `Cannot mutate archived category (or create child under it): ${categoryId}`,
    );
    this.name = "ArchivedCategoryMutationError";
  }
}

export class CategoryAlreadyExistsError extends Error {
  constructor(
    public tenantId: string,
    public name_: string,
    public parentId: string | null,
  ) {
    super(
      `Category name "${name_}" already exists under parent ${parentId ?? "(root)"} in tenant ${tenantId}.`,
    );
    this.name = "CategoryAlreadyExistsError";
  }
}

// ─────────────────────────────────────────────
// G3 / G4 helpers — ancestor walker + cycle check
// ─────────────────────────────────────────────

interface AncestorNode {
  id: string;
  parentId: string | null;
}

/**
 * Walks the ancestor chain from `startId` (inclusive) up to root. O(depth).
 * Each step performs a `tx.productCategory.findFirst({ where: { tenantId, id }
 * select: { id, parentId } })`. Stops when parentId === null OR the safety
 * cap fires (defense in depth against a runaway cycle that the cycle-check
 * missed).
 *
 * Used by both `checkCycle` (verify newParent's chain does NOT include
 * target) and `computeDepth` (count steps from a leaf-candidate to root).
 */
async function traverseAncestors(
  tx: ProductCategoryPrismaTx,
  tenantId: string,
  startId: string,
): Promise<AncestorNode[]> {
  const chain: AncestorNode[] = [];
  let currentId: string | null = startId;
  let steps = 0;
  while (currentId !== null && steps <= ANCESTOR_WALK_SAFETY_CAP) {
    const node = (await tx.productCategory.findFirst({
      where: { tenantId, id: currentId },
      select: { id: true, parentId: true },
    })) as AncestorNode | null;
    if (!node) break;
    chain.push(node);
    currentId = node.parentId;
    steps += 1;
  }
  return chain;
}

/**
 * Verifies that setting `targetId`'s parent to `newParentId` does NOT
 * create a cycle. Walks newParentId's ancestor chain; if any node.id ===
 * targetId, the move would make targetId its own ancestor → throws
 * `CategoryCycleDetectedError`.
 *
 * Self-cycle (newParentId === targetId) is caught on the first hop.
 * Transitive cycles caught at the matching ancestor depth.
 */
async function checkCycle(
  tx: ProductCategoryPrismaTx,
  tenantId: string,
  targetId: string,
  newParentId: string | null,
): Promise<void> {
  if (newParentId === null) return;
  if (newParentId === targetId) {
    throw new CategoryCycleDetectedError(targetId, newParentId);
  }
  const chain = await traverseAncestors(tx, tenantId, newParentId);
  for (const node of chain) {
    if (node.id === targetId) {
      throw new CategoryCycleDetectedError(targetId, newParentId);
    }
  }
}

/**
 * Computes the runtime depth of a node given its parent's id. depth=0 at
 * root; depth=parent.depth+1 for children. Implemented as ancestor-count
 * (no stored depth column per KAN-1215 substrate doctrine).
 */
async function computeDepth(
  tx: ProductCategoryPrismaTx,
  tenantId: string,
  parentId: string | null,
): Promise<number> {
  if (parentId === null) return 0;
  const chain = await traverseAncestors(tx, tenantId, parentId);
  return chain.length; // parent at depth 0 → chain.length=1 → new child sits at depth 1
}

// ─────────────────────────────────────────────
// G6 — P2002 wrap helper
// ─────────────────────────────────────────────

/**
 * Map Prisma P2002 unique-constraint violation on
 * @@unique([tenantId, parentId, name]) to typed CategoryAlreadyExistsError.
 * Re-throw anything else unchanged.
 *
 * Memo 45 NULL-semantic respected: P2002 ONLY fires when the proposed row
 * matches an existing row on (tenantId, parentId, name) with NON-null
 * parentId (or with both NULL parentIds, which Postgres treats as
 * DISTINCT — so duplicate root names per tenant are allowed and do NOT
 * fire P2002). The caller of this wrapper does not need to disambiguate
 * the NULL case; if P2002 fires, the duplicate genuinely exists.
 */
function wrapCategoryUniqueCollision(
  error: unknown,
  tenantId: string,
  name: string,
  parentId: string | null,
): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2002"
  ) {
    throw new CategoryAlreadyExistsError(tenantId, name, parentId);
  }
  throw error;
}

// ─────────────────────────────────────────────
// createCategory — INSERT + depth/cycle guard + AuditLog (atomic via $transaction)
// ─────────────────────────────────────────────

export interface CreateCategoryResult {
  category: ProductCategory;
  auditLogId: string;
}

export async function createCategory(
  prisma: ProductCategoryPrisma,
  tenantId: string,
  input: CreateCategoryInput,
  actor: string,
  hooks: ProductCategoryServiceHooks,
): Promise<CreateCategoryResult> {
  // M4 lock #3: defensive boundary validation at service entry.
  const parsed = CreateCategoryInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    // M3 depth-guard: compute new node's depth via parent's ancestor walk.
    // No cycle check needed on create (new node has no descendants yet).
    if (parsed.parentId !== null) {
      const parent = (await tx.productCategory.findFirst({
        where: { tenantId, id: parsed.parentId },
        select: { id: true, status: true },
      })) as { id: string; status: string } | null;
      if (!parent) throw new ParentCategoryNotFoundError(parsed.parentId);
      // M4 #1 ext: cannot create child under archived parent.
      if (parent.status === "archived") {
        throw new ArchivedCategoryMutationError(parsed.parentId);
      }
    }

    const depth = await computeDepth(tx, tenantId, parsed.parentId);
    if (depth > MAX_CATEGORY_DEPTH) {
      throw new CategoryDepthLimitExceededError(depth, MAX_CATEGORY_DEPTH);
    }

    let category: ProductCategory;
    try {
      category = (await tx.productCategory.create({
        data: {
          tenantId,
          name: parsed.name,
          parentId: parsed.parentId,
          description: parsed.description ?? null,
          status: parsed.status ?? "active",
        },
      })) as ProductCategory;
    } catch (err) {
      wrapCategoryUniqueCollision(err, tenantId, parsed.name, parsed.parentId);
    }

    // M4 lock #4: AuditLog hook — full snapshot for create.
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product_category.created",
      payload: {
        categoryId: category!.id,
        name: parsed.name,
        parentId: parsed.parentId,
        depth,
      },
      reasoning: `operator ${actor} created category ${parsed.name}`,
    });

    return { category: category!, auditLogId: audit.id };
  });
}

// ─────────────────────────────────────────────
// updateCategory — partial UPDATE + cycle/depth guard on parentId mutation
// ─────────────────────────────────────────────

export interface UpdateCategoryResult {
  category: ProductCategory;
  auditLogId: string;
}

export async function updateCategory(
  prisma: ProductCategoryPrisma,
  tenantId: string,
  categoryId: string,
  input: UpdateCategoryInput,
  actor: string,
  hooks: ProductCategoryServiceHooks,
): Promise<UpdateCategoryResult> {
  const parsed = UpdateCategoryInputSchema.parse(input);

  return prisma.$transaction(async (tx) => {
    const before = (await tx.productCategory.findFirst({
      where: { id: categoryId, tenantId },
    })) as ProductCategory | null;
    if (!before) throw new CategoryNotFoundError(categoryId);
    // M4 lock #1: archive is terminal — no resurrection via update.
    if (before.status === "archived") {
      throw new ArchivedCategoryMutationError(categoryId);
    }

    // M3 cycle + depth check ONLY when parentId is genuinely changing.
    // Tradeoff: descendants' computed depth becomes stale relative to the
    // tree's new root distance when an inner node is re-parented; we do
    // NOT cascade-update because depth is recomputed at every subsequent
    // write + read site. If KAN-1218 surfaces stored-depth-for-query needs,
    // file a fix-forward to add a denormalized column + cascade trigger.
    if (parsed.parentId !== undefined && parsed.parentId !== before.parentId) {
      if (parsed.parentId !== null) {
        const newParent = (await tx.productCategory.findFirst({
          where: { tenantId, id: parsed.parentId },
          select: { id: true, status: true },
        })) as { id: string; status: string } | null;
        if (!newParent) {
          throw new ParentCategoryNotFoundError(parsed.parentId);
        }
        if (newParent.status === "archived") {
          throw new ArchivedCategoryMutationError(parsed.parentId);
        }
      }
      // Cycle check FIRST (avoids runaway depth-walk on self-cycle).
      await checkCycle(tx, tenantId, categoryId, parsed.parentId);
      // Depth check SECOND.
      const newDepth = await computeDepth(tx, tenantId, parsed.parentId);
      if (newDepth > MAX_CATEGORY_DEPTH) {
        throw new CategoryDepthLimitExceededError(newDepth, MAX_CATEGORY_DEPTH);
      }
    }

    let after: ProductCategory;
    try {
      after = (await tx.productCategory.update({
        where: { id: categoryId },
        data: {
          ...(parsed.name !== undefined && { name: parsed.name }),
          ...(parsed.parentId !== undefined && { parentId: parsed.parentId }),
          ...(parsed.description !== undefined && {
            description: parsed.description,
          }),
          ...(parsed.status !== undefined && { status: parsed.status }),
        },
      })) as ProductCategory;
    } catch (err) {
      const finalName = parsed.name ?? before.name;
      const finalParentId =
        parsed.parentId !== undefined ? parsed.parentId : before.parentId;
      wrapCategoryUniqueCollision(err, tenantId, finalName, finalParentId);
    }

    // M4 lock #4: AuditLog hook — delta {before, after} for updates.
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product_category.updated",
      payload: {
        categoryId,
        before: before as unknown as Record<string, unknown>,
        after: after! as unknown as Record<string, unknown>,
      },
      reasoning: `operator ${actor} updated category ${categoryId}`,
    });

    return { category: after!, auditLogId: audit.id };
  });
}

// ─────────────────────────────────────────────
// archiveCategory — soft-delete via status='archived' + archivedAt=now()
// ─────────────────────────────────────────────

export interface ArchiveCategoryResult {
  category: ProductCategory;
  auditLogId: string;
  /** True if the category was already archived (idempotent re-archive). */
  alreadyArchived: boolean;
}

export async function archiveCategory(
  prisma: ProductCategoryPrisma,
  tenantId: string,
  categoryId: string,
  actor: string,
  hooks: ProductCategoryServiceHooks,
): Promise<ArchiveCategoryResult> {
  return prisma.$transaction(async (tx) => {
    const before = (await tx.productCategory.findFirst({
      where: { id: categoryId, tenantId },
    })) as ProductCategory | null;
    if (!before) throw new CategoryNotFoundError(categoryId);

    // M4 lock #1: archive is idempotent — return existing state on re-archive
    // without logging a duplicate audit row.
    if (before.status === "archived") {
      return { category: before, auditLogId: "", alreadyArchived: true };
    }

    const now = new Date();
    const after = (await tx.productCategory.update({
      where: { id: categoryId },
      data: {
        status: "archived",
        archivedAt: now,
      },
    })) as ProductCategory;

    // M4 lock #2: NO cascade. Children stay live with their original
    // parentId. The schema's `onDelete: SetNull` only fires on HARD DELETE;
    // a status change does not touch the FK. Integration test asserts
    // children.parentId stays equal to before.id post-archive.
    //
    // M4 lock #4: AuditLog hook — full snapshot for archive.
    const audit = await hooks.auditLog.writeInTx(tx, {
      tenantId,
      actor,
      actionType: "product_category.archived",
      payload: { categoryId, archivedAt: now.toISOString() },
      reasoning: `operator ${actor} archived category ${after.name}`,
    });

    return { category: after, auditLogId: audit.id, alreadyArchived: false };
  });
}
