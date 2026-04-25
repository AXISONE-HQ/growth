/**
 * Per-tenant email suppression — Prisma-backed (KAN-661 / KAN-454 era).
 *
 * Used by the Resend adapter simple-mode path and the /unsubscribe handler.
 * The Redis-backed cache that previously lived here was bound to the SendGrid
 * event-webhook flow (deferred to KAN-684 in the Resend rewrite); when that
 * flow is reimplemented for Resend webhooks, a similar fast-path cache can be
 * added back if the API rate limits warrant it.
 */

import { logger } from '../../logger.js';
import { prisma } from '../../repository/connection-repository.js';

export type DbSuppressionReason = 'bounce' | 'spam' | 'unsubscribed' | 'manual';

function normalize(email: string): string {
  return email.trim().toLowerCase();
}

export async function isSuppressedDb(
  tenantId: string,
  email: string,
): Promise<{ suppressed: true; reason: string } | { suppressed: false }> {
  const normalized = normalize(email);
  const row = await prisma.emailSuppression.findUnique({
    where: { tenantId_email: { tenantId, email: normalized } },
  });
  if (!row) return { suppressed: false };
  return { suppressed: true, reason: row.reason };
}

export async function suppressDb(
  tenantId: string,
  email: string,
  reason: DbSuppressionReason,
): Promise<void> {
  const normalized = normalize(email);
  await prisma.emailSuppression.upsert({
    where: { tenantId_email: { tenantId, email: normalized } },
    create: { tenantId, email: normalized, reason },
    update: {}, // first-write-wins; don't overwrite the original reason
  });
  logger.info({ tenantId, email: normalized, reason }, 'email suppressed (db)');
}
