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

export const KnowledgeSourceTypeEnum = z.enum([
  "url",
  "document",
  "qa_pair",
  "structured_field",
]);
export type KnowledgeSourceType = z.infer<typeof KnowledgeSourceTypeEnum>;

export const KnowledgeSourceStatusEnum = z.enum([
  "pending",
  "processing",
  "indexed",
  "failed",
  "stale",
]);
export type KnowledgeSourceStatus = z.infer<typeof KnowledgeSourceStatusEnum>;

// KAN-786 Phase 1 — Deal status (open / closed_won / closed_lost) per
// docs/prds/phase-1-deal-engagement.md §3
export const DealStatusEnum = z.enum(["open", "closed_won", "closed_lost"]);
export type DealStatus = z.infer<typeof DealStatusEnum>;

// KAN-786 Phase 1 — Engagement signal class per
// docs/prds/phase-1-deal-engagement.md §3
export const SignalClassEnum = z.enum(["positive", "negative", "neutral"]);
export type SignalClass = z.infer<typeof SignalClassEnum>;
