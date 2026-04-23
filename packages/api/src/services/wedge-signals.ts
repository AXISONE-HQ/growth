/**
 * Wedge Signal Detector — KAN-655 Day-1 Wedge
 *
 * Hardcoded, rule-based signal detection. In-memory only (no Prisma models yet).
 * Replaces full KAN-651 Signal Engine for MVP wedge demo.
 *
 * Location: packages/api/src/services/wedge-signals.ts
 *
 * Signals in MVP catalog (B2B-first per 2026-04-23 consultation):
 *   - inactive_30d           — contact has no activity in 30+ days
 *   - unworked_lead          — lead with no outbound action in 48h+
 *   - low_data_quality       — contact data quality score < 50%  (bonus — surfaces Fred)
 *
 * Deferred to KAN-651 (real Signal Engine): trial_conversion, cart_abandoned,
 * activation, expansion_candidate, etc.
 */

import type { Contact } from '@prisma/client';

export type WedgeSignalType = 'inactive_30d' | 'unworked_lead' | 'low_data_quality';

export interface WedgeSignal {
  type: WedgeSignalType;
  entityId: string;
  confidence: number;
  firedAt: Date;
  reason: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function daysSince(d: Date | null | undefined): number {
  if (!d) return Infinity;
  return (Date.now() - new Date(d).getTime()) / DAY_MS;
}

/**
 * Detect all signals for one contact. Returns an array because a contact
 * can fire multiple signals (e.g., inactive + low data quality).
 */
export function detectSignalsForContact(
  contact: Contact & { lastActivityAt?: Date | null; dataQualityScore?: number | null; lifecycleStage?: string | null }
): WedgeSignal[] {
  const signals: WedgeSignal[] = [];
  const now = new Date();

  // inactive_30d — last activity > 30 days ago (or never)
  const inactiveDays = daysSince(contact.lastActivityAt ?? contact.updatedAt ?? contact.createdAt);
  if (inactiveDays >= 30) {
    signals.push({
      type: 'inactive_30d',
      entityId: contact.id,
      confidence: Math.min(1, inactiveDays / 60), // ramps up to 1.0 at 60d
      firedAt: now,
      reason: `No activity in ${Math.round(inactiveDays)} days`,
    });
  }

  // unworked_lead — lead with no outbound action in 48h+ since creation
  const ageHours = daysSince(contact.createdAt) * 24;
  if (
    (contact.lifecycleStage === 'lead' || contact.lifecycleStage === 'Lead') &&
    ageHours >= 48
  ) {
    signals.push({
      type: 'unworked_lead',
      entityId: contact.id,
      confidence: 0.85,
      firedAt: now,
      reason: `Lead created ${Math.round(ageHours / 24)}d ago with no outbound touch`,
    });
  }

  // low_data_quality — score below 50%
  if (typeof contact.dataQualityScore === 'number' && contact.dataQualityScore < 50) {
    signals.push({
      type: 'low_data_quality',
      entityId: contact.id,
      confidence: 1 - contact.dataQualityScore / 100,
      firedAt: now,
      reason: `Data quality ${contact.dataQualityScore}% — missing fields`,
    });
  }

  return signals;
}

/**
 * Batch detect signals for all contacts in a tenant.
 * Caller passes the full list already fetched from Prisma.
 */
export function detectSignals(contacts: Array<Contact & Record<string, unknown>>): WedgeSignal[] {
  return contacts.flatMap((c) => detectSignalsForContact(c as any));
}
