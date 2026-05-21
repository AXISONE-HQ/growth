/**
 * KAN-962 (slice 2a) — reusable objective + pipeline naming/reasoning
 * via a single Haiku call.
 *
 * **Scope**: the LLM-bearing part of the proposer chain. Deterministic
 * segment counts are owned by `segment-counts.ts`; `pipeline-proposer.ts`
 * orchestrates counts + this module. Keeping the LLM-call seam isolated
 * makes the cost-tracking + fallback path easy to reason about, and
 * lets slice 2b (daily scheduled discovery) reuse this exact function.
 *
 * **Cost discipline** (per KAN-745):
 * - Single `cheap` tier (Haiku 4.5) call per propose, ~0.1-0.3¢
 * - Cost emission via existing llm.call Pub/Sub topic (handled by
 *   llm-client.ts; no producer work here)
 *
 * **Fallback discipline** (per Phase-1 audit Q4):
 * - LLM failure (timeout / 401 / parse error) → hardcoded fallback
 *   strings per objective type
 * - Hardcoded fallbacks for `enrich_lead` + `recover_failed_payment`
 *   which don't map cleanly onto GENERIC_BLUEPRINT journeys
 */
import type { ProposedPipeline, PipelineSegment } from "@growth/shared";

/**
 * What the proposer needs to make a single (objective × segment) naming
 * + reasoning decision. Counts + sufficiency are computed upstream by
 * pipeline-proposer.ts.
 */
export interface ObjectiveProposalInput {
  objectiveType: string;
  objectiveName: string;
  segment: PipelineSegment;
  segmentCount: number;
  sufficiency: "ready" | "needs_more_data";
  /** AccountProfile-derived signal — small JSON for prompt context. */
  accountContext: {
    industry: string | null;
    timeZone: string | null;
    defaultLanguage: string | null;
  };
}

/**
 * What the LLM returns for one (objective × segment) decision.
 * `proposedStages` shape mirrors the Stage create payload so the UI
 * can hand it to `pipelines.create` verbatim on Adopt.
 */
export interface ObjectiveProposalOutput {
  proposedName: string;
  reason: string;
  proposedStages: ProposedPipeline["proposedStages"];
}

// ─────────────────────────────────────────────────────────────────────
// Hardcoded fallback table — used on LLM failure + for objective types
// that don't map onto GENERIC_BLUEPRINT (enrich_lead, recover_failed_payment).
// Per Phase-1 Q4: keep these in code (not config) so re-tuning shows up
// in audit + memory.
// ─────────────────────────────────────────────────────────────────────

const STAGES_BOOK_APPOINTMENT: ObjectiveProposalOutput["proposedStages"] = [
  { name: "New",        order: 0, isInitial: true,  isTerminal: false, outcomeType: "open" },
  { name: "Reached",    order: 1, isInitial: false, isTerminal: false, outcomeType: "open" },
  { name: "Demo Set",   order: 2, isInitial: false, isTerminal: false, outcomeType: "open" },
  { name: "Demo Held",  order: 3, isInitial: false, isTerminal: true,  outcomeType: "terminal_won" },
  { name: "No-show",    order: 4, isInitial: false, isTerminal: true,  outcomeType: "terminal_lost" },
];

const STAGES_WINBACK: ObjectiveProposalOutput["proposedStages"] = [
  { name: "Identified",      order: 0, isInitial: true,  isTerminal: false, outcomeType: "open" },
  { name: "First Outreach",  order: 1, isInitial: false, isTerminal: false, outcomeType: "open" },
  { name: "Re-engaged",      order: 2, isInitial: false, isTerminal: true,  outcomeType: "terminal_won" },
  { name: "No Response",     order: 3, isInitial: false, isTerminal: true,  outcomeType: "terminal_lost" },
];

const STAGES_ENRICH: ObjectiveProposalOutput["proposedStages"] = [
  { name: "Incomplete",        order: 0, isInitial: true,  isTerminal: false, outcomeType: "open" },
  { name: "Reached for Info",  order: 1, isInitial: false, isTerminal: false, outcomeType: "open" },
  { name: "Enriched",          order: 2, isInitial: false, isTerminal: true,  outcomeType: "terminal_won" },
  { name: "Stale",             order: 3, isInitial: false, isTerminal: true,  outcomeType: "terminal_lost" },
];

const STAGES_RETAIN: ObjectiveProposalOutput["proposedStages"] = [
  { name: "Healthy",        order: 0, isInitial: true,  isTerminal: false, outcomeType: "open" },
  { name: "At Risk",        order: 1, isInitial: false, isTerminal: false, outcomeType: "open" },
  { name: "Saved",          order: 2, isInitial: false, isTerminal: true,  outcomeType: "terminal_won" },
  { name: "Churned",        order: 3, isInitial: false, isTerminal: true,  outcomeType: "terminal_lost" },
];

const STAGES_UPSELL: ObjectiveProposalOutput["proposedStages"] = [
  { name: "Eligible",         order: 0, isInitial: true,  isTerminal: false, outcomeType: "open" },
  { name: "Pitched",          order: 1, isInitial: false, isTerminal: false, outcomeType: "open" },
  { name: "Expanded",         order: 2, isInitial: false, isTerminal: true,  outcomeType: "terminal_won" },
  { name: "Declined",         order: 3, isInitial: false, isTerminal: true,  outcomeType: "terminal_lost" },
];

