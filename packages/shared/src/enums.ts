import { z } from "zod";

export const ObjectiveTypeEnum = z.enum([
  "warm_up_lead",
  "book_appointment",
  "buy_online",
  "send_quote",
]);
export type ObjectiveType = z.infer<typeof ObjectiveTypeEnum>;

export const TargetMetricEnum = z.enum([
  "appointments_booked",
  "orders_placed",
  "quotes_sent",
  "replies_received",
  "leads_qualified",
  "revenue_dollars",
]);
export type TargetMetric = z.infer<typeof TargetMetricEnum>;

export const TargetPeriodEnum = z.enum(["weekly", "monthly", "quarterly"]);
export type TargetPeriod = z.infer<typeof TargetPeriodEnum>;

export const KnowledgeCategoryEnum = z.enum([
  "company_info",
  "products",
  "warranty",
  "shipping",
  "financing",
  "faqs",
]);
export type KnowledgeCategory = z.infer<typeof KnowledgeCategoryEnum>;

export const LeadAssignmentPostureEnum = z.enum([
  "stay_unassigned",
  "default_pipeline",
  "escalate_to_human",
]);
export type LeadAssignmentPosture = z.infer<typeof LeadAssignmentPostureEnum>;

// KAN-826 — KnowledgeSourceTypeEnum + KnowledgeSourceStatusEnum REMOVED.
// Sprint 11a Architect Spec uses string columns (sourceType, status) on
// the new KnowledgeSource model rather than Prisma enums. Legacy KAN-706
// enum drift PAIRS removed from packages/shared/src/__tests__/enum-drift.test.ts
// in the same PR per `reference_enum_drift_pairs_discipline` memory.

// KAN-791 Phase 1 PIVOT — DealStatus enum REMOVED. Deal lifecycle state is
// now derived from Deal.currentStageId → Stage.outcomeType. Closed_won/_lost
// are Stages with outcomeType=terminal_won/terminal_lost (not Deal columns).

// KAN-786 Phase 1 — Engagement signal class
export const SignalClassEnum = z.enum(["positive", "negative", "neutral"]);
export type SignalClass = z.infer<typeof SignalClassEnum>;

// KAN-791 Phase 1 PIVOT — Stage outcome type. Drives terminal-detection.
// Phase 2 KAN-796 (AI Stages Evolution Logic) reads this to know which
// Stages mark deal closure.
export const StageOutcomeTypeEnum = z.enum([
  "open",
  "terminal_won",
  "terminal_lost",
]);
export type StageOutcomeType = z.infer<typeof StageOutcomeTypeEnum>;

// KAN-1000 Slice 2 fix-forward — Contact LifecycleStage + ContactSource
// Zod mirrors. Added after a PROD bug where audience-conditions.ts had
// drift'd Zod enums (added 'opportunity'/'churned' that don't exist in
// Prisma, missing 'lost'). The drift hit Prisma at count time + leaked
// the raw query string to the UI. Added to PAIRS in enum-drift.test.ts
// so the class can't return for these two enums.
export const LifecycleStageEnum = z.enum([
  "lead",
  "mql",
  "sql",
  "customer",
  "lost",
]);
export type LifecycleStage = z.infer<typeof LifecycleStageEnum>;

export const ContactSourceEnum = z.enum([
  "email_inbox",
  "web_form",
  "meta_ad",
  "manual",
  "csv_import",
  "api",
  "hubspot",
  "stripe",
  "shopify",
  "other",
]);
export type ContactSource = z.infer<typeof ContactSourceEnum>;
