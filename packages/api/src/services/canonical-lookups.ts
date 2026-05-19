/**
 * KAN-932 — Canonical entity lookups (shared resolver helpers).
 *
 * Lifted from `import-commit.ts` so the same resolver helpers can be
 * reused by Cohort 3 manual CRUD forms (FK validation in `<entity>.create`
 * / `.update` procedures) without going through the import pipeline.
 *
 * Pure refactor: zero behavior change. The original functions are
 * re-exported from `import-commit.ts` for backwards compat with the 7+
 * existing internal call sites (commitContact / commitCompany /
 * commitDeal / commitOrder / various test surfaces) — see KAN-922 +
 * KAN-921 + KAN-930 for the prior evolution of these resolvers.
 *
 * No `tx: Prisma.TransactionClient` requirement — all queries take a
 * standard `PrismaClient`. Callers inside import-commit's per-row
 * `$transaction` cast `tx as unknown as PrismaClient`; manual-form
 * callers pass `ctx.prisma` directly.
 *
 * **KAN-925** — JSON expression indexes on contacts.external_ids
 * deferred. Single-tenant scans under 10K contacts remain acceptable;
 * revisit when a tenant crosses that threshold. KAN-930 pre-cache
 * sidesteps the issue for runCommit; manual-form lookups use the cache=
 * undefined backwards-compat path (one query per call).
 */
import type { PrismaClient } from "@prisma/client";

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type ContactResolveKey =
  | { kind: "email"; value: string | null | undefined }
  | { kind: "phone"; value: string | null | undefined }
  | { kind: "external_id"; source: string; value: string | null | undefined };

export type DealResolveKey =
  | { kind: "external_id"; source: string; value: string | null | undefined };

// ─────────────────────────────────────────────
// Contact lookups
// ─────────────────────────────────────────────

/**
 * KAN-922 — Generalized contact resolver. Supports email / phone /
 * external_id match keys.
 *
 * For 'external_id': uses Prisma's JSON path filter
 * `{ externalIds: { path: [source], equals: value } }` with KAN-921
 * multi-value split (semicolon / comma / pipe delimiters).
 *
 * KAN-930 — Optional pre-built cache keyed by externalSourceTag value.
 * When populated, the external_id branch does O(1) `Map.get` instead of
 * O(N) seqscan. `undefined` (param not passed) or `null` (sentinel-bailed)
 * → use DB path. Manual-form callers pass nothing; runCommit passes
 * the cache.
 */
export async function resolveContactByMatchKey(
  prisma: PrismaClient,
  tenantId: string,
  key: ContactResolveKey,
  cache?: Map<string, string> | null,
): Promise<{ id: string } | null> {
  if (!key.value) return null;
  switch (key.kind) {
    case "email":
      return prisma.contact.findFirst({
        where: { tenantId, email: { equals: key.value, mode: "insensitive" } },
        select: { id: true },
      });
    case "phone":
      return prisma.contact.findFirst({
        where: { tenantId, phone: key.value },
        select: { id: true },
      });
    case "external_id": {
      const candidates = key.value
        .split(/[;,|]/)
        .map((v) => v.trim())
        .filter(Boolean);
      if (candidates.length === 0) return null;
      if (cache) {
        for (const v of candidates) {
          const id = cache.get(v);
          if (id) return { id };
        }
        return null;
      }
      return prisma.contact.findFirst({
        where: {
          tenantId,
          OR: candidates.map((v) => ({
            externalIds: { path: [key.source], equals: v },
          })),
        },
        select: { id: true },
      });
    }
  }
}

/** KAN-922 — Backwards-compatible wrapper. 7+ existing call sites
 *  continue working unchanged. Delegates to resolveContactByMatchKey. */
export async function resolveContactByEmail(
  prisma: PrismaClient,
  tenantId: string,
  email: string | null | undefined,
): Promise<{ id: string } | null> {
  return resolveContactByMatchKey(prisma, tenantId, { kind: "email", value: email });
}

// ─────────────────────────────────────────────
// Deal lookups
// ─────────────────────────────────────────────

/** KAN-922 — Deal resolver. KAN-921 multi-value split + KAN-930 cache
 *  symmetric to resolveContactByMatchKey. */
export async function resolveDealByMatchKey(
  prisma: PrismaClient,
  tenantId: string,
  key: DealResolveKey,
  cache?: Map<string, string> | null,
): Promise<{ id: string } | null> {
  if (!key.value) return null;
  switch (key.kind) {
    case "external_id": {
      const candidates = key.value
        .split(/[;,|]/)
        .map((v) => v.trim())
        .filter(Boolean);
      if (candidates.length === 0) return null;
      if (cache) {
        for (const v of candidates) {
          const id = cache.get(v);
          if (id) return { id };
        }
        return null;
      }
      return prisma.deal.findFirst({
        where: {
          tenantId,
          OR: candidates.map((v) => ({
            externalIds: { path: [key.source], equals: v },
          })),
        },
        select: { id: true },
      });
    }
  }
}

// ─────────────────────────────────────────────
// Pipeline + Stage lookups
// ─────────────────────────────────────────────

/** Look up a Pipeline by name within a tenant. When `name` is empty
 *  OR no Pipeline matches, falls back to the tenant's default Pipeline
 *  (first active Pipeline by createdAt asc). Returns null if the
 *  tenant has no Pipelines at all. */
export async function resolvePipelineByName(
  prisma: PrismaClient,
  tenantId: string,
  name: string | null | undefined,
): Promise<{ id: string } | null> {
  if (name && name.trim()) {
    const byName = await prisma.pipeline.findFirst({
      where: { tenantId, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (byName) return byName;
  }
  return prisma.pipeline.findFirst({
    where: { tenantId, isActive: true },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
}

/** Look up a Stage by name within a Pipeline. When `name` is empty OR
 *  no Stage matches, falls back to the Pipeline's `isInitial=true`
 *  Stage. Returns null if the Pipeline has no stages at all. */
export async function resolveStageByName(
  prisma: PrismaClient,
  pipelineId: string,
  name: string | null | undefined,
): Promise<{ id: string } | null> {
  if (name && name.trim()) {
    const byName = await prisma.stage.findFirst({
      where: { pipelineId, name: { equals: name, mode: "insensitive" } },
      select: { id: true },
    });
    if (byName) return byName;
  }
  return (
    (await prisma.stage.findFirst({
      where: { pipelineId, isInitial: true },
      select: { id: true },
    })) ??
    (await prisma.stage.findFirst({
      where: { pipelineId },
      orderBy: { order: "asc" },
      select: { id: true },
    }))
  );
}

// ─────────────────────────────────────────────
// Company lookup
// ─────────────────────────────────────────────

/** Optional Company lookup by name within tenant. Returns null on miss
 *  — Company linkage on Contact/Deal/Order is optional, so a miss just
 *  leaves the relation unset (no error). */
export async function resolveCompanyByName(
  prisma: PrismaClient,
  tenantId: string,
  name: string | null | undefined,
): Promise<{ id: string } | null> {
  if (!name || !name.trim()) return null;
  return prisma.company.findFirst({
    where: { tenantId, name: { equals: name, mode: "insensitive" } },
    select: { id: true },
  });
}
