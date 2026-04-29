/**
 * KAN-718 Day 10 — AuditLog router service.
 *
 * Replaces the broken pre-KAN-689 `auditLogRouter` (snake_case + non-existent
 * `category` field). The canonical AuditLog schema (per
 * `packages/db/prisma/schema.prisma`) has:
 *   id, tenantId, actor, actionType, payload, reasoning, createdAt
 *
 * Operator-relevant filter (default): excludes infrastructure-only event
 * classes that fire on every server restart and would drown the operator
 * signal. Today the noisy class is `brain.blueprint_*` (fires on app boot
 * + on AI Brain config reload). KAN-758 (Sprint 5+ Low) adds an admin
 * toggle to "show infrastructure-level audit" when needed for debugging.
 */
import { TRPCError } from '@trpc/server';
import type { PrismaClient } from '@prisma/client';

export interface ListInput {
  /** When false (default), filters out infrastructure-only event classes. */
  includeInfrastructure?: boolean;
  /**
   * Optional actionType prefix filter — e.g., 'recommendation.' to see only
   * /escalations operator activity, or 'csv.' to see only bulk imports.
   */
  actionTypePrefix?: string;
  limit?: number;
  offset?: number;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

/**
 * actionType prefixes hidden by default. The `brain.blueprint_*` events
 * fire on every server restart (and again on every AI config reload) — they
 * drown the operator-relevant signal. Keep narrow: only filter event classes
 * that are clearly infrastructure-only with no operator value.
 */
const INFRASTRUCTURE_ONLY_PREFIXES = ['brain.blueprint_'];

function clampLimit(limit: number | undefined): number {
  if (limit == null) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, limit));
}

export async function listAuditLog(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
) {
  const limit = clampLimit(input.limit);
  const offset = Math.max(0, input.offset ?? 0);

  // Base where: tenant scope + optional prefix filter at SQL level.
  const where: Record<string, unknown> = { tenantId };
  if (input.actionTypePrefix) {
    where.actionType = { startsWith: input.actionTypePrefix };
  }

  // Operator-relevant filter applied as a separate `NOT` clause to
  // exclude infrastructure-only prefixes. Default-on; admin can flip.
  if (!input.includeInfrastructure) {
    where.NOT = INFRASTRUCTURE_ONLY_PREFIXES.map((p) => ({
      actionType: { startsWith: p },
    }));
  }

  const [rows, total] = await Promise.all([
    prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.auditLog.count({ where }),
  ]);

  return {
    items: rows.map((r) => ({
      id: r.id,
      actor: r.actor,
      actionType: r.actionType,
      payload: r.payload,
      reasoning: r.reasoning,
      createdAt: r.createdAt,
    })),
    total,
    limit,
    offset,
    /** Echoed back so the UI can render the active filter posture. */
    includeInfrastructure: input.includeInfrastructure ?? false,
  };
}

export async function getAuditLogEntry(
  prisma: PrismaClient,
  tenantId: string,
  id: string,
) {
  const row = await prisma.auditLog.findFirst({
    where: { id, tenantId },
  });
  if (!row) {
    // Cross-tenant access also lands here — neutral NOT_FOUND, no leak.
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Audit log entry not found' });
  }
  return {
    id: row.id,
    actor: row.actor,
    actionType: row.actionType,
    payload: row.payload,
    reasoning: row.reasoning,
    createdAt: row.createdAt,
  };
}
