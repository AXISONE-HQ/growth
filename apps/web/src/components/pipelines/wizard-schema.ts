import { z } from "zod";
import type { PipelineObjectiveType, KnowledgeCategory, TargetMetric, TargetPeriod } from "@/lib/api";

// ─── Step 1: Basics ───
export const basicsSchema = z.object({
  name: z.string().min(1, "Pipeline name is required").max(100, "Max 100 characters"),
  description: z.string().max(1000, "Max 1000 characters").optional(),
  objectiveType: z.enum([
    "send_quote",
    "send_quote_and_deal",
    "book_meeting",
    "sales_decision",
    "reactivate_customer",
    "collect_information",
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
const TARGET_METRICS = ["leads_in", "quotes_sent", "deals_won", "meetings_booked"] as const;
const TARGET_PERIODS = ["day", "week", "month", "quarter"] as const;

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
const KNOWLEDGE_CATEGORIES = [
  "product",
  "policy",
  "faq",
  "document",
  "company_info",
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

export const OBJECTIVE_OPTIONS: ReadonlyArray<{ value: PipelineObjectiveType; label: string; hint: string }> = [
  { value: "send_quote", label: "Send quote", hint: "Lead intent: get a price for a known need" },
  { value: "send_quote_and_deal", label: "Send quote + close the deal", hint: "Quote then guide to acceptance" },
  { value: "book_meeting", label: "Book a meeting", hint: "Capture interest, schedule a call" },
  { value: "sales_decision", label: "Sales decision", hint: "Multi-touch nurture to a buy/no-buy point" },
  { value: "reactivate_customer", label: "Reactivate customer", hint: "Re-engage a churned or dormant lead" },
  { value: "collect_information", label: "Collect information", hint: "Gather facts before routing" },
];

export const TARGET_METRIC_OPTIONS: ReadonlyArray<{ value: TargetMetric; label: string }> = [
  { value: "leads_in", label: "Leads in" },
  { value: "quotes_sent", label: "Quotes sent" },
  { value: "deals_won", label: "Deals won" },
  { value: "meetings_booked", label: "Meetings booked" },
];

export const TARGET_PERIOD_OPTIONS: ReadonlyArray<{ value: TargetPeriod; label: string }> = [
  { value: "day", label: "Daily" },
  { value: "week", label: "Weekly" },
  { value: "month", label: "Monthly" },
  { value: "quarter", label: "Quarterly" },
];

export const KNOWLEDGE_CATEGORY_OPTIONS: ReadonlyArray<{
  value: KnowledgeCategory;
  label: string;
  hint: string;
}> = [
  { value: "product", label: "Product", hint: "Product specs, SKUs, descriptions" },
  { value: "policy", label: "Policy", hint: "Pricing rules, discount limits, T&Cs" },
  { value: "faq", label: "FAQ", hint: "Frequently-asked answers" },
  { value: "document", label: "Document", hint: "Brochures, case studies, slides" },
  { value: "company_info", label: "Company info", hint: "Mission, vision, story" },
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
