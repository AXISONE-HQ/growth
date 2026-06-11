/**
 * KAN-1167 — Shared audit-log writer.
 *
 * Replaces the 6 inline copies of writeAuditBestEffort that accumulated
 * across the codebase (KAN-1150 escalation pressure). This PR creates the
 * helper and uses it from `campaigns.setGoal`; KAN-1168 (immediate follow-up
 * PR) migrates the 6 existing inline copies and closes KAN-1150.
 *
 * # Best-effort semantics
 *
 * Audit-log write failures are LOGGED but NOT thrown. The audit-log table is
 * downstream of every mutation procedure; an audit failure must never break
 * the caller's user-facing path. Matches the canonical pattern from
 * packages/api/src/services/lead-normalizer.ts:453.
 *
 * # Object-arg signature
 *
 * Existing inline copies use 4-arg (lead-normalizer; actor hardcoded) and
 * 5-arg positional shapes (parse-rule-service et al.). The shared helper
 * adopts an object-arg signature for extensibility (e.g., the optional
 * `reasoning` field, future fields like `correlationId`). KAN-1168 migrates
 * the 6 existing callsites to this shape.
 */
import type { PrismaClient } from '@prisma/client';

export interface WriteAuditBestEffortParams {
  tenantId: string;
  /** User ID for human actors; namespaced 'system:*' string for system actors. */
  actor: string;
  /** Dotted action namespace, e.g. 'campaign.goal_set', 'pipeline.deleted_empty'. */
  actionType: string;
  /** Free-form structured payload. Avoid PII; hash long free-text fields. */
  payload: Record<string, unknown>;
  /** Optional human-readable rationale (1-2 sentences). */
  reasoning?: string;
}

/**
 * Best-effort audit write. Returns void; never throws.
 *
 * Sequenced AFTER the mutation it audits (post-commit). For atomic audit
 * coupling (audit row rolled back with the mutation), use `tx.auditLog.create`
 * directly inside a `prisma.$transaction` block — the helper is for the
 * common-case best-effort lineage where audit failure is non-fatal.
 */
export async function writeAuditBestEffort(
  prisma: PrismaClient,
  params: WriteAuditBestEffortParams,
): Promise<void> {
  try {
    await (
      prisma as unknown as {
        auditLog: {
          create: (args: {
            data: Record<string, unknown>;
          }) => Promise<unknown>;
        };
      }
    ).auditLog.create({
      data: {
        tenantId: params.tenantId,
        actor: params.actor,
        actionType: params.actionType,
        payload: params.payload,
        ...(params.reasoning !== undefined ? { reasoning: params.reasoning } : {}),
      },
    });
  } catch (err) {
    // Best-effort: never propagate. The mutation that prompted this audit
    // already succeeded; failing the procedure on an audit-log write would
    // surface a confusing user-facing error.
    console.error('[writeAuditBestEffort] FAILED', {
      actionType: params.actionType,
      tenantId: params.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
