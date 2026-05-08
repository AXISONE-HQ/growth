/**
 * KAN-829 sub-cohort 1 — Tier-gating limits for the Knowledge Sources admin UI.
 *
 * Pure module. Maps `Tenant.planTier` (DB enum-as-String column per
 * `packages/db/prisma/schema.prisma:26`) → user-facing limits the UI uses
 * to render upgrade prompts and the backend enforces server-side.
 *
 * **Vocab mapping (pragmatic alignment per pre-flight Decision 3):**
 *
 * | DB column     | PRD tier    | Limits                                    |
 * |---------------|-------------|-------------------------------------------|
 * | `free`        | Starter     | 1 paste-text source, 50K chars, no PDF    |
 * | `starter`     | Starter     | Same as free (treated as synonyms)        |
 * | `pro`         | Growth      | 5 sources, 5MB PDF, all categories        |
 * | `enterprise`  | Revenue     | Effectively unlimited, 10MB PDF           |
 * | (anything else) | Starter   | Safe default — don't crash on enum drift  |
 *
 * **KAN-XXX (FAQ first-class):** FAQ is now a separate entity (FaqEntry
 * table, dedicated UI) with no per-tier gating. `allowsFaq` removed from
 * this contract — every tier gets unlimited FAQ entries.
 *
 * **KAN-848 follow-up** tracks the proper enum alignment (rename `pro` →
 * `growth`, `enterprise` → `revenue`, deprecate `free` as `starter` synonym
 * via Prisma migration). Sprint 12+ low priority.
 */

export interface TierLimits {
  /** Hard cap on total non-deleted knowledge_source rows per tenant. */
  maxSources: number;
  /** Max PDF upload size in MB. 0 = PDF disabled for this tier. */
  maxPdfMB: number;
  /** Whether the tier can upload PDF source_type. */
  allowsPdf: boolean;
  /** Categories the tier can assign sources to. Drives the
   *  category radio in the Add Source flow + server-side validation. */
  allowedCategories: string[];
}

const FREE_LIMITS: TierLimits = {
  maxSources: 1,
  maxPdfMB: 0,
  allowsPdf: false,
  allowedCategories: ['general'],
};

const PRO_LIMITS: TierLimits = {
  maxSources: 5,
  maxPdfMB: 5,
  allowsPdf: true,
  allowedCategories: ['general', 'inventory', 'warranty', 'pricing', 'other'],
};

const ENTERPRISE_LIMITS: TierLimits = {
  maxSources: 9999, // effectively unlimited
  maxPdfMB: 10,
  allowsPdf: true,
  allowedCategories: ['general', 'inventory', 'warranty', 'pricing', 'other'],
};

export function tierLimits(planTier: string): TierLimits {
  switch (planTier) {
    case 'free':
    case 'starter':
      return FREE_LIMITS;
    case 'pro':
      return PRO_LIMITS;
    case 'enterprise':
      return ENTERPRISE_LIMITS;
    default:
      // Forward-compat with KAN-848 rename + safe-default on enum drift.
      return FREE_LIMITS;
  }
}