const STAGES_FAILED_PAYMENT: ObjectiveProposalOutput["proposedStages"] = [
  { name: "Payment Failed",   order: 0, isInitial: true,  isTerminal: false, outcomeType: "open" },
  { name: "Retry Attempted",  order: 1, isInitial: false, isTerminal: false, outcomeType: "open" },
  { name: "Recovered",        order: 2, isInitial: false, isTerminal: true,  outcomeType: "terminal_won" },
  { name: "Written Off",      order: 3, isInitial: false, isTerminal: true,  outcomeType: "terminal_lost" },
];

const STAGES_DEFAULT: ObjectiveProposalOutput["proposedStages"] = [
  { name: "New",       order: 0, isInitial: true,  isTerminal: false, outcomeType: "open" },
  { name: "Working",   order: 1, isInitial: false, isTerminal: false, outcomeType: "open" },
  { name: "Won",       order: 2, isInitial: false, isTerminal: true,  outcomeType: "terminal_won" },
  { name: "Lost",      order: 3, isInitial: false, isTerminal: true,  outcomeType: "terminal_lost" },
];

function fallbackStages(objectiveType: string): ObjectiveProposalOutput["proposedStages"] {
  switch (objectiveType) {
    case "book_appointment":
      return STAGES_BOOK_APPOINTMENT;
    case "sell_online":
      // online sale is conversion-shaped; book_appointment template fits closely
      return STAGES_BOOK_APPOINTMENT;
    case "enrich_lead":
      return STAGES_ENRICH;
    case "warm_up":
      return STAGES_BOOK_APPOINTMENT;
    case "reactivate":
      return STAGES_WINBACK;
    case "retain_customer":
      return STAGES_RETAIN;
    case "upsell":
      return STAGES_UPSELL;
    case "recover_failed_payment":
      return STAGES_FAILED_PAYMENT;
    default:
      return STAGES_DEFAULT;
  }
}

function fallbackName(objectiveType: string, segment: PipelineSegment): string {
  switch (objectiveType) {
    case "book_appointment":
      return segment === "new_leads" ? "Book Demo — New Leads" : `Book Demo — ${segment}`;
    case "sell_online":
      return "Online Sale — New Leads";
    case "enrich_lead":
      return "Enrich Incomplete Leads";
    case "warm_up":
      return "Warm Up — New Leads";
    case "reactivate":
      return "Winback — Inactive Customers";
    case "retain_customer":
      return "Retain — At-Risk Customers";
    case "upsell":
      return "Upsell — Active Customers";
    case "recover_failed_payment":
      return "Recover Failed Payments";
    default:
      return `${objectiveType} — ${segment}`;
  }
}

function fallbackReason(input: ObjectiveProposalInput): string {
  const { objectiveType, segment, segmentCount, sufficiency } = input;
  if (sufficiency === "needs_more_data") {
    // Honest message — the count itself surfaces in the UI separately
    // via segment-counts.neededMessage; this is the "why we'd run it" line
    switch (objectiveType) {
      case "book_appointment":
      case "sell_online":
      case "warm_up":
        return "When fresh inbound leads arrive, route them through a structured sequence that ends with a meeting booked.";
      case "enrich_lead":
        return "Identify contacts with thin data and run a structured outreach to fill the gaps before they're handed to sales.";
      case "reactivate":
        return "Reach back out to contacts who went quiet — minimum data needed to identify the inactive cohort first.";
      case "retain_customer":
        return "Spot at-risk customers early and run a structured save flow before they churn.";
      case "upsell":
        return "Identify active customers ready for expansion and pitch the next tier.";
      case "recover_failed_payment":
        return "When a payment fails or a card expires, run a structured recovery sequence (reminder → retry → manual outreach).";
      default:
        return `Pursue ${objectiveType} via a structured ${segment} pipeline.`;
    }
  }
  // ready — emphasize the data signal
  switch (objectiveType) {
    case "book_appointment":
    case "sell_online":
    case "warm_up":
      return `${segmentCount} recent leads ready to be routed — a structured book-demo flow converts them faster than ad-hoc.`;
    case "enrich_lead":
      return `${segmentCount} contacts have thin data — a structured enrichment flow fills the gaps before sales engages.`;
    case "reactivate":
      return `${segmentCount} customers have gone quiet — a winback flow can re-engage them with targeted messaging.`;
    case "retain_customer":
      return `${segmentCount} active customers — a structured retention flow spots at-risk accounts before churn.`;
    case "upsell":
      return `${segmentCount} active customers may be ready for expansion — a pitched upsell flow surfaces the candidates.`;
    case "recover_failed_payment":
      return `${segmentCount} orders failed or cancelled — a structured recovery flow can save a portion of revenue.`;
    default:
      return `${segmentCount} ${segment} records ready for a structured ${objectiveType} pipeline.`;
  }
}

/**
 * Build a single proposal (name + reason + stages) for one
 * (objective × segment) tuple. LLM-backed in the production caller;
 * pure-function fallback for unit tests + LLM failure paths.
 *
 * This is the SYNCHRONOUS fallback. The async LLM-backed version lives
 * inside pipeline-proposer.ts (which composes counts + LLM call). We
 * keep the fallback function here so tests + the LLM-failure branch
 * share the exact same code path.
 */
export function fallbackProposal(
  input: ObjectiveProposalInput,
): ObjectiveProposalOutput {
  return {
    proposedName: fallbackName(input.objectiveType, input.segment),
    reason: fallbackReason(input),
    proposedStages: fallbackStages(input.objectiveType),
  };
}
