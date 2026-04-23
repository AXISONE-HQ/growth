/**
 * Wedge Opportunity Matcher — KAN-655 Day-1 Wedge
 *
 * Hardcoded mapping: signals → opportunity types → grouped contacts.
 * Replaces full KAN-652 Opportunity Discovery for MVP wedge demo.
 *
 * Location: packages/api/src/services/wedge-opportunities.ts
 *
 * Catalog (B2B-first, per 2026-04-23 ChatGPT consultation):
 *   - dormant_reactivation  — contacts that haven't engaged in 30+ days
 *   - high_intent_no_touch  — leads that haven't been worked
 *   - data_enrichment       — contacts with incomplete profiles (housekeeping opp)
 *
 * Deferred to KAN-652 (real Discovery): trial_conversion, winback, activation,
 * upsell, at_risk. These require richer signal data that doesn't exist yet on
 * AxisOne's HubSpot contacts.
 */

import type { WedgeSignal, WedgeSignalType } from './wedge-signals';

export type WedgeOpportunityType =
  | 'dormant_reactivation'
  | 'high_intent_no_touch'
  | 'data_enrichment';

export interface WedgeOpportunity {
  type: WedgeOpportunityType;
  displayName: string;
  entityIds: string[];
  estimatedPopulation: number;
  reasoning: string;
  signalSource: WedgeSignalType;
  /** Playbook slug that will run if this opportunity is launched. */
  playbookSlug: string;
}

/**
 * Fixed mapping — signal type → opportunity type + display name + playbook.
 * If we add a signal, we add a row here. No LLM.
 */
const SIGNAL_TO_OPPORTUNITY: Record<
  WedgeSignalType,
  { opportunity: WedgeOpportunityType; displayName: string; playbookSlug: string }
> = {
  inactive_30d: {
    opportunity: 'dormant_reactivation',
    displayName: 'Dormant Reactivation',
    playbookSlug: 'dormant_reactivation_14d',
  },
  unworked_lead: {
    opportunity: 'high_intent_no_touch',
    displayName: 'High Intent — No Touch',
    playbookSlug: 'high_intent_follow_up',
  },
  low_data_quality: {
    opportunity: 'data_enrichment',
    displayName: 'Data Enrichment',
    playbookSlug: 'data_enrichment_request',
  },
};

/**
 * Group signals into opportunities. One opportunity per type, with all
 * matching entity IDs collected.
 */
export function matchOpportunities(signals: WedgeSignal[]): WedgeOpportunity[] {
  // Group by opportunity type
  const grouped = new Map<WedgeOpportunityType, Set<string>>();
  const reasons = new Map<WedgeOpportunityType, string[]>();
  const signalSources = new Map<WedgeOpportunityType, WedgeSignalType>();

  for (const signal of signals) {
    const mapping = SIGNAL_TO_OPPORTUNITY[signal.type];
    if (!mapping) continue;

    if (!grouped.has(mapping.opportunity)) {
      grouped.set(mapping.opportunity, new Set());
      reasons.set(mapping.opportunity, []);
      signalSources.set(mapping.opportunity, signal.type);
    }
    grouped.get(mapping.opportunity)!.add(signal.entityId);
    reasons.get(mapping.opportunity)!.push(signal.reason);
  }

  const result: WedgeOpportunity[] = [];
  for (const [type, entityIds] of grouped.entries()) {
    const signalType = signalSources.get(type)!;
    const mapping = SIGNAL_TO_OPPORTUNITY[signalType];
    result.push({
      type,
      displayName: mapping.displayName,
      entityIds: Array.from(entityIds),
      estimatedPopulation: entityIds.size,
      reasoning: reasonSummary(type, entityIds.size, reasons.get(type) ?? []),
      signalSource: signalType,
      playbookSlug: mapping.playbookSlug,
    });
  }

  // Sort by population descending — biggest opportunity first
  return result.sort((a, b) => b.estimatedPopulation - a.estimatedPopulation);
}

function reasonSummary(type: WedgeOpportunityType, count: number, reasons: string[]): string {
  const first = reasons[0] ?? '';
  const contactWord = count === 1 ? 'contact' : 'contacts';
  switch (type) {
    case 'dormant_reactivation':
      return `${count} ${contactWord} have gone cold. ${first}.`;
    case 'high_intent_no_touch':
      return `${count} ${contactWord} came in as leads and haven't been worked. ${first}.`;
    case 'data_enrichment':
      return `${count} ${contactWord} have incomplete profiles blocking better outreach. ${first}.`;
    default:
      return `${count} ${contactWord} matched. ${first}.`;
  }
}
