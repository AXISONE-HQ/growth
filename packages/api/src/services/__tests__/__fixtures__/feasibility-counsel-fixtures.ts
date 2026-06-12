/**
 * KAN-1179 — recorded LLM fixtures for Feasibility Analyzer integration tests.
 *
 * Five TypeScript-typed fixture exports per Q-ADD-D lock (TypeScript modules
 * over JSON files): four LLM-input fixtures (used to mock `complete()`) +
 * one expected-output fixture (used to assert the cold-start deterministic
 * counsel shape; honors the cold-start NO-LLM doctrine).
 *
 * Fixture format note (Q7 + SPO refinement on Phase 1 trace):
 *   - SUFFICIENT_FEASIBLE_FIXTURE   — LLMCompleteResult; achievability='feasible'
 *   - SUFFICIENT_STRETCH_FIXTURE    — LLMCompleteResult; achievability='stretch'
 *   - SUFFICIENT_UNREALISTIC_FIXTURE — LLMCompleteResult; achievability='unrealistic'
 *   - PARTIAL_LOWCONF_FIXTURE       — LLMCompleteResult; low-confidence framing
 *   - COLD_START_EXPECTED           — ColdStartCounsel; assertion target
 *
 * SUFFICIENT_STRETCH + SUFFICIENT_UNREALISTIC are kept for canonical-shape
 * reference + future stretch coverage. The 6 integration scenarios in
 * kan-1179-feasibility-analyzer.test.ts exercise FEASIBLE + PARTIAL_LOWCONF +
 * COLD_START + analyzer_unavailable + idempotent re-run + multi-tenant
 * isolation. Math-bucket variants are unit-tested in PR 2b-core.
 */
import type { LLMCompleteResult } from "../../llm-client.js";
import type { ColdStartCounsel } from "@growth/shared";

// ─────────────────────────────────────────────
// SUFFICIENT_FEASIBLE — exercised by integration scenario #2
// ─────────────────────────────────────────────

export const SUFFICIENT_FEASIBLE_FIXTURE: LLMCompleteResult = {
  text: JSON.stringify({
    achievability: "feasible",
    honestAssessment:
      "Based on your 8% historical conversion rate + 5 deals/month closing velocity " +
      "(35 closed-won deals in the last 12 months), you'll close ~60 deals on current " +
      "trajectory. Your goal of 50 is achievable on the current pace.",
    achievablePaths: [
      {
        label: "Hold Current Pace",
        description: "Maintain your existing conversion + velocity discipline.",
        requiredAction:
          "Keep the weekly lead-acquisition rate at ~5 leads and the current follow-up cadence.",
        estimatedImpact: "Goal achieved on current trajectory.",
      },
      {
        label: "Modest Acceleration",
        description: "Add slight margin for variance.",
        requiredAction:
          "Increase weekly lead acquisition from 5 to 7 to absorb conversion variance.",
        estimatedImpact: "Builds 20-25% buffer against pipeline shocks.",
      },
      {
        label: "Tighten Cycle Time",
        description: "Close deals faster to free capacity.",
        requiredAction:
          "Reduce time-to-close from 30 to 22 days via faster decision-stage follow-ups.",
        estimatedImpact: "Surfaces an additional ~10 deal capacity over the window.",
      },
    ],
  }),
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputTokens: 850,
  outputTokens: 320,
  latencyMs: 1450,
  modelPricingVersion: "v1",
};

// ─────────────────────────────────────────────
// SUFFICIENT_STRETCH — canonical-shape reference; available for future stretch coverage
// ─────────────────────────────────────────────

export const SUFFICIENT_STRETCH_FIXTURE: LLMCompleteResult = {
  text: JSON.stringify({
    achievability: "stretch",
    honestAssessment:
      "Based on your 8% conversion rate and 5 deals/month, you'll close ~60 organically. " +
      "Your goal of 100 is a stretch — 40% short on current trajectory. The three paths " +
      "below show concrete actions to close the gap.",
    achievablePaths: [
      {
        label: "Increase Lead Volume",
        description: "Bring more qualified leads into the top of funnel.",
        requiredAction: "Increase weekly acquisition from 5 to 12 leads.",
        estimatedImpact: "Closes ~60% of the gap if conversion holds at 8%.",
      },
      {
        label: "Improve Conversion",
        description: "Convert more of your current leads.",
        requiredAction: "Reduce lead-to-close cycle by 15 days via faster follow-ups.",
        estimatedImpact: "Closes ~25% of the gap.",
      },
      {
        label: "Extend Window",
        description: "Give the math more time.",
        requiredAction: "Push goal window from 365 to 450 days.",
        estimatedImpact: "Closes the remaining gap on current trajectory.",
      },
    ],
  }),
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputTokens: 920,
  outputTokens: 380,
  latencyMs: 1520,
  modelPricingVersion: "v1",
};

// ─────────────────────────────────────────────
// SUFFICIENT_UNREALISTIC — canonical-shape reference; available for future stretch coverage
// ─────────────────────────────────────────────

