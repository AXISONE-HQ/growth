/**
 * KAN-1213 — Product Catalog Module shared schema (Slice 1 of KAN-1212 epic).
 *
 * Single source of truth for Product shape across workspaces:
 *   - apps/api    — products.list tRPC procedure (this slice; minimal)
 *                 — full CRUD procedures (KAN-1216)
 *   - apps/web    — Settings catalog UI (deferred to KAN-1214/1215)
 *   - apps/connectors — scrape UX import target (deferred to KAN-1223)
 *
 * # Money column discipline (codebase_precedent_over_external_convention memo)
 *
 * price is Zod-typed as `z.number().nullable()` matching Prisma's
 * Decimal-to-JS-number coercion at the JSON boundary. The schema accepts
 * floating-point input; the Decimal(12,2) DB constraint truncates to 2dp on
 * insert. This mirrors how Deal.value and Order.grandTotal already serialize
 * across the tRPC boundary — NO Int cents conversion at any layer.
 *
 * SPO Phase 1 pre-leaned Int cents (Stripe convention); CC empirical
 * inventory refuted; codebase precedent wins (Deal.value, Order.grandTotal
 * et al all Decimal(12,2) + USD-default). Multi-currency (KAN-1132) deferred
 * to the whole-trio convergence, NOT a per-entity migration.
 *
 * # ProductStatus enum
 *
 * Three-state minimal set; PAIRS-tested via shared enums export pattern
 * (sibling: CampaignStatus, OrderStatus, DealStatus). KAN-1216 widens if
 * scrape UX surfaces an intermediate "pending_review" gate.
 *
 * # KAN-689 cohort
 *
 * This file is intentionally minimal so the first KAN-1212 slice imports
 * only the necessary types. KAN-1216 extends with CreateProductInput +
 * UpdateProductInput when full CRUD lands.
 */
import { z } from "zod";

/**
 * Product lifecycle states. Mirrors the Prisma `ProductStatus` enum at
 * packages/db/prisma/schema.prisma. PAIRS export pattern: any consumer that
 * branches on status MUST import this constant + use it as the source of truth,
 * NEVER hardcode string literals.
 */
export const PRODUCT_STATUSES = ["draft", "active", "archived"] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];
export const ProductStatusEnum = z.enum(PRODUCT_STATUSES);

/**
 * Canonical Product shape — matches Prisma `Product` model field-for-field.
 *
 * Money fields: `price` is `number | null` at the JSON boundary; Prisma
 * coerces Decimal(12,2) ↔ number at serialization. `currency` is the ISO
 * 4217 3-char code, default "USD".
 *
 * Timestamps are ISO 8601 strings at the JSON boundary (Prisma default).
 * Consumers parsing into Date should use `z.coerce.date()` at their layer
 * (matches Campaign/Deal/Order doctrine).
 */
export const ProductSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  status: ProductStatusEnum,
  // Money — Decimal(12,2) at DB; number at JSON boundary. NOT Int cents.
  // See module-level doctrine comment for the codebase-precedent reasoning.
  price: z.number().nullable(),
  currency: z.string().length(3),
  externalUrl: z.string().url().nullable(),
  primaryImageUrl: z.string().url().nullable(),
  customFields: z.record(z.unknown()),
  archivedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Product = z.infer<typeof ProductSchema>;

/**
 * Cursor-paginated list response shape. Mirrors the canonical list shape
 * established by KAN-1183 campaigns.list / companies.list / contacts.list.
 * KAN-1216 widens the per-row shape to `ProductListItem` when the catalog
 * UI needs aggregate columns (e.g., usageCount across Campaigns).
 */
export const ProductListResponseSchema = z.object({
  items: z.array(ProductSchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
});
export type ProductListResponse = z.infer<typeof ProductListResponseSchema>;
