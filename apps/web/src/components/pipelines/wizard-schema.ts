import { z } from "zod";
import type {
  ObjectiveType as PipelineObjectiveType,
  KnowledgeCategory,
  TargetMetric,
  TargetPeriod,
} from "@growth/shared";

// ─── Step 1: Basics ───
export const basicsSchema = z.object({
  name: z.string().min(1, "Pipeline name is required").max(100, "Max 100 characters"),
  description: z.string().max(1000, "Max 1000 characters").optional(),
  // Values mirror schema.prisma:376-380 + apps/api/src/router.ts:2589.
  // Drift-protected on the backend by objective-type-drift.test.ts; the
  // frontend ↔ backend bridge is KAN-719's job.
  objectiveType: z.enum([
    "warm_up_lead",
    "book_appointment",
    "buy_online",
    "send_quote",
  ]) satisfies z.ZodType<PipelineObjectiveType>,
  objectiveDescription: z.string().max(2000, "Max 2000 characters").optional(),
});
export type BasicsInput = z.infer<typeof basicsSchema>;

// ─── Step 2: Stages ───
export const stageSchema = z.object({
  // Local-only id used for dnd-kit + react-hook-form keying. Backend assigns
  // a real UUID on create.
  localId: z.string(),
  name: z.string().min(1, "Stage name is required").max(80, "Max 80 characters"),
  isInitial: z.boolean(),
  isTerminal: z.boolean(),
});
export type StageInput = z.infer<typeof stageSchema>;

export const stagesSchema = z
  .object({ stages: z.array(stageSchema).min(1, "At least one stage is required") })
  .superRefine((val, ctx) => {
    const initialCount = val.stages.filter((s) => s.isInitial).length;
    if (initialCount === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: "Exactly one stage must be marked as initial",
      });
    } else if (initialCount > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["stages"],
        message: `Only one stage can be initial (currently ${initialCount} marked)`,
      });
    }
    const seen = new Map<string, number>();
    val.stages.forEach((s, i) => {
      const key = s.name.trim().toLowerCase();
      if (seen.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["stages", i, "name"],
          message: `Duplicate stage name "${s.name}"`,
        });
      } else {
        seen.set(key, i);
      }
    });
  });
export type StagesInput = z.infer<typeof stagesSchema>;

// ─── Step 3: Micro-objectives ───
export const microObjectivesSchema = z.object({
  microObjectiveIds: z.array(z.string().uuid()),
});
export type MicroObjectivesInput = z.infer<typeof microObjectivesSchema>;

// ─── Step 4: Targets ───
// Values mirror schema.prisma:385-401 + apps/api/src/router.ts TargetMetricEnum
// + TargetPeriodEnum. Drift-protected on backend by enum-drift.test.ts;
// frontend ↔ backend bridge is KAN-719's job.
const TARGET_METRICS = [
  "appointments_booked",
  "orders_placed",
  "quotes_sent",
  "replies_received",
  "leads_qualified",
  "revenue_dollars",
] as const;
const TARGET_PERIODS = ["weekly", "monthly", "quarterly"] as const;

export const targetSchema = z.object({
  metric: z.enum(TARGET_METRICS) satisfies z.ZodType<TargetMetric>,
  period: z.enum(TARGET_PERIODS) satisfies z.ZodType<TargetPeriod>,
  value: z.number().nonnegative("Target must be ≥ 0"),
});
export type TargetInput = z.infer<typeof targetSchema>;

export const targetsSchema = z.object({
  targets: z.array(targetSchema),
});
export type TargetsInput = z.infer<typeof targetsSchema>;

// ─── Step 5: Knowledge filters ───
// Values mirror schema.prisma:423-432 + apps/api/src/router.ts
// KnowledgeCategoryEnum. Drift-protected on backend by enum-drift.test.ts.
const KNOWLEDGE_CATEGORIES = [
  "company_info",
  "products",
  "warranty",
  "shipping",
  "financing",
  "faqs",
] as const;

export const knowledgeFilterSchema = z.object({
  knowledgeCategory: z.enum(KNOWLEDGE_CATEGORIES) satisfies z.ZodType<KnowledgeCategory>,
  enabled: z.boolean(),
});
export type KnowledgeFilterInput = z.infer<typeof knowledgeFilterSchema>;

export const knowledgeFiltersSchema = z.object({
  filters: z.array(knowledgeFilterSchema),
});
export type KnowledgeFiltersInput = z.infer<typeof knowledgeFiltersSchema>;

// Wizard data carries the per-step shapes; each step validates its own slice.
export type WizardData = BasicsInput & StagesInput & MicroObjectivesInput & TargetsInput & KnowledgeFiltersInput;

// Display label is intentionally distinct from the canonical value — labels
// can be UX-tuned without touching the schema. Values MUST stay in the
// canonical set above.
export const OBJECTIVE_OPTIONS: ReadonlyArray<{ value: PipelineObjectiveType; label: string; hint: string }> = [
  { value: "warm_up_lead", label: "Warm Up Lead", hint: "Nurture and educate before any sales conversation" },
  { value: "book_appointment", label: "Book Meeting", hint: "Capture interest, schedule a call" },
  { value: "buy_online", label: "Online Purchase", hint: "Guide a self-serve buyer to checkout" },
  { value: "send_quote", label: "Send Quote", hint: "Lead intent: get a price for a known need" },
];

export const TARGET_METRIC_OPTIONS: ReadonlyArray<{ value: TargetMetric; label: string }> = [
  { value: "appointments_booked", label: "Appointments booked" },
  { value: "orders_placed", label: "Orders placed" },
  { value: "quotes_sent", label: "Quotes sent" },
  { value: "replies_received", label: "Replies received" },
  { value: "leads_qualified", label: "Leads qualified" },
  { value: "revenue_dollars", label: "Revenue ($)" },
];

export const TARGET_PERIOD_OPTIONS: ReadonlyArray<{ value: TargetPeriod; label: string }> = [
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
  { value: "quarterly", label: "Quarterly" },
];

export const KNOWLEDGE_CATEGORY_OPTIONS: ReadonlyArray<{
  value: KnowledgeCategory;
  label: string;
  hint: string;
}> = [
  { value: "company_info", label: "Company info", hint: "Mission, vision, story" },
  { value: "products", label: "Products", hint: "Product specs, SKUs, descriptions" },
  { value: "warranty", label: "Warranty", hint: "Coverage, claims, exclusions" },
  { value: "shipping", label: "Shipping", hint: "Carriers, lead times, costs" },
  { value: "financing", label: "Financing", hint: "Payment plans, terms, interest" },
  { value: "faqs", label: "FAQ", hint: "Frequently-asked answers" },
];

// Stable client-side ID generator — Math.random + ts is sufficient for
// dnd-kit + react-hook-form keying; backend assigns the real UUID on create.
export function newLocalId() {
  return `local-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
}

export function defaultStages(): StageInput[] {
  return [
    { localId: newLocalId(), name: "New", isInitial: true, isTerminal: false },
    { localId: newLocalId(), name: "Qualified", isInitial: false, isTerminal: false },
    { localId: newLocalId(), name: "Quote Sent", isInitial: false, isTerminal: false },
    { localId: newLocalId(), name: "Closed", isInitial: false, isTerminal: true },
  ];
}