export const SUFFICIENT_UNREALISTIC_FIXTURE: LLMCompleteResult = {
  text: JSON.stringify({
    achievability: "unrealistic",
    honestAssessment:
      "Based on your 8% conversion + 5 deals/month velocity, you'll close ~60 organically. " +
      "Your goal of 500 is unrealistic on current trajectory — an 88% gap. No combination " +
      "of the three paths below closes that gap within the goal window. Consider revising " +
      "the goal target, extending the window, or staging it across multiple quarters.",
    achievablePaths: [
      {
        label: "Aggressive Volume + Conversion",
        description: "Combined push at the top + middle of funnel.",
        requiredAction:
          "Increase weekly acquisition from 5 to 25 + cut conversion cycle 50% via faster follow-ups.",
        estimatedImpact: "Closes ~40% of the gap; still 60% short.",
      },
      {
        label: "New Channel Open",
        description: "Add a new lead-gen channel.",
        requiredAction: "Launch outbound program targeting 200 net-new prospects/week.",
        estimatedImpact: "Closes ~25% of the gap if conversion holds.",
      },
      {
        label: "Multi-Quarter Goal Staging",
        description: "Acknowledge the gap; stage it.",
        requiredAction: "Re-scope as a 4-quarter goal at ~125/quarter rather than a single window.",
        estimatedImpact: "Operator-honest framing; achievable on extended timeline.",
      },
    ],
  }),
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputTokens: 1050,
  outputTokens: 420,
  latencyMs: 1680,
  modelPricingVersion: "v1",
};

// ─────────────────────────────────────────────
// PARTIAL_LOWCONF — exercised by integration scenario #3
// ─────────────────────────────────────────────

export const PARTIAL_LOWCONF_FIXTURE: LLMCompleteResult = {
  text: JSON.stringify({
    achievability: "stretch",
    honestAssessment:
      "The historical data is THIN — only 12 closed deals in the last 12 months. The " +
      "projection below is rough; treat the verdict as directional rather than precise. " +
      "On the limited signal, ~20 deals organic vs your goal of 50 = a stretch at 60% gap.",
    achievablePaths: [
      {
        label: "Stabilize Sample Size First",
        description: "Build a more reliable baseline before optimizing.",
        requiredAction:
          "Ship 2-3 Campaigns over the next 60 days to generate ≥30 closed-deal sample.",
        estimatedImpact: "Unlocks confident counsel on the next analyzer run.",
      },
      {
        label: "Modest Volume Increase",
        description: "Cautious push given thin baseline.",
        requiredAction: "Increase weekly acquisition from 3 to 6 leads.",
        estimatedImpact: "Directional ~30% gap reduction at unknown precision.",
      },
      {
        label: "Defer Hard Goal-Setting",
        description: "Wait for sample size to validate.",
        requiredAction: "Revise this goal in 60 days when baseline is firmer.",
        estimatedImpact: "Preserves operator optionality with thin data.",
      },
    ],
  }),
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  inputTokens: 780,
  outputTokens: 350,
  latencyMs: 1280,
  modelPricingVersion: "v1",
};

// ─────────────────────────────────────────────
// COLD_START_EXPECTED — expected analyzer output for cold-start path
//
// NOT an LLM input fixture. The cold-start path has NO LLM call (Phase 1
// Decision 4 + Q-ADD-E doctrine). This fixture is the expected
// ColdStartCounsel shape that the analyzer's deterministic template
// produces; integration scenario #1 asserts deep-equality against it.
// ─────────────────────────────────────────────

export const COLD_START_EXPECTED: ColdStartCounsel = {
  missingDataTypes: [
    "sales_history",
    "customer_base",
    "lead_history",
    "engagement_history",
  ],
  acquisitionRecommendations: [
    {
      dataType: "sales_history",
      operatorActions: [
        "Upload your past 12 months of orders via the CSV import in /imports",
        "Or connect Shopify / Stripe / your billing system via /settings/integrations",
      ],
      expectedUnlock:
        "Enables revenue + units feasibility counsel with high confidence after ≥30 closed deals + ≥90 days of order history.",
    },
    {
      dataType: "customer_base",
      operatorActions: [
        "Sync your CRM (HubSpot / Pipedrive) via /settings/integrations",
        "Or upload your customer list via the CSV import in /imports with lifecycle=customer",
      ],
      expectedUnlock:
        "Enables upsell + retention feasibility counsel + lastEngagementDistribution segmentation.",
    },
    {
      dataType: "lead_history",
      operatorActions: [
        "Connect your lead-gen ads (Meta Lead Ads) via /settings/integrations",
        "Or import historical leads via /imports with lifecycle=lead",
      ],
      expectedUnlock:
        "Enables conversion-rate projection + new-leads-needed counsel for outcome goals.",
    },
    {
      dataType: "engagement_history",
      operatorActions: [
        "Ship at least one Campaign so the engine starts recording engagement",
        "Or connect email/SMS provider so existing engagement is captured",
      ],
      expectedUnlock:
        "Enables re-engagement feasibility counsel + customer-cohort segmentation by recency.",
    },
  ],
  message:
    "We need data to give you confident feasibility counsel. Start by uploading your past orders or syncing your CRM — even partial history dramatically improves the AI's read.",
};
