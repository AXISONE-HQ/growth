/**
 * KAN-883 — shared cursor pagination helper for CRM read-layer tRPC routes.
 *
 * Establishes the canonical opaque-cursor pattern used by companies.list,
 * orders.list, deals.list, and (eventually, via KAN-882) contacts.list.
 *
 * The cursor encodes `{ id, createdAt }` of the LAST item in the current
 * page. The `id` provides a unique tiebreaker for rows with identical
 * `createdAt` timestamps — critical for stable ordering under high-write
 * loads where multiple rows share a millisecond.
 *
 * Ordering invariant for every list query that uses this helper:
 *   ORDER BY createdAt DESC, id DESC
 *
 * Filter invariant for the "page after cursor" clause:
 *   WHERE (createdAt < cursor.createdAt)
 *      OR (createdAt = cursor.createdAt AND id < cursor.id)
 *
 * NOTE on placedAt orderings (orders.list): `orders` is ordered by
 * `placedAt DESC` per the spec, NOT `createdAt`. We reuse this helper by
 * passing the orders' `placedAt` value into the `createdAt` slot of the
 * cursor — the field name on the cursor is conceptually "the ORDER BY
 * timestamp column," not literally createdAt. Callers are responsible for
 * mapping the right column.
 */
import { z } from "zod";

const CursorPayloadSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime({ offset: true }),
});

export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

/**
 * Encode the last row of a page into an opaque base64 token. Clients treat
 * this as a black box. Server-side cursor format CAN change without a
 * client-coordinated migration — the only contract is "round-trips through
 * decode + encode unchanged."
 */
export function encodeCursor(payload: { id: string; createdAt: Date }): string {
  const json = JSON.stringify({
    id: payload.id,
    createdAt: payload.createdAt.toISOString(),
  });
  return Buffer.from(json, "utf-8").toString("base64");
}

/**
 * Decode an incoming cursor token. Defense-in-depth: a malformed cursor is
 * a CLIENT error (someone hand-rolled a token or replayed a stale shape),
 * not a server error. Returns null on any decode failure so callers can
 * fall back to "page 1" semantics rather than 500.
 *
 * Why no throw: the input arrives from the public API surface. zod's parse
 * already validates the JSON shape; returning null on failure keeps the
 * route compatible with stale tokens after a hypothetical cursor-format
 * change.
 */
export function decodeCursor(token: string | undefined): CursorPayload | null {
  if (!token) return null;
  try {
    const json = Buffer.from(token, "base64").toString("utf-8");
    const parsed = JSON.parse(json);
    const validated = CursorPayloadSchema.safeParse(parsed);
    if (!validated.success) return null;
    return validated.data;
  } catch {
    return null;
  }
}

/**
 * Build a Prisma `where` fragment for the "page after cursor" clause.
 * Returns an empty object when no cursor is supplied (i.e. first page).
 *
 * Designed to compose with an existing `where` via spread:
 *   const where = { tenantId, ...buildCursorWhere(cursor) };
 *
 * Note: the `createdAtField` parameter lets callers override the column
 * name when the table orders by a non-createdAt timestamp (orders.placedAt).
 */
export function buildCursorWhere(
  cursor: CursorPayload | null,
  createdAtField: string = "createdAt",
): Record<string, unknown> {
  if (!cursor) return {};
  return {
    OR: [
      { [createdAtField]: { lt: new Date(cursor.createdAt) } },
      {
        AND: [
          { [createdAtField]: new Date(cursor.createdAt) },
          { id: { lt: cursor.id } },
        ],
      },
    ],
  };
}

/**
 * Standard list-page input schema piece. Routers spread this into their own
 * input shape:
 *
 *   z.object({
 *     ...listPageInputShape,
 *     search: z.string().optional(),
 *     // ...route-specific filters
 *   })
 *
 * Clamps `limit` to [1, 200] with default 50 to keep pages bounded.
 */
export const listPageInputShape = {
  limit: z.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
};

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 200;
