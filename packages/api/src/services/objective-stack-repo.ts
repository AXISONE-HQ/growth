/**
 * KAN-959 — Objective Stack repository (slice 1 of Objectives → AI Pipeline).
 *
 * Entity-agnostic operations over the prioritized objective stack. Slice 1
 * targets Contact only (the `contact_objective_stack` table); slice 5 will
 * extend this repo with Order/Company variants that share the operation
 * surface.
 *
 * Architecture (locked): narrow per-entity tables, not polymorphic. Each
 * operation here switches on `entityType` to route to the right Prisma
 * delegate. Adding `order` or `company` becomes a switch-case extension,
 * never a logic rewrite.
 *
 * All priority/fallback/gap logic lives here so future engine slices
 * (Brain objective-awareness, fallback-to-secondary) read a single shape.
 */
import type { PrismaClient } from "@prisma/client";
import type { ObjectiveStackEntry, ObjectiveStackStatus } from "@growth/shared";

export type StackEntityType = "contact"; // slice 5 expands

/**
 * Load the stack for an entity, ordered by priority ASC (primary first).
 * Filters out terminal statuses (`achieved | abandoned | superseded`) unless
 * `includeTerminal` is true.
 *
 * Future Brain objective-aware loop (slice 4) walks priority ASC and pursues
 * the FIRST non-blocked, non-achieved entry.
 */
export async function getActiveByPriority(
  prisma: PrismaClient,
  entityType: StackEntityType,
  entityId: string,
  tenantId: string,
  opts: { includeTerminal?: boolean } = {},
): Promise<ObjectiveStackEntry[]> {
  const terminalStatuses: ObjectiveStackStatus[] = [
    "achieved",
    "abandoned",
    "superseded",
  ];
  const where: Record<string, unknown> = { tenantId };
  if (entityType === "contact") {
    where.contactId = entityId;
  } else {
    throw new Error(
      `[objective-stack-repo] unsupported entityType '${entityType as string}' — slice 5 will add order/company`,
    );
  }
  if (!opts.includeTerminal) {
    where.status = { notIn: terminalStatuses };
  }

  const rows = await (prisma as unknown as {
    contactObjectiveStack: {
      findMany: (args: unknown) => Promise<unknown[]>;
    };
  }).contactObjectiveStack.findMany({
    where,
    orderBy: [{ priority: "asc" }, { activatedAt: "asc" }],
  });

  return (rows as Array<Record<string, unknown>>).map((r) =>
    mapRow(entityType, entityId, r),
  );
}

/**
 * Mark a stack entry as blocked. Sets `blockedSinceAt = now()` + a reason
 * string. Reversible via `reactivate`.
 *
 * Slice 4 (Brain objective-awareness) calls this when sub-objective failure
 * or retry exhaustion blocks the primary objective.
 */
export async function markBlocked(
  prisma: PrismaClient,
  stackId: string,
  reason: string,
): Promise<ObjectiveStackEntry> {
  const row = await (prisma as unknown as {
    contactObjectiveStack: {
      update: (args: unknown) => Promise<unknown>;
    };
  }).contactObjectiveStack.update({
    where: { id: stackId },
    data: {
      status: "blocked",
      blockedReason: reason,
      blockedSinceAt: new Date(),
      lastEvaluatedAt: new Date(),
    },
  });
  const r = row as Record<string, unknown>;
  return mapRow("contact", r.contactId as string, r);
}

/**
 * Mark a stack entry as achieved. Sets `achievedAt = now()`. Future Brain
 * loop calls this when `successCondition` evaluates true (slice 4).
 */
export async function markAchieved(
  prisma: PrismaClient,
  stackId: string,
): Promise<ObjectiveStackEntry> {
  const row = await (prisma as unknown as {
    contactObjectiveStack: {
      update: (args: unknown) => Promise<unknown>;
    };
  }).contactObjectiveStack.update({
    where: { id: stackId },
    data: {
      status: "achieved",
      achievedAt: new Date(),
      lastEvaluatedAt: new Date(),
    },
  });
  const r = row as Record<string, unknown>;
  return mapRow("contact", r.contactId as string, r);
}

/**
 * Reverse a `blocked` (or `paused`) status back to `active`. The whole point
 * of the stack: a blocked objective can return to play once the gate clears.
 *
 * Clears `blockedReason` + `blockedSinceAt`; preserves `activatedAt`.
 */
export async function reactivate(
  prisma: PrismaClient,
  stackId: string,
): Promise<ObjectiveStackEntry> {
  const row = await (prisma as unknown as {
    contactObjectiveStack: {
      update: (args: unknown) => Promise<unknown>;
    };
  }).contactObjectiveStack.update({
    where: { id: stackId },
    data: {
      status: "active",
      blockedReason: null,
      blockedSinceAt: null,
      lastEvaluatedAt: new Date(),
    },
  });
  const r = row as Record<string, unknown>;
  return mapRow("contact", r.contactId as string, r);
}

/**
 * Internal: map a raw Prisma row → entity-agnostic ObjectiveStackEntry.
 * Slice 5 extends the switch to handle order/company rows.
 */
function mapRow(
  entityType: StackEntityType,
  entityId: string,
  row: Record<string, unknown>,
): ObjectiveStackEntry {
  return {
    id: row.id as string,
    tenantId: row.tenantId as string,
    entityType,
    entityId,
    objectiveId: row.objectiveId as string,
    priority: row.priority as number,
    status: row.status as ObjectiveStackStatus,
    subObjectives: row.subObjectives,
    strategyCurrent: (row.strategyCurrent as string | null) ?? null,
    confidenceScore: (row.confidenceScore as number | null) ?? null,
    achievedAt: (row.achievedAt as Date | null) ?? null,
    blockedReason: (row.blockedReason as string | null) ?? null,
    blockedSinceAt: (row.blockedSinceAt as Date | null) ?? null,
    activatedAt: row.activatedAt as Date,
    lastEvaluatedAt: row.lastEvaluatedAt as Date,
  };
}
