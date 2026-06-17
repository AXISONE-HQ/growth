/**
 * KAN-1214 — ProductVariant shared schema (Slice 1 PR 2 of KAN-1212 epic).
 *
 * Single source of truth for ProductVariant shape across workspaces:
 *   - apps/api    — products.variants CRUD (KAN-1216)
 *   - apps/web    — variant grid UI (KAN-1220+)
 *   - apps/connectors — scrape UX variant ingest (KAN-1223)
 *
 * # Differential-semantic doctrine (Memo 43)
 *
 * `ProductVariant.price` is `z.number().nullable()` matching Prisma's
 * Decimal-to-JS-number coercion at the JSON boundary. IDENTICAL JSON shape
 * to `Product.price` (packages/shared/src/products.ts) — but the application-
 * layer semantic of `null` DIFFERS:
 *
 *   - `Product.price = null`        — "no price set; treat as unpriced"
 *   - `ProductVariant.price = null` — "INHERIT from parent Product.price at runtime"
 *
 * Runtime resolution rule (implemented in KAN-1216 CRUD service helper):
 *
 *   const resolvedPrice = variant.price ?? variant.product.price ?? null;
 *   // null at the bottom level = unpriced (terminal); never coalesce to 0.
 *
 * See the `same_mechanism_different_semantic_schema_pattern` memo for the
 * full discipline + cross-model contract. The Prisma type system enforces
 * NOTHING about application-layer interpretation; this doc comment + the
 * service-layer helper test in KAN-1216 are the only sanctioned mechanisms
 * for capturing the distinction.
 *
 * # Attribute shape (Q-A10 lock)
 *
 * `attributes` is a typed-but-flexible Json record. Known discriminator keys
 * are `size`, `color`, `tier` — but ProductVariant accepts arbitrary keys so
 * tenants can extend the variant matrix without schema migration. Zod
 * `passthrough()` preserves unknown keys at parse time; consumers are
 * responsible for not collapsing the distinction.
 *
 * # SKU explicitly REJECTED (Q-ADD B4 verdict)
 *
 * Zero codebase anchor for SKU across 67 Prisma models. Variant
 * differentiation lives entirely in `attributes`. If SKU becomes a product
 * requirement later, file a separate ticket with codebase-aligned shape
 * (likely `externalSku String?` on Product with vendor-scoped semantic,
 * NOT a generic SKU column on ProductVariant). See KAN-1218 scope addendum
 * (Jira comment 11735) for the zombie SKU cleanup tracked elsewhere.
 */
import { z } from "zod";

/**
 * Variant attribute discriminators. Known keys (`size`, `color`, `tier`) are
 * typed; arbitrary additional keys preserved via `passthrough()` so tenants
 * extending the variant matrix don't break Zod parse. KAN-1216 CRUD adds
 * write-time validation + content-hash dedup at the service layer.
 */
export const VariantAttributesSchema = z
  .object({
    size: z.string().optional(),
    color: z.string().optional(),
    tier: z.string().optional(),
  })
  .passthrough();
export type VariantAttributes = z.infer<typeof VariantAttributesSchema>;

/**
 * Canonical ProductVariant shape — matches Prisma `ProductVariant` model
 * field-for-field.
 *
 * Money: `price` is `number | null` at the JSON boundary. `null` semantic
 * differs from `Product.price` — see module-level doctrine comment.
 *
 * Timestamps: ISO 8601 strings at the JSON boundary (Prisma default).
 * Consumers parsing into Date should use `z.coerce.date()` at their layer
 * (matches Campaign/Deal/Order/Product doctrine).
 */
export const ProductVariantSchema = z.object({
  id: z.string().uuid(),
  tenantId: z.string().uuid(),
  productId: z.string().uuid(),
  attributes: VariantAttributesSchema,
  // KAN-1216a — Content hash of `attributes` for service-layer dedup.
  // 16 hex chars (sha256 slice; KAN-1216c retrofitted from 12 to 16 per
  // Memo 39 codebase-precedent over 3 sha256 sibling services).
  // Nullable for pre-1216c rows + bulk-import paths that bypass the
  // service-layer hasher; the M1 memo
  // (`service_layer_content_hash_dedup_discipline`) lands at KAN-1216c
  // with the canonical computation + dedup contract.
  attributesHash: z.string().nullable(),
  // Money — Decimal(12,2) at DB; number at JSON boundary. NOT Int cents.
  // null = "inherit from Product.price at runtime" (NOT "unpriced" — that's
  // the Product.price semantic). See module doctrine + Memo 43.
  price: z.number().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

/**
 * Cursor-paginated list response shape. Mirrors the canonical list shape
 * established by KAN-1183 campaigns.list / KAN-1213 products.list. KAN-1216
 * extends with `ProductVariantListItem` if aggregate columns become needed
 * (e.g., resolvedPrice computed server-side, parent product summary, etc.).
 */
export const ProductVariantListResponseSchema = z.object({
  items: z.array(ProductVariantSchema),
  nextCursor: z.string().nullable(),
  totalCount: z.number().int().nonnegative(),
});
export type ProductVariantListResponse = z.infer<
  typeof ProductVariantListResponseSchema
>;
