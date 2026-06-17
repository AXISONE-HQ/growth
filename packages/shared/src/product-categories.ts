/**
 * KAN-1215 — ProductCategory shared schema (Slice 1 PR 3 of KAN-1212 epic).
 *
 * Single source of truth for ProductCategory shape across workspaces:
 *   - apps/api    — products.categories CRUD (KAN-1216)
 *   - apps/web    — Settings catalog taxonomy UI (KAN-1220+)
 *   - apps/connectors — scrape UX category ingest (KAN-1223)
 *
 * # Status enum reuse (Q-ADD NEW-Q3 lock)
 *
 * `status` reuses `ProductStatusEnum` from `./products.js` (NOT a new
 * CategoryStatusEnum). Doctrinally shared across catalog models; keeps
 * migration versioning + Zod export clean. The three lifecycle states
 * (`draft` / `active` / `archived`) carry identical semantics for both
 * Product and ProductCategory — operator authoring, in-use, soft-deleted.
 *
 * # @@unique([tenantId, parentId, name]) NULL semantic (Memo 45)
 *
 * The Prisma `@@unique` constraint at schema.prisma includes a nullable
 * `parentId`. SQL standard: NULL ≠ NULL — multiple root categories with the
 * same name per tenant are ALLOWED. See `ProductCategory` model header in
 * schema.prisma for the full doctrine block + Memo 45 memo reference.
 *
 * Zod consumers do NOT enforce uniqueness at parse time — the DB constraint
 * is the source of truth. KAN-1216 CRUD wraps create/update in try/catch and
 * surfaces the Prisma `P2002` error as a typed "duplicate sibling name"
 * response to the UI layer.
 *
 * # sortOrder explicitly OMITTED (Q-ADD NEW-Q2 lock)
 *
 * No `sortOrder` field. MVP uses lexical sort by `name`. If KAN-1216 UX
 * surfaces drag-to-reorder as required, fix-forward adds the column +
 * Zod schema + Prisma migration as a follow-up.
 */
import { z } from "zod";
import { ProductStatusEnum } from "./products.js";

/**
 * Canonical ProductCategory shape — matches Prisma `ProductCategory` model
 * field-for-field.
 *
 * Tree structure: `parentId` is nullable for root categories. Children form
 * a recursive tree via the self-referencing FK; depth is enforced at the
 * service layer (KAN-1216 — max 5 levels), NOT in this Zod schema.
 *
 * Timestamps: ISO 8601 strings at the JSON boundary (Prisma default).
 * Consumers parsing into Date should use `z.coerce.date()` at their layer.
 */
export const ProductCategorySchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  // Nullable parent — NULL = root category. See module-level doctrine for
  // the @@unique NULL semantic (Memo 45).
  parentId: z.string().uuid().nullable(),
  name: z.string().min(1),
  description: z.string().nullable(),
  // Reused from products.ts per NEW-Q3 lock; do NOT introduce CategoryStatus.
  status: ProductStatusEnum,
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProductCategory = z.infer<typeof ProductCategorySchema>;

/**
 * Cursor-paginated list response shape. Mirrors KAN-1183 campaigns.list /
 * KAN-1213 products.list / KAN-1214 product-variants.list pattern. KAN-1216
 * extends with `ProductCategoryListItem` if aggregate columns become needed
 * (e.g., productCount per category, full ancestor path materialized
 * server-side, etc.).
 */
export const ProductCategoryListResponseSchema = z.object({
  items: z.array(ProductCategorySchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
});
export type ProductCategoryListResponse = z.infer<
  typeof ProductCategoryListResponseSchema
>;
