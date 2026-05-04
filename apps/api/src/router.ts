import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createHash } from "node:crypto";
import type { Prisma, ChannelConnection } from "@prisma/client";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { router, publicProcedure, protectedProcedure, adminProcedure } from "./trpc.js";
import {
  IngestRequestSchema,
  ObjectiveTypeEnum,
  TargetMetricEnum,
  TargetPeriodEnum,
  KnowledgeCategoryEnum,
  LeadAssignmentPostureEnum,
  KnowledgeSourceTypeEnum,
  KnowledgeSourceStatusEnum,
  PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT,
  type IngestRequestedEvent,
  type IngestStatus,
} from "@growth/shared";
import { publishIngestRequested } from "./services/knowledge-ingest-publisher.js";

// ============================================================================
// KAN-702 PR A — pipeline form validation helpers (inlined here for net-zero
// TS6059 — pulling these from packages/api/src/services adds the file to the
// apps/api static graph and bumps the cohort by 1). Re-exported below so the
// test file can import the same canonical implementation via the connectors
// vitest bridge (test runs against the router file's exports rather than a
// separate packages/api file).
// ============================================================================

export interface StageInput {
  id?: string;
  name: string;
  order: number;
  isInitial: boolean;
  isTerminal: boolean;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function validateStages(stages: StageInput[]): ValidationResult {
  const errors: string[] = [];
  if (stages.length === 0) {
    errors.push("Pipeline must have at least one stage");
    return { valid: false, errors };
  }
  const names = new Set<string>();
  for (const s of stages) {
    const trimmed = s.name.trim();
    if (!trimmed) {
      errors.push("Stage names cannot be empty");
      continue;
    }
    if (names.has(trimmed)) errors.push(`Stage name "${trimmed}" appears more than once`);
    names.add(trimmed);
  }
  const orders = new Set<number>();
  for (const s of stages) {
    if (orders.has(s.order)) errors.push(`Stage order ${s.order} appears more than once`);
    orders.add(s.order);
  }
  const initialCount = stages.filter((s) => s.isInitial).length;
  if (initialCount === 0) errors.push("Pipeline must have exactly one initial stage (none marked)");
  else if (initialCount > 1) errors.push(`Pipeline must have exactly one initial stage (${initialCount} marked)`);
  return { valid: errors.length === 0, errors };
}

export function normalizeStageOrders(stages: StageInput[]): StageInput[] {
  return stages.map((s, i) => ({ ...s, order: i }));
}

const ALLOWED_OBJECTIVE_TYPES = new Set([
  "warm_up_lead",
  "book_appointment",
  "buy_online",
  "send_quote",
]);

export interface PipelineFormInput {
  name: string;
  description?: string | null;
  objectiveType: string;
  objectiveDescription?: string | null;
  stages: StageInput[];
}

export function validatePipelineForm(input: PipelineFormInput): ValidationResult {
  const errors: string[] = [];
  if (!input.name.trim()) errors.push("Pipeline name is required");
  if (input.name.length > 100) errors.push("Pipeline name must be 100 characters or fewer");
  if (!ALLOWED_OBJECTIVE_TYPES.has(input.objectiveType)) {
    errors.push(`Unknown objective type "${input.objectiveType}"`);
  }
  const stageResult = validateStages(input.stages);
  errors.push(...stageResult.errors);
  return { valid: errors.length === 0, errors };
}

export function canDeletePipeline(input: {
  activeLeadCount: number;
  stageHistoryCount: number;
}): { canDelete: boolean; reason: string | null } {
  if (input.activeLeadCount > 0) {
    return {
      canDelete: false,
      reason: `Cannot delete pipeline: ${input.activeLeadCount} lead(s) currently assigned. Move leads to another pipeline first.`,
    };
  }
  if (input.stageHistoryCount > 0) {
    return {
      canDelete: false,
      reason: `Cannot delete pipeline: ${input.stageHistoryCount} stage transition(s) in audit history. Archive instead (toggle isActive=false).`,
    };
  }
  return { canDelete: true, reason: null };
}

export function canDeleteStage(input: {
  activeLeadCount: number;
  isInitial: boolean;
  isOnlyInitial: boolean;
}): { canDelete: boolean; reason: string | null } {
  if (input.activeLeadCount > 0) {
    return {
      canDelete: false,
      reason: `Cannot delete stage: ${input.activeLeadCount} lead(s) currently in this stage. Move leads to another stage first.`,
    };
  }
  if (input.isInitial && input.isOnlyInitial) {
    return {
      canDelete: false,
      reason: `Cannot delete the pipeline's only initial stage. Mark another stage as initial first.`,
    };
  }
  return { canDelete: true, reason: null };
}
import { generateObjectionResponses, regenerateSingleField } from "./llm.js";
import { validatePageToken } from "./integrations/messenger/graph-api.js";
import { detectSignals } from "../../../packages/api/src/services/wedge-signals.js";
import { matchOpportunities } from "../../../packages/api/src/services/wedge-opportunities.js";
import {
  WEDGE_PLAYBOOKS,
  buildPlaybookStepContext,
} from "../../../packages/api/src/services/wedge-playbooks.js";
import { runDecisionForContact } from "../../../packages/api/src/services/run-decision-for-contact.js";

// ============================================================================
// CONTACTS ROUTER
// ============================================================================

// KAN-718 Day 10 — `contactsRouter` replaces the broken pre-KAN-689 router
// (snake_case + `name` / `company` / `status` fields that don't exist in the
// canonical Contact schema). Service lives at packages/api/src/services/
// contacts-router.ts; thin tRPC layer here. Variable-specifier dynamic
// import keeps the service out of the apps/api static graph (TS6059 cohort).
interface ContactsRouterModule {
  listContacts: (
    prisma: unknown,
    tenantId: string,
    input: { search?: string; lifecycleStage?: string; limit?: number; offset?: number },
  ) => Promise<unknown>;
  getContactById: (prisma: unknown, tenantId: string, id: string) => Promise<unknown>;
  createContact: (
    prisma: unknown,
    tenantId: string,
    input: {
      email: string;
      phone?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      segment?: string | null;
      lifecycleStage?: string;
      source?: string | null;
    },
  ) => Promise<unknown>;
  updateContact: (
    prisma: unknown,
    tenantId: string,
    input: {
      id: string;
      email?: string;
      phone?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      segment?: string | null;
      lifecycleStage?: string;
      source?: string | null;
    },
  ) => Promise<unknown>;
}
let _contactsModule: ContactsRouterModule | null = null;
async function loadContactsModule(): Promise<ContactsRouterModule> {
  if (_contactsModule) return _contactsModule;
  const spec = "../../../packages/api/src/services/contacts-router.js";
  _contactsModule = (await import(spec)) as ContactsRouterModule;
  return _contactsModule;
}

const contactsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        lifecycleStage: z.string().optional(),
        limit: z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listContacts } = await loadContactsModule();
      return listContacts(ctx.prisma, ctx.tenantId, input);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { getContactById } = await loadContactsModule();
      return getContactById(ctx.prisma, ctx.tenantId, input.id);
    }),

  create: protectedProcedure
    .input(
      z.object({
        email: z.string().email(),
        phone: z.string().nullable().optional(),
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
        segment: z.string().nullable().optional(),
        lifecycleStage: z.string().optional(),
        source: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { createContact } = await loadContactsModule();
      return createContact(ctx.prisma, ctx.tenantId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        email: z.string().email().optional(),
        phone: z.string().nullable().optional(),
        firstName: z.string().nullable().optional(),
        lastName: z.string().nullable().optional(),
        segment: z.string().nullable().optional(),
        lifecycleStage: z.string().optional(),
        source: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { updateContact } = await loadContactsModule();
      return updateContact(ctx.prisma, ctx.tenantId, input);
    }),
});

// ============================================================================
// DECISIONS ROUTER
// ============================================================================

const decisionsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        contactId: z.string().uuid().optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenant_id: ctx.tenantId,
        ...(input.contactId && { contact_id: input.contactId }),
      };

      const [decisions, total] = await Promise.all([
        ctx.prisma.decision.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { created_at: "desc" },
        }),
        ctx.prisma.decision.count({ where }),
      ]);

      return {
        decisions,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const decision = await ctx.prisma.decision.findFirst({
        where: {
          id: input.id,
          tenant_id: ctx.tenantId,
        },
      });

      if (!decision) {
        throw new Error("Decision not found");
      }

      return decision;
    }),
});

// ============================================================================
// ACTIONS ROUTER
// ============================================================================

const actionsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        decisionId: z.string().uuid().optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenant_id: ctx.tenantId,
        ...(input.decisionId && { decision_id: input.decisionId }),
      };

      const [actions, total] = await Promise.all([
        ctx.prisma.action.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { created_at: "desc" },
        }),
        ctx.prisma.action.count({ where }),
      ]);

      return {
        actions,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),
});

// ============================================================================
// ESCALATIONS ROUTER
// ============================================================================

// KAN-754 — `recommendationsRouter` replaces the pre-KAN-689 broken
// `escalationsRouter` (snake_case + non-existent fields like `priority`,
// `claimed_at`, `dismissed_at`). Post-KAN-750, Escalation IS the recommendation
// — see `packages/api/src/services/recommendations.ts` for handlers.
//
// URL/API name asymmetry intentional: URL stays `/escalations` (existing IA
// + operational queue framing); tRPC namespace is `recommendations` (the
// abstraction layer). KAN-756 reconciles if we ever rename the URL.
//
// All endpoints adminProcedure: only ADMIN_EMAILS allowlist members can act
// on escalations — operator-grade authority, matches /settings/* surfaces.
const SuggestedActionSchema = z.object({
  actionType: z.string().min(1),
  channel: z.string().nullable(),
  payload: z.record(z.unknown()),
});

// Variable-specifier dynamic import keeps recommendations.ts out of the
// apps/api static graph (TS6059 cohort) — `reference_variable_specifier_
// dynamic_import` discipline. Manually-declared types (NOT `typeof
// import("literal")`) because the literal path in `typeof import(...)`
// also pulls the file into the static graph, defeating the purpose.
// Mirrors run-decision-for-contact.ts's loadAgenticLoop pattern.
interface RecsModule {
  listRecommendations: (
    prisma: unknown,
    tenantId: string,
    input: {
      status?: "open" | "claimed" | "resolved" | "dismissed";
      severity?: "low" | "medium" | "high" | "critical";
      limit?: number;
      offset?: number;
    },
  ) => Promise<unknown>;
  getRecommendationDetail: (prisma: unknown, tenantId: string, id: string) => Promise<unknown>;
  acceptRecommendation: (
    ctx: {
      prisma: unknown;
      tenantId: string;
      actor: string;
      pubsubClient?: unknown | null;
    },
    input: {
      id: string;
      modifiedAction?: { actionType: string; channel: string | null; payload: Record<string, unknown> };
    },
  ) => Promise<unknown>;
  modifyRecommendation: (
    ctx: { prisma: unknown; tenantId: string; actor: string },
    input: { id: string; suggestedAction: string },
  ) => Promise<unknown>;
  dismissRecommendation: (
    ctx: { prisma: unknown; tenantId: string; actor: string },
    input: { id: string; reason: string },
  ) => Promise<unknown>;
}
let _recsModule: RecsModule | null = null;
async function loadRecsModule(): Promise<RecsModule> {
  if (_recsModule) return _recsModule;
  const spec = "../../../packages/api/src/services/recommendations.js";
  _recsModule = (await import(spec)) as RecsModule;
  return _recsModule;
}

interface PubSubLib {
  getPubSubClient: () => unknown;
}
let _pubsubLib: PubSubLib | null = null;
async function loadPubSubLib(): Promise<PubSubLib> {
  if (_pubsubLib) return _pubsubLib;
  const spec = "../../../packages/api/src/lib/pubsub-client.js";
  _pubsubLib = (await import(spec)) as PubSubLib;
  return _pubsubLib;
}

const recommendationsRouter = router({
  list: adminProcedure
    .input(
      z.object({
        status: z.enum(["open", "claimed", "resolved", "dismissed"]).optional(),
        severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listRecommendations } = await loadRecsModule();
      return listRecommendations(ctx.prisma, ctx.tenantId, input);
    }),

  getDetail: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { getRecommendationDetail } = await loadRecsModule();
      return getRecommendationDetail(ctx.prisma, ctx.tenantId, input.id);
    }),

  accept: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        modifiedAction: SuggestedActionSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { acceptRecommendation } = await loadRecsModule();
      const { getPubSubClient } = await loadPubSubLib();
      return acceptRecommendation(
        {
          prisma: ctx.prisma,
          tenantId: ctx.tenantId,
          actor: ctx.firebaseUser?.uid ?? "unknown",
          pubsubClient: getPubSubClient(),
        },
        input,
      );
    }),

  modify: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        suggestedAction: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { modifyRecommendation } = await loadRecsModule();
      return modifyRecommendation(
        {
          prisma: ctx.prisma,
          tenantId: ctx.tenantId,
          actor: ctx.firebaseUser?.uid ?? "unknown",
        },
        input,
      );
    }),

  dismiss: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        reason: z.string().min(1).max(500),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { dismissRecommendation } = await loadRecsModule();
      return dismissRecommendation(
        {
          prisma: ctx.prisma,
          tenantId: ctx.tenantId,
          actor: ctx.firebaseUser?.uid ?? "unknown",
        },
        input,
      );
    }),
});

// ============================================================================
// AUDIT LOG ROUTER
// ============================================================================

// KAN-718 Day 10 — `auditLogRouter` replaces the broken pre-KAN-689 router
// (snake_case + `category` field that doesn't exist in the canonical
// AuditLog schema; canonical filter is `actionType`). Service at
// packages/api/src/services/audit-log-router.ts.
interface AuditLogRouterModule {
  listAuditLog: (
    prisma: unknown,
    tenantId: string,
    input: {
      includeInfrastructure?: boolean;
      actionTypePrefix?: string;
      limit?: number;
      offset?: number;
    },
  ) => Promise<unknown>;
  getAuditLogEntry: (prisma: unknown, tenantId: string, id: string) => Promise<unknown>;
}
let _auditLogModule: AuditLogRouterModule | null = null;
async function loadAuditLogModule(): Promise<AuditLogRouterModule> {
  if (_auditLogModule) return _auditLogModule;
  const spec = "../../../packages/api/src/services/audit-log-router.js";
  _auditLogModule = (await import(spec)) as AuditLogRouterModule;
  return _auditLogModule;
}

const auditLogRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        // KAN-758 (Sprint 5+ Low) adds an admin toggle for this. Today the
        // default keeps `brain.blueprint_*` hidden — fires on every server
        // restart, drowns operator signal.
        includeInfrastructure: z.boolean().optional(),
        actionTypePrefix: z.string().optional(),
        limit: z.number().min(1).max(200).default(50),
        offset: z.number().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listAuditLog } = await loadAuditLogModule();
      return listAuditLog(ctx.prisma, ctx.tenantId, input);
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { getAuditLogEntry } = await loadAuditLogModule();
      return getAuditLogEntry(ctx.prisma, ctx.tenantId, input.id);
    }),
});

// ============================================================================
// BRAIN ROUTER
// ============================================================================

const brainRouter = router({
  getSnapshot: protectedProcedure.query(async ({ ctx }) => {
    // Returns aggregated snapshot of the AI brain state
    const [contacts, objectives, actions, escalations] = await Promise.all([
      ctx.prisma.contact.count({ where: { tenant_id: ctx.tenantId } }),
      ctx.prisma.objective.count({ where: { tenant_id: ctx.tenantId } }),
      ctx.prisma.action.count({ where: { tenant_id: ctx.tenantId } }),
      ctx.prisma.escalation.count({
        where: { tenant_id: ctx.tenantId, status: "open" },
      }),
    ]);

    return {
      contacts,
      objectives,
      actions,
      escalations,
      timestamp: new Date(),
    };
  }),

  getStatus: protectedProcedure.query(async ({ ctx }) => {
    // Returns health/status of the AI brain
    return {
      status: "operational",
      lastUpdate: new Date(),
      tenantId: ctx.tenantId,
    };
  }),
});

// ============================================================================
// OBJECTIVES ROUTER
// ============================================================================

const objectivesRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = { tenant_id: ctx.tenantId };

      const [objectives, total] = await Promise.all([
        ctx.prisma.objective.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { created_at: "desc" },
        }),
        ctx.prisma.objective.count({ where }),
      ]);

      return {
        objectives,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  create: protectedProcedure
    .input(
      z.object({
        title: z.string().min(1),
        description: z.string().optional(),
        status: z.string().default("active"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.objective.create({
        data: {
          ...input,
          tenant_id: ctx.tenantId,
        },
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        title: z.string().optional(),
        description: z.string().optional(),
        status: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      const existing = await ctx.prisma.objective.findFirst({
        where: { id, tenant_id: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Objective not found");
      }

      return ctx.prisma.objective.update({
        where: { id },
        data,
      });
    }),
});

// ============================================================================
// DASHBOARD ROUTER
// ============================================================================

const dashboardRouter = router({
  getStats: protectedProcedure.query(async ({ ctx }) => {
    const [
      contactsCount,
      objectivesCompleted,
      actionsToday,
      escalations,
      auditLogsToday,
    ] = await Promise.all([
      ctx.prisma.contact.count({ where: { tenant_id: ctx.tenantId } }),
      ctx.prisma.objective.count({
        where: { tenant_id: ctx.tenantId, status: "completed" },
      }),
      ctx.prisma.action.count({
        where: {
          tenant_id: ctx.tenantId,
          created_at: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      ctx.prisma.escalation.findMany({
        where: { tenant_id: ctx.tenantId },
      }),
      ctx.prisma.auditLog.findMany({
        where: {
          tenant_id: ctx.tenantId,
          created_at: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
    ]);

    // Calculate average response time (mock - would use actual data)
    const avgResponseTime = 2.5; // hours

    // Calculate escalation rate
    const totalEscalations = escalations.length;
    const resolvedEscalations = escalations.filter(
      (e) => e.status === "resolved"
    ).length;
    const escalationRate =
      totalEscalations > 0 ? (resolvedEscalations / totalEscalations) * 100 : 0;

    return {
      contacts: contactsCount,
      objectivesCompleted,
      actionsToday,
      avgResponseTime,
      escalationRate: Math.round(escalationRate),
      totalEscalations,
    };
  }),
});

// ============================================================================
// KNOWLEDGE CENTER ROUTER
// ============================================================================

const knowledgeRouter = router({
  // ---- Company Info (one per tenant) ----
  getCompanyInfo: protectedProcedure.query(async ({ ctx }) => {
    let info = await ctx.prisma.companyInfo.findUnique({
      where: { tenantId: ctx.tenantId },
    });

    // Auto-create if missing
    if (!info) {
      info = await ctx.prisma.companyInfo.create({
        data: { tenantId: ctx.tenantId },
      });
    }

    return info;
  }),

  updateCompanyInfo: protectedProcedure
    .input(
      z.object({
        vision: z.string().optional(),
        mission: z.string().optional(),
        websiteUrl: z.string().url().optional().nullable(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.companyInfo.upsert({
        where: { tenantId: ctx.tenantId },
        update: input,
        create: {
          tenantId: ctx.tenantId,
          ...input,
        },
      });
    }),

  // ---- Products ----
  listProducts: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        category: z.string().optional(),
        search: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenantId: ctx.tenantId,
        active: true,
        ...(input.category && { category: input.category }),
        ...(input.search && {
          OR: [
            { name: { contains: input.search, mode: "insensitive" as const } },
            { sku: { contains: input.search, mode: "insensitive" as const } },
          ],
        }),
      };

      const [products, total] = await Promise.all([
        ctx.prisma.product.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { createdAt: "desc" },
        }),
        ctx.prisma.product.count({ where }),
      ]);

      return {
        products,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  createProduct: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        category: z.string().optional(),
        price: z.string().optional(),
        description: z.string().optional(),
        sku: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.product.create({
        data: {
          ...input,
          tenantId: ctx.tenantId,
        },
      });
    }),

  updateProduct: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().optional(),
        category: z.string().optional(),
        price: z.string().optional(),
        description: z.string().optional(),
        sku: z.string().optional(),
        active: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      const existing = await ctx.prisma.product.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Product not found");
      }

      return ctx.prisma.product.update({
        where: { id },
        data,
      });
    }),

  deleteProduct: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.product.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Product not found");
      }

      return ctx.prisma.product.update({
        where: { id: input.id },
        data: { active: false },
      });
    }),

  // ---- Policy Rules (warranties, financing, rules) ----
  listPolicies: protectedProcedure
    .input(
      z.object({
        category: z.enum(["warranty", "financing", "rule"]).optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(50),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenantId: ctx.tenantId,
        active: true,
        ...(input.category && { category: input.category }),
      };

      const [policies, total] = await Promise.all([
        ctx.prisma.policyRule.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { sortOrder: "asc" },
        }),
        ctx.prisma.policyRule.count({ where }),
      ]);

      return {
        policies,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  createPolicy: protectedProcedure
    .input(
      z.object({
        category: z.enum(["warranty", "financing", "rule"]),
        title: z.string().min(1),
        content: z.string().min(1),
        sortOrder: z.number().default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.policyRule.create({
        data: {
          ...input,
          tenantId: ctx.tenantId,
        },
      });
    }),

  updatePolicy: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        category: z.enum(["warranty", "financing", "rule"]).optional(),
        title: z.string().optional(),
        content: z.string().optional(),
        sortOrder: z.number().optional(),
        active: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      const existing = await ctx.prisma.policyRule.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Policy not found");
      }

      return ctx.prisma.policyRule.update({
        where: { id },
        data,
      });
    }),

  deletePolicy: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.policyRule.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Policy not found");
      }

      return ctx.prisma.policyRule.update({
        where: { id: input.id },
        data: { active: false },
      });
    }),

  // ---- FAQs ----
  listFAQs: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(50),
        search: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenantId: ctx.tenantId,
        active: true,
        ...(input.search && {
          OR: [
            { question: { contains: input.search, mode: "insensitive" as const } },
            { answer: { contains: input.search, mode: "insensitive" as const } },
          ],
        }),
      };

      const [faqs, total] = await Promise.all([
        ctx.prisma.fAQ.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { sortOrder: "asc" },
        }),
        ctx.prisma.fAQ.count({ where }),
      ]);

      return {
        faqs,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  createFAQ: protectedProcedure
    .input(
      z.object({
        question: z.string().min(1),
        answer: z.string().min(1),
        sortOrder: z.number().default(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.fAQ.create({
        data: {
          ...input,
          tenantId: ctx.tenantId,
        },
      });
    }),

  updateFAQ: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        question: z.string().optional(),
        answer: z.string().optional(),
        sortOrder: z.number().optional(),
        active: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      const existing = await ctx.prisma.fAQ.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("FAQ not found");
      }

      return ctx.prisma.fAQ.update({
        where: { id },
        data,
      });
    }),

  deleteFAQ: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.fAQ.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("FAQ not found");
      }

      return ctx.prisma.fAQ.update({
        where: { id: input.id },
        data: { active: false },
      });
    }),

  // ---- Knowledge Documents ----
  listDocuments: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        type: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenantId: ctx.tenantId,
        ...(input.type && { type: input.type }),
      };

      const [documents, total] = await Promise.all([
        ctx.prisma.knowledgeDocument.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { uploadedAt: "desc" },
        }),
        ctx.prisma.knowledgeDocument.count({ where }),
      ]);

      return {
        documents,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  createDocument: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        type: z.string().min(1),
        sizeBytes: z.number().default(0),
        gcsPath: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.knowledgeDocument.create({
        data: {
          ...input,
          tenantId: ctx.tenantId,
        },
      });
    }),

  deleteDocument: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.knowledgeDocument.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Document not found");
      }

      return ctx.prisma.knowledgeDocument.delete({
        where: { id: input.id },
      });
    }),
});

// ============================================================================
// COMPETITORS ROUTER
// ============================================================================

const competitorsRouter = router({
  // ---- List all competitors for the tenant ----
  list: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        search: z.string().optional(),
        status: z.enum(["active", "inactive", "archived"]).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenantId: ctx.tenantId,
        ...(input.status && { status: input.status }),
        ...(input.search && {
          OR: [
            { name: { contains: input.search, mode: "insensitive" as const } },
            { website: { contains: input.search, mode: "insensitive" as const } },
          ],
        }),
      };

      const [competitors, total] = await Promise.all([
        ctx.prisma.competitor.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { createdAt: "desc" },
          include: {
            battleCards: {
              orderBy: { version: "desc" },
              take: 1,
            },
            _count: {
              select: { news: true },
            },
          },
        }),
        ctx.prisma.competitor.count({ where }),
      ]);

      return {
        competitors,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  // ---- Get single competitor with full detail ----
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const competitor = await ctx.prisma.competitor.findFirst({
        where: {
          id: input.id,
          tenantId: ctx.tenantId,
        },
        include: {
          battleCards: {
            orderBy: { version: "desc" },
            take: 1,
          },
          news: {
            orderBy: { publishedAt: "desc" },
            take: 10,
          },
        },
      });

      if (!competitor) {
        throw new Error("Competitor not found");
      }

      return competitor;
    }),

  // ---- Create a competitor (manual add) ----
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        website: z.string().url(),
        description: z.string().optional(),
        employeeCount: z.number().optional(),
        customerCount: z.number().optional(),
        annualRevenue: z.string().optional(),
        segment: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.competitor.create({
        data: {
          ...input,
          tenantId: ctx.tenantId,
        },
      });
    }),

  // ---- Update competitor ----
  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().optional(),
        website: z.string().url().optional(),
        description: z.string().optional(),
        employeeCount: z.number().optional().nullable(),
        customerCount: z.number().optional().nullable(),
        annualRevenue: z.string().optional().nullable(),
        segment: z.string().optional(),
        status: z.enum(["active", "inactive", "archived"]).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      const existing = await ctx.prisma.competitor.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Competitor not found");
      }

      return ctx.prisma.competitor.update({
        where: { id },
        data,
      });
    }),

  // ---- Delete (archive) a competitor ----
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.competitor.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Competitor not found");
      }

      return ctx.prisma.competitor.update({
        where: { id: input.id },
        data: { status: "archived" },
      });
    }),

  // ---- Get battle card for a competitor ----
  getBattleCard: protectedProcedure
    .input(z.object({ competitorId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Verify tenant owns the competitor
      const competitor = await ctx.prisma.competitor.findFirst({
        where: { id: input.competitorId, tenantId: ctx.tenantId },
      });

      if (!competitor) {
        throw new Error("Competitor not found");
      }

      const battleCard = await ctx.prisma.competitorBattleCard.findFirst({
        where: { competitorId: input.competitorId },
        orderBy: { version: "desc" },
      });

      return battleCard;
    }),

  // ---- Create / update battle card ----
  upsertBattleCard: protectedProcedure
    .input(
      z.object({
        competitorId: z.string().uuid(),
        overview: z.string(),
        strengths: z.array(z.string()).default([]),
        weaknesses: z.array(z.string()).default([]),
        differentiators: z.array(z.string()).default([]),
        objections: z.array(z.object({
          objection: z.string(),
          rebuttal: z.string(),
        })).default([]),
        talkingPoints: z.array(z.string()).default([]),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify tenant owns the competitor
      const competitor = await ctx.prisma.competitor.findFirst({
        where: { id: input.competitorId, tenantId: ctx.tenantId },
      });

      if (!competitor) {
        throw new Error("Competitor not found");
      }

      // Get current max version
      const latest = await ctx.prisma.competitorBattleCard.findFirst({
        where: { competitorId: input.competitorId },
        orderBy: { version: "desc" },
      });

      const nextVersion = (latest?.version ?? 0) + 1;

      return ctx.prisma.competitorBattleCard.create({
        data: {
          competitorId: input.competitorId,
          overview: input.overview,
          strengths: input.strengths,
          weaknesses: input.weaknesses,
          differentiators: input.differentiators,
          objections: input.objections,
          talkingPoints: input.talkingPoints,
          version: nextVersion,
          generatedAt: new Date(),
        },
      });
    }),

  // ---- List news for a competitor ----
  listNews: protectedProcedure
    .input(
      z.object({
        competitorId: z.string().uuid(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify tenant owns the competitor
      const competitor = await ctx.prisma.competitor.findFirst({
        where: { id: input.competitorId, tenantId: ctx.tenantId },
      });

      if (!competitor) {
        throw new Error("Competitor not found");
      }

      const skip = (input.page - 1) * input.limit;

      const [news, total] = await Promise.all([
        ctx.prisma.competitorNews.findMany({
          where: { competitorId: input.competitorId },
          skip,
          take: input.limit,
          orderBy: { publishedAt: "desc" },
        }),
        ctx.prisma.competitorNews.count({
          where: { competitorId: input.competitorId },
        }),
      ]);

      return {
        news,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  // ---- Add news item ----
  addNews: protectedProcedure
    .input(
      z.object({
        competitorId: z.string().uuid(),
        title: z.string().min(1),
        summary: z.string(),
        sourceUrl: z.string().url().optional(),
        publishedAt: z.string().datetime().optional(),
        sentiment: z.enum(["positive", "negative", "neutral"]).default("neutral"),
        relevanceScore: z.number().min(0).max(1).default(0.5),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const competitor = await ctx.prisma.competitor.findFirst({
        where: { id: input.competitorId, tenantId: ctx.tenantId },
      });

      if (!competitor) {
        throw new Error("Competitor not found");
      }

      return ctx.prisma.competitorNews.create({
        data: {
          ...input,
          publishedAt: input.publishedAt ? new Date(input.publishedAt) : null,
        },
      });
    }),

  // ---- Dashboard stats for competitor intelligence ----
  getStats: protectedProcedure.query(async ({ ctx }) => {
    const [totalCompetitors, activeCompetitors, totalNews] = await Promise.all([
      ctx.prisma.competitor.count({ where: { tenantId: ctx.tenantId } }),
      ctx.prisma.competitor.count({ where: { tenantId: ctx.tenantId, status: "active" } }),
      ctx.prisma.competitorNews.count({
        where: { competitor: { tenantId: ctx.tenantId } },
      }),
    ]);

    const recentNews = await ctx.prisma.competitorNews.findMany({
      where: { competitor: { tenantId: ctx.tenantId } },
      orderBy: { publishedAt: "desc" },
      take: 5,
      include: { competitor: { select: { name: true } } },
    });

    return {
      totalCompetitors,
      activeCompetitors,
      totalNews,
      recentNews,
    };
  }),
});

// ============================================================================
// SALES OBJECTIONS ROUTER
// ============================================================================

const salesObjectionsRouter = router({
  // ---- List all objections for the tenant ----
  list: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        search: z.string().optional(),
        category: z
          .enum([
            "pricing",
            "competition",
            "trust",
            "timing",
            "product",
            "authority",
            "need",
            "other",
          ])
          .optional(),
        status: z
          .enum(["auto_generated", "edited", "approved", "archived"])
          .optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenantId: ctx.tenantId,
        active: true,
        ...(input.category && { category: input.category }),
        ...(input.search && {
          objectionText: {
            contains: input.search,
            mode: "insensitive" as const,
          },
        }),
      };

      const [objections, total] = await Promise.all([
        ctx.prisma.salesObjection.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { mentionCount: "desc" },
          include: {
            responses: {
              where: {
                version: {
                  // Get latest version of each field via raw ordering
                  gte: 1,
                },
              },
              orderBy: { version: "desc" },
            },
          },
        }),
        ctx.prisma.salesObjection.count({ where }),
      ]);

      // Deduplicate responses to keep only latest version per field
      const objectionsWithLatest = objections.map((obj) => {
        const latestByField = new Map<string, (typeof obj.responses)[0]>();
        for (const resp of obj.responses) {
          if (!latestByField.has(resp.fieldName)) {
            latestByField.set(resp.fieldName, resp);
          }
        }
        return {
          ...obj,
          responses: Array.from(latestByField.values()),
        };
      });

      return {
        objections: objectionsWithLatest,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  // ---- Get single objection with full responses and edit history ----
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const objection = await ctx.prisma.salesObjection.findFirst({
        where: {
          id: input.id,
          tenantId: ctx.tenantId,
        },
        include: {
          responses: {
            orderBy: { version: "desc" },
            include: {
              editHistory: {
                orderBy: { editedAt: "desc" },
                take: 10,
              },
            },
          },
        },
      });

      if (!objection) {
        throw new Error("Sales objection not found");
      }

      return objection;
    }),

  // ---- Dashboard stats ----
  getStats: protectedProcedure.query(async ({ ctx }) => {
    const where = { tenantId: ctx.tenantId, active: true };

    const [total, objections] = await Promise.all([
      ctx.prisma.salesObjection.count({ where }),
      ctx.prisma.salesObjection.findMany({
        where,
        select: {
          category: true,
          winRate: true,
          mentionCount: true,
          lastMentionedAt: true,
        },
      }),
    ]);

    // Calculate aggregate stats
    const totalMentions = objections.reduce(
      (sum, o) => sum + o.mentionCount,
      0
    );
    const avgWinRate =
      objections.length > 0
        ? Math.round(
            objections.reduce((sum, o) => sum + o.winRate, 0) /
              objections.length
          )
        : 0;

    // Find most common category
    const categoryCount: Record<string, number> = {};
    for (const o of objections) {
      categoryCount[o.category] =
        (categoryCount[o.category] || 0) + o.mentionCount;
    }
    const mostCommonCategory =
      Object.entries(categoryCount).sort((a, b) => b[1] - a[1])[0]?.[0] ||
      "none";

    // Count new this month
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    const newThisMonth = await ctx.prisma.salesObjection.count({
      where: { ...where, createdAt: { gte: monthStart } },
    });

    return {
      total,
      avgWinRate,
      mostCommonCategory,
      totalMentions,
      newThisMonth,
    };
  }),

  // ---- Create a new objection ----
  create: protectedProcedure
    .input(
      z.object({
        objectionText: z.string().min(1),
        category: z
          .enum([
            "pricing",
            "competition",
            "trust",
            "timing",
            "product",
            "authority",
            "need",
            "other",
          ])
          .default("other"),
        mentionCount: z.number().default(1),
        winRate: z.number().min(0).max(100).default(0),
        generateResponses: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { generateResponses, ...data } = input;

      const objection = await ctx.prisma.salesObjection.create({
        data: {
          ...data,
          tenantId: ctx.tenantId,
          lastMentionedAt: new Date(),
        },
      });

      // Auto-generate AI responses if requested
      if (generateResponses) {
        try {
          // Get company context for better responses
          const companyInfo = await ctx.prisma.companyInfo.findUnique({
            where: { tenantId: ctx.tenantId },
          });
          const products = await ctx.prisma.product.findMany({
            where: { tenantId: ctx.tenantId, active: true },
            take: 10,
          });

          const aiResponses = await generateObjectionResponses({
            objectionText: input.objectionText,
            category: input.category,
            companyContext: {
              vision: companyInfo?.vision || undefined,
              mission: companyInfo?.mission || undefined,
              products: products.map((p) => ({
                name: p.name,
                description: p.description || undefined,
                price: p.price || undefined,
              })),
            },
          });

          // Store each response field
          const fields = [
            {
              fieldName: "recommendedResponse",
              content: aiResponses.recommendedResponse,
            },
            { fieldName: "talkTrack", content: aiResponses.talkTrack },
            {
              fieldName: "keyDifferentiators",
              content: aiResponses.keyDifferentiators,
            },
          ];

          await ctx.prisma.objectionResponse.createMany({
            data: fields.map((f) => ({
              objectionId: objection.id,
              fieldName: f.fieldName,
              content: f.content,
              originalContent: f.content,
              status: "auto_generated" as const,
              llmModel: "claude-sonnet-4-20250514",
              llmPromptVersion: "v1",
              version: 1,
            })),
          });
        } catch (error) {
          console.error("Failed to generate AI responses:", error);
          // Objection still created — responses can be generated later
        }
      }

      // Return with responses
      return ctx.prisma.salesObjection.findUnique({
        where: { id: objection.id },
        include: { responses: true },
      });
    }),

  // ---- Update an objection response (inline edit) ----
  updateResponse: protectedProcedure
    .input(
      z.object({
        objectionId: z.string().uuid(),
        fieldName: z.string(),
        content: z.string().min(1),
        editedBy: z.string().default("user"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify tenant owns the objection
      const objection = await ctx.prisma.salesObjection.findFirst({
        where: { id: input.objectionId, tenantId: ctx.tenantId },
      });

      if (!objection) {
        throw new Error("Sales objection not found");
      }

      // Find the current response for this field
      const currentResponse = await ctx.prisma.objectionResponse.findFirst({
        where: {
          objectionId: input.objectionId,
          fieldName: input.fieldName,
        },
        orderBy: { version: "desc" },
      });

      if (!currentResponse) {
        throw new Error("Response field not found");
      }

      // Create edit history entry
      await ctx.prisma.objectionEditHistory.create({
        data: {
          responseId: currentResponse.id,
          previousContent: currentResponse.content,
          newContent: input.content,
          editedBy: input.editedBy,
        },
      });

      // Update the response
      return ctx.prisma.objectionResponse.update({
        where: { id: currentResponse.id },
        data: {
          content: input.content,
          status: "edited",
          editedBy: input.editedBy,
          editedAt: new Date(),
        },
      });
    }),

  // ---- Revert a response to original AI-generated content ----
  revertResponse: protectedProcedure
    .input(
      z.object({
        objectionId: z.string().uuid(),
        fieldName: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const objection = await ctx.prisma.salesObjection.findFirst({
        where: { id: input.objectionId, tenantId: ctx.tenantId },
      });

      if (!objection) {
        throw new Error("Sales objection not found");
      }

      const response = await ctx.prisma.objectionResponse.findFirst({
        where: {
          objectionId: input.objectionId,
          fieldName: input.fieldName,
        },
        orderBy: { version: "desc" },
      });

      if (!response || !response.originalContent) {
        throw new Error("No original content to revert to");
      }

      // Log the revert in edit history
      await ctx.prisma.objectionEditHistory.create({
        data: {
          responseId: response.id,
          previousContent: response.content,
          newContent: response.originalContent,
          editedBy: "system:revert",
        },
      });

      return ctx.prisma.objectionResponse.update({
        where: { id: response.id },
        data: {
          content: response.originalContent,
          status: "auto_generated",
          editedBy: null,
          editedAt: null,
        },
      });
    }),

  // ---- Regenerate AI response for a specific field ----
  regenerateResponse: protectedProcedure
    .input(
      z.object({
        objectionId: z.string().uuid(),
        fieldName: z.string(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const objection = await ctx.prisma.salesObjection.findFirst({
        where: { id: input.objectionId, tenantId: ctx.tenantId },
      });

      if (!objection) {
        throw new Error("Sales objection not found");
      }

      // Get current content for context
      const currentResponse = await ctx.prisma.objectionResponse.findFirst({
        where: {
          objectionId: input.objectionId,
          fieldName: input.fieldName,
        },
        orderBy: { version: "desc" },
      });

      // Generate new content via LLM
      const newContent = await regenerateSingleField(
        objection.objectionText,
        objection.category,
        input.fieldName,
        currentResponse?.content
      );

      if (currentResponse) {
        // Log edit history
        await ctx.prisma.objectionEditHistory.create({
          data: {
            responseId: currentResponse.id,
            previousContent: currentResponse.content,
            newContent,
            editedBy: "ai:regenerate",
          },
        });

        // Update existing response
        return ctx.prisma.objectionResponse.update({
          where: { id: currentResponse.id },
          data: {
            content: newContent,
            originalContent: newContent,
            status: "auto_generated",
            llmModel: "claude-haiku-4-5-20251001",
            editedBy: null,
            editedAt: null,
          },
        });
      } else {
        // Create new response
        return ctx.prisma.objectionResponse.create({
          data: {
            objectionId: input.objectionId,
            fieldName: input.fieldName,
            content: newContent,
            originalContent: newContent,
            status: "auto_generated",
            llmModel: "claude-haiku-4-5-20251001",
            llmPromptVersion: "v1",
            version: 1,
          },
        });
      }
    }),

  // ---- Delete (soft) an objection ----
  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.salesObjection.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Sales objection not found");
      }

      return ctx.prisma.salesObjection.update({
        where: { id: input.id },
        data: { active: false },
      });
    }),
});

// ============================================================================
// SETTINGS ROUTER — Real Prisma-backed endpoints
// ============================================================================

// ─── KAN-451: ChannelConnection ↔ CommunicationChannel DTO mappers ────────
// ChannelConnection is the production model (KAN-661 Resend simple-mode +
// action-send subscriber both depend on it). Settings UI consumes the
// CommunicationChannel DTO shape. These mappers translate at the router boundary.

const TYPE_TO_CHANNEL_TYPE = {
  email: "EMAIL",
  sms: "SMS",
  whatsapp: "WHATSAPP",
  messenger: "MESSENGER",
} as const;

const CHANNEL_TYPE_TO_TYPE: Record<string, "email" | "sms" | "whatsapp" | "messenger"> = {
  EMAIL: "email",
  SMS: "sms",
  WHATSAPP: "whatsapp",
  MESSENGER: "messenger",
};

const CONNECTION_STATUS_TO_DTO_STATUS: Record<string, "connected" | "disconnected" | "error"> = {
  ACTIVE: "connected",
  PENDING: "disconnected",
  SUSPENDED: "disconnected",
  REVOKED: "disconnected",
  ERROR: "error",
};

const DTO_STATUS_TO_CONNECTION_STATUS = {
  connected: "ACTIVE",
  disconnected: "PENDING",
  error: "ERROR",
} as const;

interface CommunicationChannelDto {
  id: string;
  tenantId: string;
  type: "email" | "sms" | "whatsapp" | "messenger";
  provider: string;
  config: Record<string, unknown>;
  status: "connected" | "disconnected" | "error";
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// KAN-454: build the Record<string, boolean> shape the Settings UI expects.
// Defaults match apps/web/src/app/settings/page.tsx initial state (line 132-133).
function buildNotifPrefsRecord(
  rows: Array<{ type: string; enabled: boolean }>,
): {
  escalation: boolean;
  daily_digest: boolean;
  weekly_report: boolean;
  brain_update: boolean;
} {
  const map = Object.fromEntries(rows.map((r) => [r.type, r.enabled]));
  return {
    escalation: map.escalation ?? true,
    daily_digest: map.daily_digest ?? true,
    weekly_report: map.weekly_report ?? true,
    brain_update: map.brain_update ?? false,
  };
}

function mapChannelConnectionToDto(conn: ChannelConnection): CommunicationChannelDto {
  return {
    id: conn.id,
    tenantId: conn.tenantId,
    type: CHANNEL_TYPE_TO_TYPE[conn.channelType] ?? "email",
    provider: conn.provider,
    config: (conn.metadata as Record<string, unknown>) ?? {},
    status: CONNECTION_STATUS_TO_DTO_STATUS[conn.status] ?? "disconnected",
    lastTestedAt: conn.lastHealthCheck?.toISOString() ?? null,
    createdAt: conn.createdAt.toISOString(),
    updatedAt: conn.updatedAt.toISOString(),
  };
}

const settingsRouter = router({
  // KAN-450 — AI Configuration. tenant-scoped via ctx.tenantId (replaces the
  // prior input.tenantId pattern, which was both a tenant-isolation hole AND
  // misaligned with the frontend wrapper that doesn't pass tenantId).
  ai: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      const tenant = await ctx.prisma.tenant.findUnique({
        where: { id: ctx.tenantId },
        select: {
          confidenceThreshold: true,
          autoApproveEnabled: true,
          dailyActionLimit: true,
          strategyPermissions: true,
          guardrailSettings: true,
          aiPermissions: true,
        },
      });
      if (!tenant) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
      }
      return tenant;
    }),
    update: protectedProcedure
      .input(
        z
          .object({
            confidenceThreshold: z.number().int().min(20).max(95).optional(),
            autoApproveEnabled: z.boolean().optional(),
            dailyActionLimit: z.number().int().min(1).max(10000).optional(),
            strategyPermissions: z.record(z.boolean()).optional(),
            guardrailSettings: z.record(z.boolean()).optional(),
            // aiPermissions stays a free-form catch-all — Decision Engine
            // services (data-quality.ts, company-truth.ts) read nested keys.
            aiPermissions: z.record(z.any()).optional(),
          })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        const updated = await ctx.prisma.tenant.update({
          where: { id: ctx.tenantId },
          data: input,
          select: {
            confidenceThreshold: true,
            autoApproveEnabled: true,
            dailyActionLimit: true,
            strategyPermissions: true,
            guardrailSettings: true,
            aiPermissions: true,
          },
        });
        return updated;
      }),
  }),

  // KAN-451 — Communication Channels. Backed by ChannelConnection (KAN-661;
  // production model used by the Resend simple-mode adapter + action-send
  // subscriber). Mapper translates between ChannelConnection's internal shape
  // and the CommunicationChannel DTO the Settings UI expects. tenant-scoped
  // via ctx.tenantId (replaces the prior input.tenantId pattern + the phantom
  // prisma.communicationChannel calls that would have thrown at runtime).
  channels: router({
    list: protectedProcedure.query(async ({ ctx }) => {
      // Most-recently-connected wins per channelType. Multiple ChannelConnection
      // rows per tenant per channelType are allowed by the schema (different
      // providerAccountId), but the Settings UI shows one card per type.
      const conns = await ctx.prisma.channelConnection.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { connectedAt: "desc" },
      });
      const byType = new Map<string, (typeof conns)[number]>();
      for (const conn of conns) {
        if (!byType.has(conn.channelType)) byType.set(conn.channelType, conn);
      }
      return Array.from(byType.values()).map(mapChannelConnectionToDto);
    }),

    update: protectedProcedure
      .input(
        z
          .object({
            type: z.enum(["email", "sms", "whatsapp", "messenger"]),
            provider: z.string().min(1),
            config: z.record(z.any()).optional(),
            status: z.enum(["connected", "disconnected", "error"]).optional(),
          })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        const channelType = TYPE_TO_CHANNEL_TYPE[input.type];
        const connectionStatus = DTO_STATUS_TO_CONNECTION_STATUS[input.status ?? "disconnected"];
        // Synthetic providerAccountId per (provider, channelType) for
        // Settings-UI-managed rows. KAN-472/473/474 will create rows with
        // real providerAccountIds (subuser SIDs, page IDs, etc.).
        const providerAccountId = `${input.provider.toLowerCase()}-default`;
        const updated = await ctx.prisma.channelConnection.upsert({
          where: {
            tenantId_channelType_providerAccountId: {
              tenantId: ctx.tenantId,
              channelType,
              providerAccountId,
            },
          },
          update: {
            provider: input.provider,
            status: connectionStatus,
            ...(input.config ? { metadata: input.config as Prisma.InputJsonValue } : {}),
            ...(connectionStatus === "ACTIVE" ? { connectedAt: new Date() } : {}),
          },
          create: {
            tenantId: ctx.tenantId,
            channelType,
            provider: input.provider,
            providerAccountId,
            status: connectionStatus,
            // credentialsRef placeholder — KAN-472/473/474 epics replace with
            // real Secret Manager paths when provider keys are provisioned.
            credentialsRef: "pending",
            label: `${input.provider} ${input.type}`,
            metadata: (input.config as Prisma.InputJsonValue) ?? {},
            ...(connectionStatus === "ACTIVE" ? { connectedAt: new Date() } : {}),
          },
        });
        return mapChannelConnectionToDto(updated);
      }),

    // testConnection — per-provider credential validation. KAN-474 lit up the
    // messenger branch (Graph /me with the stored Page Access Token). Other
    // channels stay stubbed pending KAN-472 (Twilio) / KAN-473 (Resend).
    testConnection: protectedProcedure
      .input(z.object({ type: z.enum(["email", "sms", "whatsapp", "messenger"]) }).strict())
      .mutation(async ({ ctx, input }) => {
        if (input.type === "messenger") {
          const conn = await ctx.prisma.channelConnection.findFirst({
            where: {
              tenantId: ctx.tenantId,
              channelType: "MESSENGER",
              provider: "meta",
              status: "ACTIVE",
            },
            orderBy: { connectedAt: "desc" },
          });
          if (!conn) {
            return { success: false, message: "No active Messenger connection — connect first." };
          }
          let pageAccessToken: string | undefined;
          try {
            const sm = new SecretManagerServiceClient();
            const [version] = await sm.accessSecretVersion({ name: conn.credentialsRef });
            const raw = version.payload?.data?.toString();
            if (raw) {
              const payload = JSON.parse(raw) as { pageAccessToken?: string };
              pageAccessToken = payload.pageAccessToken;
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            return { success: false, message: `Could not load page token: ${msg}` };
          }
          if (!pageAccessToken) {
            return { success: false, message: "Page token missing from Secret Manager payload." };
          }
          const result = await validatePageToken(pageAccessToken);
          if (result.ok) {
            return {
              success: true,
              message: `Connected as ${result.pageName}`,
              pageId: result.pageId,
              pageName: result.pageName,
            };
          }
          return {
            success: false,
            message: result.detail ?? `Validation failed (${result.reason})`,
            reason: result.reason,
          };
        }
        // TODO(KAN-472|KAN-473): per-provider validation for email / sms / whatsapp
        return {
          success: false,
          message:
            "Per-provider connection test deferred to KAN-472 (Twilio) / KAN-473 (Resend) epics.",
        };
      }),
  }),

  integrations: router({
    list: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        return ctx.prisma.integration.findMany({
          where: { tenantId: input.tenantId },
          orderBy: { createdAt: "desc" },
        });
      }),
    connect: protectedProcedure
      .input(
        z.object({
          tenantId: z.string().uuid(),
          provider: z.string().min(1),
          category: z.enum(["crm", "payments", "calendar", "commerce", "advertising", "other"]),
          config: z.record(z.any()).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { tenantId, provider, category, config } = input;
        return ctx.prisma.integration.upsert({
          where: { tenantId_provider: { tenantId, provider } },
          update: { status: "connected", config: config ?? undefined, lastSyncAt: new Date() },
          create: { tenantId, provider, category, status: "connected", config: config ?? {}, lastSyncAt: new Date() },
        });
      }),
    disconnect: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid(), id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.integration.update({
          where: { id: input.id },
          data: { status: "disconnected" },
        });
      }),
    sync: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid(), id: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        await ctx.prisma.integration.update({ where: { id: input.id }, data: { status: "syncing" } });
        return ctx.prisma.integration.update({
          where: { id: input.id },
          data: { status: "connected", lastSyncAt: new Date() },
        });
      }),
  }),

  team: router({
    list: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const [members, invitations] = await Promise.all([
          ctx.prisma.teamMember.findMany({ where: { tenantId: input.tenantId }, orderBy: { createdAt: "asc" } }),
          ctx.prisma.invitation.findMany({ where: { tenantId: input.tenantId, status: "pending" }, orderBy: { createdAt: "desc" } }),
        ]);
        return { members, invitations };
      }),
    invite: protectedProcedure
      .input(
        z.object({
          tenantId: z.string().uuid(),
          email: z.string().email(),
          role: z.enum(["owner", "admin", "agent", "viewer"]).default("viewer"),
          invitedBy: z.string(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { tenantId, email, role, invitedBy } = input;
        const existing = await ctx.prisma.teamMember.findUnique({ where: { tenantId_email: { tenantId, email } } });
        if (existing) { throw new TRPCError({ code: "CONFLICT", message: "User is already a team member" }); }
        const existingInvite = await ctx.prisma.invitation.findFirst({ where: { tenantId, email, status: "pending" } });
        if (existingInvite) { throw new TRPCError({ code: "CONFLICT", message: "An invitation is already pending for this email" }); }
        return ctx.prisma.invitation.create({
          data: { tenantId, email, role, invitedBy, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) },
        });
      }),
    updateRole: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid(), memberId: z.string().uuid(), role: z.enum(["owner", "admin", "agent", "viewer"]) }))
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.teamMember.update({ where: { id: input.memberId }, data: { role: input.role } });
      }),
    remove: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid(), memberId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const member = await ctx.prisma.teamMember.findUnique({ where: { id: input.memberId } });
        if (member?.role === "owner") {
          const ownerCount = await ctx.prisma.teamMember.count({ where: { tenantId: input.tenantId, role: "owner" } });
          if (ownerCount <= 1) { throw new TRPCError({ code: "FORBIDDEN", message: "Cannot remove the last owner" }); }
        }
        return ctx.prisma.teamMember.delete({ where: { id: input.memberId } });
      }),
    cancelInvite: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid(), invitationId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        return ctx.prisma.invitation.update({ where: { id: input.invitationId }, data: { status: "cancelled" } });
      }),
  }),

  // KAN-454 — Notifications. Per-user, per-tenant, per-type preference rows.
  // Returns Record<string, boolean> shape that the frontend's NotificationPrefs
  // type expects (apps/web/src/lib/api.ts:247). Previously returned an array
  // and called a phantom prisma.notificationPreference model — both fixed.
  // tenant-scoped via ctx.tenantId; user-scoped via ctx.firebaseUser?.uid.
  notifications: router({
    get: protectedProcedure.query(async ({ ctx }) => {
      // TODO(KAN-455): tighten user-auth enforcement when Security Settings ships.
      // 'unknown' fallback matches wedgeRouter precedent; acceptable pre-launch.
      const userId = ctx.firebaseUser?.uid ?? "unknown";
      const rows = await ctx.prisma.notificationPreference.findMany({
        where: { tenantId: ctx.tenantId, userId },
      });
      return buildNotifPrefsRecord(rows);
    }),

    update: protectedProcedure
      .input(
        z
          .object({
            type: z.enum([
              "escalation",
              "daily_digest",
              "weekly_report",
              "brain_update",
            ]),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .mutation(async ({ ctx, input }) => {
        // TODO(KAN-455): tighten user-auth enforcement when Security Settings ships.
        const userId = ctx.firebaseUser?.uid ?? "unknown";
        await ctx.prisma.notificationPreference.upsert({
          where: {
            tenantId_userId_type: {
              tenantId: ctx.tenantId,
              userId,
              type: input.type,
            },
          },
          update: { enabled: input.enabled },
          create: {
            tenantId: ctx.tenantId,
            userId,
            type: input.type,
            enabled: input.enabled,
          },
        });
        // Return the full updated record — frontend's auto-save UX
        // (setNotifPrefs(updated)) expects the whole map, not the single row.
        const rows = await ctx.prisma.notificationPreference.findMany({
          where: { tenantId: ctx.tenantId, userId },
        });
        return buildNotifPrefsRecord(rows);
      }),
  }),

  security: router({
    get: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        return ctx.prisma.securitySetting.upsert({
          where: { tenantId: input.tenantId },
          update: {},
          create: { tenantId: input.tenantId },
        });
      }),
    update: protectedProcedure
      .input(
        z.object({
          tenantId: z.string().uuid(),
          twoFactorEnabled: z.boolean().optional(),
          ssoEnabled: z.boolean().optional(),
          ssoProvider: z.string().nullable().optional(),
          ssoConfig: z.record(z.any()).optional(),
          auditRetentionDays: z.number().min(30).max(2555).optional(),
          gdprCompliant: z.boolean().optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { tenantId, ...data } = input;
        return ctx.prisma.securitySetting.upsert({
          where: { tenantId },
          update: data,
          create: { tenantId, ...data },
        });
      }),
    getAuditLog: protectedProcedure
      .input(
        z.object({
          tenantId: z.string().uuid(),
          limit: z.number().min(1).max(100).default(50),
          offset: z.number().min(0).default(0),
          actionType: z.string().optional(),
        })
      )
      .query(async ({ ctx, input }) => {
        const { tenantId, limit, offset, actionType } = input;
        const where = { tenantId, ...(actionType ? { actionType } : {}) };
        const [items, total] = await Promise.all([
          ctx.prisma.auditLog.findMany({ where, orderBy: { createdAt: "desc" }, take: limit, skip: offset }),
          ctx.prisma.auditLog.count({ where }),
        ]);
        return { items, total, limit, offset };
      }),
  }),
});

// ============================================================================
// WEDGE ROUTER — KAN-655 Day-1 Wedge (opportunities + playbook launch)
// ============================================================================

// ─────────────────────────────────────────────────────────────────────────────
// outcomesRouter — KAN-657 (action.executed → ActionOutcome write path)
// ─────────────────────────────────────────────────────────────────────────────
const outcomesRouter = router({
  // Outcome events for one Decision, ordered by occurrence.
  forDecision: protectedProcedure
    .input(z.object({ decisionId: z.string() }))
    .query(async ({ ctx, input }) => {
      const rows = await (ctx.prisma as any).actionOutcome.findMany({
        where: { tenantId: ctx.tenantId, decisionId: input.decisionId },
        orderBy: { occurredAt: "asc" },
      });
      return rows;
    }),

  // Per-opportunity counts: sent / failed / suppressed (and any other status
  // values that show up later — delivered/opened/clicked land via KAN-684).
  // JOIN-shape — Decision.metadata.opportunityType is set by the wedge router
  // on launch; we filter Decisions by that, then aggregate ActionOutcomes.
  summaryForOpportunity: protectedProcedure
    .input(
      z.object({
        opportunityType: z.string(),
        since: z.string().datetime().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const sinceDate = input.since ? new Date(input.since) : null;

      // Pull decisionIds matching this opportunityType in tenant.
      // Decision.metadata is JSON — Prisma's path filter for postgres.
      const decisions = await ctx.prisma.decision.findMany({
        where: {
          tenantId: ctx.tenantId,
          metadata: {
            path: ["opportunityType"],
            equals: input.opportunityType,
          },
          ...(sinceDate ? { createdAt: { gte: sinceDate } } : {}),
        },
        select: { id: true, createdAt: true },
      });

      const decisionIds = decisions.map((d: { id: string }) => d.id);
      if (decisionIds.length === 0) {
        return { sent: 0, failed: 0, suppressed: 0, delivered: 0, total: 0, lastLaunchedAt: null };
      }

      const rows: Array<{ status: string }> = await (ctx.prisma as any).actionOutcome.findMany({
        where: { tenantId: ctx.tenantId, decisionId: { in: decisionIds } },
        select: { status: true },
      });

      const counts = { sent: 0, failed: 0, suppressed: 0, delivered: 0 };
      for (const r of rows) {
        if (r.status in counts) (counts as Record<string, number>)[r.status] += 1;
      }
      const lastLaunchedAt = decisions.reduce<Date | null>(
        (acc: Date | null, d: { createdAt: Date }) =>
          !acc || d.createdAt > acc ? d.createdAt : acc,
        null
      );
      return { ...counts, total: rows.length, lastLaunchedAt: lastLaunchedAt?.toISOString() ?? null };
    }),
});

const wedgeRouter = router({
  // Scan tenant contacts → signal detector → opportunity matcher.
  // Attach playbook preview + sample contact list to each opportunity.
  opportunities: protectedProcedure.query(async ({ ctx }) => {
    const contacts = await ctx.prisma.contact.findMany({
      where: { tenantId: ctx.tenantId },
    });

    const signals = detectSignals(contacts as any);
    const opportunities = matchOpportunities(signals);

    const enriched = opportunities.map((opp) => {
      const playbook = WEDGE_PLAYBOOKS[opp.playbookSlug];
      const sampleContacts = contacts
        .filter((c: any) => opp.entityIds.includes(c.id))
        .slice(0, 5)
        .map((c: any) => ({
          id: c.id,
          name:
            [c.firstName, c.lastName].filter(Boolean).join(" ") ||
            c.email ||
            c.id,
          email: c.email ?? null,
          lifecycleStage: c.lifecycleStage ?? null,
        }));
      return {
        ...opp,
        playbook: playbook
          ? {
              slug: playbook.slug,
              name: playbook.name,
              description: playbook.description,
              steps: playbook.steps.map((s) => ({
                day: s.day,
                channel: s.channel,
                intent: s.intent,
              })),
            }
          : null,
        sampleContacts,
      };
    });

    return {
      opportunities: enriched,
      summary: {
        totalContacts: contacts.length,
        totalSignals: signals.length,
        totalOpportunities: enriched.length,
        generatedAt: new Date().toISOString(),
      },
    };
  }),

  // Launch step 0 of the playbook against every entity in the selected
  // opportunity. Each contact goes through runDecisionForContact with a
  // playbookStepContext (adapter pattern; file #3 adds that param to
  // RunForContactInput — until then the call type-errors on the extra field).
  launch: protectedProcedure
    .input(
      z.object({
        opportunityType: z.enum([
          "dormant_reactivation",
          "high_intent_no_touch",
          "data_enrichment",
        ]),
        playbookSlug: z.string(),
        dryRun: z.boolean().default(true),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Re-derive the opportunity (fresh truth, not stale client state).
      const contacts = await ctx.prisma.contact.findMany({
        where: { tenantId: ctx.tenantId },
      });
      const signals = detectSignals(contacts as any);
      const opportunities = matchOpportunities(signals);
      const opp = opportunities.find((o) => o.type === input.opportunityType);
      if (!opp) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: `No current opportunity of type ${input.opportunityType}`,
        });
      }

      const stepContext = buildPlaybookStepContext(input.playbookSlug, 0);
      const actorId = ctx.firebaseUser?.uid ?? "wedge";

      const results: Array<
        | { entityId: string; outcome: string; decisionId: string }
        | { entityId: string; error: string }
      > = [];

      for (const entityId of opp.entityIds) {
        try {
          const r = await runDecisionForContact(ctx.prisma, {
            tenantId: ctx.tenantId,
            contactId: entityId,
            actor: { type: "USER", id: actorId },
            playbookStepContext: {
              ...stepContext,
              additionalContext: {
                ...stepContext.additionalContext,
                dryRun: input.dryRun,
                opportunityType: input.opportunityType,
              },
            },
          });
          results.push({
            entityId,
            outcome: r.outcome,
            decisionId: r.decisionId,
          });
        } catch (err) {
          results.push({ entityId, error: String(err) });
        }
      }

      return {
        launched: results.filter((r) => !("error" in r)).length,
        errors: results.filter((r) => "error" in r).length,
        dryRun: input.dryRun,
        opportunityType: input.opportunityType,
        playbookSlug: input.playbookSlug,
        results,
      };
    }),
});

// ============================================================================
// PIPELINES — KAN-702 PR A
//
// Five sibling routers covering Pipeline configuration end-to-end:
//   - pipelinesRouter:           list / getById / create / update / toggleActive
//   - stagesRouter:              reorder / update / delete (lead-count safety)
//   - targetsRouter:             upsert by (pipelineId, metric, period)
//   - knowledgeFiltersRouter:    upsert per (pipelineId, knowledgeCategory)
//   - pipelineMicroObjectivesRouter: setForPipeline (replace-all per pipeline)
//
// Mutations gated by adminProcedure (requires owner|admin TeamMember role for
// the active tenant). Queries use protectedProcedure (any tenant member can
// read their own pipelines). Cast-loose `(prisma as any)` accessors on the
// new Prisma delegates keep the new types out of the apps/api TS6059 graph
// (same pattern as KAN-700 / KAN-703 / KAN-704 / KAN-705).
//
// Pure validation helpers live in `packages/api/src/services/pipeline-validation.ts`
// and are tested via the apps/connectors vitest bridge.
// ============================================================================

// Canonical zod enum mirrors live in @growth/shared (KAN-737). Drift test
// asserting parity with Prisma sits in packages/shared/src/__tests__/.

const StageInputSchema = z.object({
  id: z.string().uuid().optional(),
  name: z.string().min(1).max(80),
  order: z.number().int().min(0),
  isInitial: z.boolean().default(false),
  isTerminal: z.boolean().default(false),
  entryActions: z.unknown().optional(),
  transitionRules: z.unknown().optional(),
  autoApproveMatrix: z.unknown().optional(),
});

const pipelinesRouter = router({
  // List the tenant's pipelines with computed counts (active leads + stages)
  // and the current period's target progress where a Target row exists.
  list: protectedProcedure.query(async ({ ctx }) => {
    const pipelines: any[] =
      (await (ctx.prisma as any).pipeline?.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        include: {
          targets: true,
          stages: { select: { id: true } },
          contacts: { select: { id: true } },
        },
      })) ?? [];

    return pipelines.map((p) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      isActive: p.isActive,
      order: p.order,
      objectiveType: p.objectiveType,
      objectiveDescription: p.objectiveDescription,
      stageCount: p.stages?.length ?? 0,
      activeLeadCount: p.contacts?.length ?? 0,
      targets: (p.targets ?? []).map((t: any) => ({
        metric: t.metric,
        period: t.period,
        value: typeof t.value === "object" && "toNumber" in t.value ? t.value.toNumber() : Number(t.value),
        currentProgress:
          t.currentProgress == null
            ? null
            : typeof t.currentProgress === "object" && "toNumber" in t.currentProgress
              ? t.currentProgress.toNumber()
              : Number(t.currentProgress),
      })),
    }));
  }),

  // Full nested fetch for the wizard's edit flow.
  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const p: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
        include: {
          stages: { orderBy: { order: "asc" } },
          targets: true,
          knowledgeFilters: true,
          microObjectives: { include: { microObjective: true } },
        },
      });
      if (!p) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      return {
        id: p.id,
        name: p.name,
        description: p.description,
        isActive: p.isActive,
        order: p.order,
        objectiveType: p.objectiveType,
        objectiveDescription: p.objectiveDescription,
        defaultAutoApproveMatrix: p.defaultAutoApproveMatrix,
        stages: (p.stages ?? []).map((s: any) => ({
          id: s.id,
          name: s.name,
          order: s.order,
          isInitial: s.isInitial,
          isTerminal: s.isTerminal,
          entryActions: s.entryActions,
          transitionRules: s.transitionRules,
          autoApproveMatrix: s.autoApproveMatrix,
        })),
        targets: (p.targets ?? []).map((t: any) => ({
          id: t.id,
          metric: t.metric,
          period: t.period,
          value: typeof t.value === "object" && "toNumber" in t.value ? t.value.toNumber() : Number(t.value),
          currentProgress:
            t.currentProgress == null
              ? null
              : typeof t.currentProgress === "object" && "toNumber" in t.currentProgress
                ? t.currentProgress.toNumber()
                : Number(t.currentProgress),
        })),
        knowledgeFilters: (p.knowledgeFilters ?? []).map((f: any) => ({
          id: f.id,
          knowledgeCategory: f.knowledgeCategory,
          includeRule: f.includeRule,
          excludeRule: f.excludeRule,
        })),
        microObjectives: (p.microObjectives ?? []).map((pmo: any) => ({
          microObjectiveId: pmo.microObjectiveId,
          isActive: pmo.isActive,
          name: pmo.microObjective?.name,
          description: pmo.microObjective?.description,
          isDefault: pmo.microObjective?.isDefault,
        })),
      };
    }),

  // Create with nested write of stages. Targets / KnowledgeFilters /
  // MicroObjective associations land via the dedicated routers below — keeps
  // each mutation small + lets the wizard fire them in parallel after the
  // pipeline shell exists.
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(1000).optional().nullable(),
        objectiveType: ObjectiveTypeEnum,
        objectiveDescription: z.string().max(2000).optional().nullable(),
        order: z.number().int().min(0).default(0),
        stages: z.array(StageInputSchema).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Validate the form payload against pipeline-validation rules.
      const v = validatePipelineForm({
        name: input.name,
        description: input.description ?? null,
        objectiveType: input.objectiveType,
        objectiveDescription: input.objectiveDescription ?? null,
        stages: input.stages.map((s) => ({
          name: s.name,
          order: s.order,
          isInitial: s.isInitial,
          isTerminal: s.isTerminal,
        })),
      });
      if (!v.valid) {
        throw new TRPCError({ code: "BAD_REQUEST", message: v.errors.join("; ") });
      }
      // Tenant-unique name check.
      const existing: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { tenantId: ctx.tenantId, name: input.name },
        select: { id: true },
      });
      if (existing) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `Pipeline name "${input.name}" already exists in this tenant`,
        });
      }
      const created: any = await (ctx.prisma as any).pipeline?.create({
        data: {
          tenantId: ctx.tenantId,
          name: input.name,
          description: input.description ?? null,
          objectiveType: input.objectiveType,
          objectiveDescription: input.objectiveDescription ?? null,
          order: input.order,
          isActive: true,
          stages: {
            create: input.stages.map((s) => ({
              name: s.name,
              order: s.order,
              isInitial: s.isInitial,
              isTerminal: s.isTerminal,
              entryActions: (s.entryActions ?? []) as any,
              transitionRules: (s.transitionRules ?? []) as any,
              autoApproveMatrix: (s.autoApproveMatrix ?? {}) as any,
            })),
          },
        },
        include: { stages: { orderBy: { order: "asc" } } },
      });
      return created;
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(100).optional(),
        description: z.string().max(1000).optional().nullable(),
        objectiveType: ObjectiveTypeEnum.optional(),
        objectiveDescription: z.string().max(2000).optional().nullable(),
        order: z.number().int().min(0).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const existing: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      if (input.name && input.name !== existing.name) {
        const conflict: any = await (ctx.prisma as any).pipeline?.findFirst({
          where: { tenantId: ctx.tenantId, name: input.name, NOT: { id: input.id } },
          select: { id: true },
        });
        if (conflict) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `Pipeline name "${input.name}" already exists in this tenant`,
          });
        }
      }
      const { id, ...data } = input;
      return (ctx.prisma as any).pipeline?.update({ where: { id }, data });
    }),

  toggleActive: adminProcedure
    .input(z.object({ id: z.string().uuid(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const existing: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      return (ctx.prisma as any).pipeline?.update({
        where: { id: input.id },
        data: { isActive: input.isActive },
      });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const pipeline: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
        select: { id: true, contacts: { select: { id: true } } },
      });
      if (!pipeline) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      // KAN-793: stage-transition audit moved to DealStageHistory (deal-scoped
      // per KAN-791). Same semantic — count audit-trail transitions whose
      // destination Stage belongs to this Pipeline.
      const stageHistoryCount: number =
        (await (ctx.prisma as any).dealStageHistory?.count({
          where: { toStage: { pipelineId: input.id } },
        })) ?? 0;
      const decision = canDeletePipeline({
        activeLeadCount: pipeline.contacts?.length ?? 0,
        stageHistoryCount,
      });
      if (!decision.canDelete) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: decision.reason ?? "Cannot delete pipeline" });
      }
      await (ctx.prisma as any).pipeline?.delete({ where: { id: input.id } });
      return { id: input.id };
    }),
});

const stagesRouter = router({
  // Batch reorder. Caller passes the desired stage IDs in their new order;
  // we normalize to 0..N-1 + write all rows in one transaction. Validates
  // all stages belong to the same pipeline + the pipeline belongs to the
  // tenant.
  reorder: adminProcedure
    .input(
      z.object({
        pipelineId: z.string().uuid(),
        stageIdsInOrder: z.array(z.string().uuid()).min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const pipeline: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.pipelineId, tenantId: ctx.tenantId },
        include: { stages: true },
      });
      if (!pipeline) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      const existingStageIds = new Set(pipeline.stages.map((s: any) => s.id));
      const inputIds = new Set(input.stageIdsInOrder);
      if (inputIds.size !== input.stageIdsInOrder.length) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Duplicate stage IDs in reorder payload" });
      }
      if (inputIds.size !== existingStageIds.size) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Reorder payload must include every stage in the pipeline exactly once",
        });
      }
      for (const id of input.stageIdsInOrder) {
        if (!existingStageIds.has(id)) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `Stage ${id} does not belong to pipeline ${input.pipelineId}`,
          });
        }
      }
      // Normalize + write in a single transaction.
      const targetOrders = input.stageIdsInOrder.map((id, i) => ({ id, order: i }));
      await ctx.prisma.$transaction(
        targetOrders.map((t) =>
          (ctx.prisma as any).stage.update({ where: { id: t.id }, data: { order: t.order } }),
        ),
      );
      return { pipelineId: input.pipelineId, stages: targetOrders };
    }),

  update: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).max(80).optional(),
        isInitial: z.boolean().optional(),
        isTerminal: z.boolean().optional(),
        entryActions: z.unknown().optional(),
        transitionRules: z.unknown().optional(),
        autoApproveMatrix: z.unknown().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Tenant-scope check via the parent pipeline.
      const stage: any = await (ctx.prisma as any).stage?.findUnique({
        where: { id: input.id },
        include: { pipeline: { select: { tenantId: true, id: true } } },
      });
      if (!stage || stage.pipeline.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Stage not found in this tenant" });
      }
      // If isInitial is being set true, demote any other initial stage in the
      // same pipeline first (exactly-one invariant).
      if (input.isInitial === true) {
        await (ctx.prisma as any).stage?.updateMany({
          where: { pipelineId: stage.pipeline.id, isInitial: true, NOT: { id: input.id } },
          data: { isInitial: false },
        });
      }
      const { id, ...data } = input;
      return (ctx.prisma as any).stage?.update({ where: { id }, data: data as any });
    }),

  delete: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const stage: any = await (ctx.prisma as any).stage?.findUnique({
        where: { id: input.id },
        include: {
          pipeline: { select: { tenantId: true, id: true, stages: { where: { isInitial: true }, select: { id: true } } } },
          contacts: { select: { id: true } },
        },
      });
      if (!stage || stage.pipeline.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Stage not found in this tenant" });
      }
      const isOnlyInitial = stage.isInitial && stage.pipeline.stages.length === 1;
      const decision = canDeleteStage({
        activeLeadCount: stage.contacts?.length ?? 0,
        isInitial: stage.isInitial,
        isOnlyInitial,
      });
      if (!decision.canDelete) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: decision.reason ?? "Cannot delete stage" });
      }
      await (ctx.prisma as any).stage?.delete({ where: { id: input.id } });
      return { id: input.id };
    }),
});

const targetsRouter = router({
  upsert: adminProcedure
    .input(
      z.object({
        pipelineId: z.string().uuid(),
        metric: TargetMetricEnum,
        period: TargetPeriodEnum,
        value: z.number().nonnegative(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Verify the pipeline belongs to the tenant.
      const pipeline: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.pipelineId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!pipeline) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      return (ctx.prisma as any).target?.upsert({
        where: {
          pipelineId_metric_period: {
            pipelineId: input.pipelineId,
            metric: input.metric,
            period: input.period,
          },
        },
        create: {
          pipelineId: input.pipelineId,
          metric: input.metric,
          period: input.period,
          value: input.value,
        },
        update: { value: input.value },
      });
    }),
});

const knowledgeFiltersRouter = router({
  upsert: adminProcedure
    .input(
      z.object({
        pipelineId: z.string().uuid(),
        knowledgeCategory: KnowledgeCategoryEnum,
        includeRule: z.record(z.unknown()).default({}),
        excludeRule: z.record(z.unknown()).default({}),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const pipeline: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.pipelineId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!pipeline) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      return (ctx.prisma as any).knowledgeFilter?.upsert({
        where: {
          pipelineId_knowledgeCategory: {
            pipelineId: input.pipelineId,
            knowledgeCategory: input.knowledgeCategory,
          },
        },
        create: {
          pipelineId: input.pipelineId,
          knowledgeCategory: input.knowledgeCategory,
          includeRule: input.includeRule as any,
          excludeRule: input.excludeRule as any,
        },
        update: {
          includeRule: input.includeRule as any,
          excludeRule: input.excludeRule as any,
        },
      });
    }),

  delete: adminProcedure
    .input(z.object({ pipelineId: z.string().uuid(), knowledgeCategory: KnowledgeCategoryEnum }))
    .mutation(async ({ ctx, input }) => {
      const pipeline: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.pipelineId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!pipeline) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      await (ctx.prisma as any).knowledgeFilter?.deleteMany({
        where: { pipelineId: input.pipelineId, knowledgeCategory: input.knowledgeCategory },
      });
      return { pipelineId: input.pipelineId, knowledgeCategory: input.knowledgeCategory };
    }),
});

const pipelineMicroObjectivesRouter = router({
  // KAN-702 PR B — wizard's micro-objectives step needs the available set.
  // Returns platform defaults (tenantId IS NULL) + tenant-owned customs.
  listAvailable: protectedProcedure.query(async ({ ctx }) => {
    const rows: any[] =
      (await (ctx.prisma as any).microObjective?.findMany({
        where: { OR: [{ tenantId: null }, { tenantId: ctx.tenantId }] },
        orderBy: [{ tenantId: "asc" }, { name: "asc" }], // platform defaults first
      })) ?? [];
    return rows.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
      isDefault: m.tenantId == null,
    }));
  }),

  // Replace-all semantics: caller passes the full set of MicroObjective IDs
  // that should be active for the pipeline. We delete current associations,
  // then create the new set in a single transaction. Simpler than diffing on
  // the wire + matches the wizard's "checkbox set" UX.
  setForPipeline: adminProcedure
    .input(
      z.object({
        pipelineId: z.string().uuid(),
        microObjectiveIds: z.array(z.string().uuid()),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const pipeline: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: { id: input.pipelineId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!pipeline) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }
      // Each MicroObjective must be either platform-default (tenantId IS NULL)
      // or owned by this tenant — guards against cross-tenant MicroObjective
      // injection via the wizard.
      if (input.microObjectiveIds.length > 0) {
        const allowed: any[] = await (ctx.prisma as any).microObjective?.findMany({
          where: {
            id: { in: input.microObjectiveIds },
            OR: [{ tenantId: null }, { tenantId: ctx.tenantId }],
          },
          select: { id: true },
        });
        const allowedIds = new Set(allowed.map((m: any) => m.id));
        for (const id of input.microObjectiveIds) {
          if (!allowedIds.has(id)) {
            throw new TRPCError({
              code: "FORBIDDEN",
              message: `MicroObjective ${id} is not accessible to this tenant`,
            });
          }
        }
      }
      await ctx.prisma.$transaction(async (tx: any) => {
        await tx.pipelineMicroObjective.deleteMany({ where: { pipelineId: input.pipelineId } });
        if (input.microObjectiveIds.length > 0) {
          await tx.pipelineMicroObjective.createMany({
            data: input.microObjectiveIds.map((moId) => ({
              pipelineId: input.pipelineId,
              microObjectiveId: moId,
              isActive: true,
            })),
          });
        }
      });
      return { pipelineId: input.pipelineId, microObjectiveIds: input.microObjectiveIds };
    }),
});

// KAN-707 PR A — Knowledge ingestion service (typed contract + queue depth +
// publisher + tenant-scoped polling). PR B replaces the publisher's
// fire-and-forget shape with the actual URL crawl / doc upload / Q&A logic
// invoked from the push subscriber. PR A only stubs the worker.
const knowledgeIngestRouter = router({
  // Tenant submits an ingest request. Cross-tenant idempotency is enforced
  // at the schema level via KnowledgeSource.@@unique([tenantId, contentHash])
  // (KAN-706). Per-tenant queue depth (max 100 in-flight) is enforced here
  // before the KnowledgeSource row is created. The request publishes to
  // `knowledge.ingest.requested` for the worker (PR B) to pick up.
  request: protectedProcedure
    .input(IngestRequestSchema)
    .mutation(async ({ ctx, input }) => {
      // Per-tenant queue depth — count rows where source.tenantId = ctx.tenantId
      // AND status IN ('pending', 'processing'). >= limit → 429.
      const inFlight: number =
        (await (ctx.prisma as any).knowledgeIngestion?.count({
          where: {
            source: { tenantId: ctx.tenantId },
            status: { in: ["pending", "processing"] },
          },
        })) ?? 0;
      if (inFlight >= PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Per-tenant ingest queue depth limit (${PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT} in-flight) exceeded; retry once jobs complete`,
        });
      }

      // contentHash derivation per path. Cross-tenant uniqueness is the
      // (tenantId, contentHash) composite — same URL/file from two tenants
      // produces two distinct rows.
      let contentHash: string;
      let sourceUrl: string | null = null;
      let uploadedFileRef: string | null = null;
      let originalFileName: string | null = null;
      let sourceType: "url" | "document" | "qa_pair";
      switch (input.path) {
        case "url":
          contentHash = createHash("sha256").update(`url:${input.sourceUrl}:${input.crawlScope}`).digest("hex");
          sourceUrl = input.sourceUrl;
          sourceType = "url";
          break;
        case "document":
          contentHash = createHash("sha256").update(`doc:${input.uploadedFileRef}`).digest("hex");
          uploadedFileRef = input.uploadedFileRef;
          originalFileName = input.originalFileName;
          sourceType = "document";
          break;
        case "qa_pair":
          contentHash = createHash("sha256").update(`qa:${input.question}:${input.answer}`).digest("hex");
          sourceType = "qa_pair";
          break;
      }

      // Upsert the source by (tenantId, contentHash). Re-submitting the same
      // payload returns the existing row + creates a new ingestion job
      // (re-crawl semantics).
      const source: any = await (ctx.prisma as any).knowledgeSource?.upsert({
        where: { tenantId_contentHash: { tenantId: ctx.tenantId, contentHash } },
        create: {
          tenantId: ctx.tenantId,
          type: sourceType,
          status: "pending",
          contentHash,
          sourceUrl,
          uploadedFileRef,
          originalFileName,
          createdBy: ctx.firebaseUser?.uid ?? null,
        },
        update: {
          status: "pending",
          updatedAt: new Date(),
        },
      });

      const ingestion: any = await (ctx.prisma as any).knowledgeIngestion?.create({
        data: {
          knowledgeSourceId: source.id,
          status: "pending",
        },
      });

      // Publish to the worker. PR A's stub subscriber currently logs + 200s.
      const event: IngestRequestedEvent = {
        eventId: ingestion.id,
        eventType: "knowledge.ingest.requested",
        version: "1.0",
        tenantId: ctx.tenantId,
        ingestionId: ingestion.id,
        sourceId: source.id,
        path: input.path,
        payload: input,
        enqueuedAt: new Date().toISOString(),
      };
      await publishIngestRequested(event);

      return { ingestionId: ingestion.id, sourceId: source.id, status: "pending" as const };
    }),

  // Tenant-scoped polling. The endpoint MUST verify the polled ingestionId
  // belongs to the requesting tenant (cross-tenant poll → NOT_FOUND, never
  // the other tenant's status). Achieved by joining through KnowledgeSource
  // with tenantId filter.
  status: protectedProcedure
    .input(z.object({ ingestionId: z.string().uuid() }))
    .query(async ({ ctx, input }): Promise<IngestStatus> => {
      const row: any = await (ctx.prisma as any).knowledgeIngestion?.findFirst({
        where: {
          id: input.ingestionId,
          source: { tenantId: ctx.tenantId },
        },
        include: { source: { select: { id: true, errorMessage: true } } },
      });
      if (!row) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Ingestion job not found in this tenant",
        });
      }
      return {
        ingestionId: row.id,
        sourceId: row.knowledgeSourceId,
        status: row.status,
        startedAt: row.startedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
        errorMessage: row.source?.errorMessage ?? null,
        urlsDiscovered: row.urlsDiscovered ?? 0,
        urlsIndexed: row.urlsIndexed ?? 0,
      };
    }),

  // KAN-708 — list sources for the tenant, with each source's latest
  // ingestion status and chunk count. Sorted by creation date desc by default.
  // Filter by source type (optional) and status (optional) for the UI list view.
  listSources: protectedProcedure
    .input(
      z
        .object({
          type: z.enum(["url", "document", "qa_pair", "structured_field"]).optional(),
          status: z.enum(["pending", "processing", "indexed", "failed", "stale"]).optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const where: any = { tenantId: ctx.tenantId };
      if (input?.type) where.type = input.type;
      if (input?.status) where.status = input.status;
      const sources: any[] =
        (await (ctx.prisma as any).knowledgeSource?.findMany({
          where,
          orderBy: { createdAt: "desc" },
          include: { _count: { select: { chunks: true } } },
        })) ?? [];
      return sources.map((s) => ({
        id: s.id,
        type: s.type,
        status: s.status,
        sourceUrl: s.sourceUrl,
        originalFileName: s.originalFileName,
        contentHash: s.contentHash,
        lastIndexedAt: s.lastIndexedAt?.toISOString() ?? null,
        errorMessage: s.errorMessage,
        chunkCount: s._count.chunks,
        createdAt: s.createdAt.toISOString(),
        updatedAt: s.updatedAt.toISOString(),
      }));
    }),

  // KAN-708 — source detail with chunks (paginated). Tenant-scoped.
  getSourceById: protectedProcedure
    .input(
      z.object({
        sourceId: z.string().uuid(),
        chunkLimit: z.number().int().min(1).max(100).default(20),
        chunkOffset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const source: any = await (ctx.prisma as any).knowledgeSource?.findFirst({
        where: { id: input.sourceId, tenantId: ctx.tenantId },
        include: {
          ingestions: { orderBy: { createdAt: "desc" }, take: 5 },
          _count: { select: { chunks: true } },
        },
      });
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Source not found in this tenant" });
      }
      // Chunks separately so we can paginate without loading the full set.
      const chunks: any[] =
        (await (ctx.prisma as any).knowledgeChunk?.findMany({
          where: { sourceId: input.sourceId },
          orderBy: { chunkIndex: "asc" },
          skip: input.chunkOffset,
          take: input.chunkLimit,
          select: {
            id: true,
            chunkIndex: true,
            totalChunks: true,
            content: true,
            tokenCount: true,
            embeddingModel: true,
            createdAt: true,
          },
        })) ?? [];
      return {
        id: source.id,
        type: source.type,
        status: source.status,
        sourceUrl: source.sourceUrl,
        uploadedFileRef: source.uploadedFileRef,
        originalFileName: source.originalFileName,
        lastIndexedAt: source.lastIndexedAt?.toISOString() ?? null,
        errorMessage: source.errorMessage,
        createdAt: source.createdAt.toISOString(),
        updatedAt: source.updatedAt.toISOString(),
        totalChunks: source._count.chunks,
        chunks: chunks.map((c) => ({
          id: c.id,
          chunkIndex: c.chunkIndex,
          totalChunks: c.totalChunks,
          content: c.content,
          tokenCount: c.tokenCount,
          embeddingModel: c.embeddingModel,
          createdAt: c.createdAt.toISOString(),
        })),
        recentIngestions: source.ingestions.map((i: any) => ({
          ingestionId: i.id,
          status: i.status,
          startedAt: i.startedAt?.toISOString() ?? null,
          completedAt: i.completedAt?.toISOString() ?? null,
          createdAt: i.createdAt.toISOString(),
        })),
      };
    }),

  // KAN-708 — delete a source + cascade chunks + ingestions. Tenant-scoped.
  deleteSource: protectedProcedure
    .input(z.object({ sourceId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const source: any = await (ctx.prisma as any).knowledgeSource?.findFirst({
        where: { id: input.sourceId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Source not found in this tenant" });
      }
      // ON DELETE CASCADE on the FKs (KAN-706 schema) handles chunks +
      // ingestions automatically.
      await (ctx.prisma as any).knowledgeSource?.delete({ where: { id: input.sourceId } });
      return { sourceId: input.sourceId };
    }),
});

// ============================================================================
// KAN-742 — Sprint 3 / S3.8 Lead API tRPC surface.
//
// Tenant API key management. Plaintext-once contract:
//   - create returns plaintext ONCE (caller MUST display the modal
//     acknowledgment gate before allowing dismissal)
//   - list/revoke NEVER return plaintext, only metadata (name, prefix,
//     lastUsedAt, revokedAt)
//   - revoke is IMMEDIATE — auth middleware filters revokedAt: null on
//     every request; no grace period, no caching
// ============================================================================

const tenantApiKeysRouter = router({
  list: adminProcedure.query(async ({ ctx }) => {
    const rows: any[] =
      (await (ctx.prisma as any).tenantApiKey?.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: "desc" },
      })) ?? [];
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      createdAt: r.createdAt.toISOString(),
      lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
      revokedAt: r.revokedAt?.toISOString() ?? null,
      revokedBy: r.revokedBy,
    }));
  }),

  // PLAINTEXT-ONCE — server returns the plaintext key in this response and
  // NEVER again. The frontend modal MUST gate dismissal on user
  // acknowledgment ("I've saved this key" + copy-to-clipboard) before
  // closing. Document the one-time-view contract in the modal copy.
  create: adminProcedure
    .input(z.object({ name: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const { generateApiKey } = await import("./services/api-key-auth.js");
      const { plaintext, keyPrefix, keyHash } = await generateApiKey();
      const created: any = await (ctx.prisma as any).tenantApiKey?.create({
        data: {
          tenantId: ctx.tenantId,
          name: input.name,
          keyPrefix,
          keyHash,
        },
      });
      // Plaintext returned ONCE in the create response. Server NEVER stores
      // or logs the plaintext after this point.
      return {
        id: created.id,
        name: created.name,
        keyPrefix: created.keyPrefix,
        plaintext,
        createdAt: created.createdAt.toISOString(),
      };
    }),

  revoke: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing: any = await (ctx.prisma as any).tenantApiKey?.findFirst({
        where: { id: input.id, tenantId: ctx.tenantId },
        select: { id: true, revokedAt: true },
      });
      if (!existing) {
        throw new TRPCError({ code: "NOT_FOUND", message: "API key not found in this tenant" });
      }
      if (existing.revokedAt) {
        // Idempotent — return current state
        return { id: input.id, revokedAt: existing.revokedAt.toISOString() };
      }
      const revokedBy = ctx.firebaseUser?.uid ?? "unknown";
      const updated: any = await (ctx.prisma as any).tenantApiKey?.update({
        where: { id: input.id },
        data: { revokedAt: new Date(), revokedBy },
      });
      return { id: updated.id, revokedAt: updated.revokedAt.toISOString() };
    }),
});

// ============================================================================
// KAN-741 — Sprint 3 / S3.11 Lead Inbox tRPC surface.
//
// Per-tenant inbox slug management + DKIM strict-mode override + recent
// inbox events query. Slug = first 8 chars of tenant UUID by default
// (regenerable via admin mutation). Inbox address forms as
// <slug>@<LEAD_INBOX_DOMAIN>.
//
// Cast-loose `(prisma as any)` accessors on the new Tenant.inboxSlug /
// inboxDkimStrict fields and the leadInboxEvent delegate keep the new
// types out of the apps/api TS6059 graph (KAN-689 cohort discipline).
// ============================================================================

/**
 * KAN-818 fix: read LEAD_INBOX_DOMAIN at use-site, throw if unset. Replaces
 * the previous `?? "leads.axisone.app"` fallback that silently displayed
 * wrong-TLD inbox addresses to admins (Sprint 9 close discovery). Per
 * feedback_env_var_default_fall_through_silent_typo, production-required
 * values fail-loud at boot/use rather than fall through to dev placeholders.
 */
function requireLeadInboxDomain(): string {
  const domain = process.env.LEAD_INBOX_DOMAIN;
  if (!domain) {
    throw new Error(
      'LEAD_INBOX_DOMAIN env var is required for inbox-address construction. ' +
        'Set it on the growth-api Cloud Run service (typically leads.axisone.ca for production).',
    );
  }
  return domain;
}

const inboxRouter = router({
  // Read the active tenant's inbox slug + computed full address. Returns null
  // slug when the tenant hasn't regenerated yet (legacy rows pre-KAN-741).
  getMyInboxAddress: protectedProcedure.query(async ({ ctx }) => {
    const tenant: any = await (ctx.prisma as any).tenant?.findUnique({
      where: { id: ctx.tenantId },
      select: { id: true, inboxSlug: true, inboxDkimStrict: true },
    });
    if (!tenant) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
    }
    // KAN-818 fix: LEAD_INBOX_DOMAIN required at runtime — the previous
    // `?? "leads.axisone.app"` fallback silently displayed wrong-TLD inbox
    // addresses to admins whenever the env var was missing on growth-api.
    // Throw at use-site so the missing-env-var case is visible (per
    // feedback_env_var_default_fall_through_silent_typo).
    const domain = requireLeadInboxDomain();
    const address = tenant.inboxSlug ? `${tenant.inboxSlug}@${domain}` : null;
    return {
      slug: tenant.inboxSlug as string | null,
      address,
      dkimStrict: tenant.inboxDkimStrict as boolean,
      domain,
    };
  }),

  // Generate a new inbox slug. Admin-only. Sets the new slug; the old slug
  // is overwritten (single-slug-per-tenant invariant). On collision (very
  // unlikely with UUIDv4 entropy) the mutation retries up to 3 times with
  // a fresh UUID.
  regenerateSlug: adminProcedure.mutation(async ({ ctx }) => {
    const generateSlug = (): string => {
      // 8-char hex prefix from a fresh UUIDv4. Collision space is 16^8 = 4B.
      // With ~10K tenants the birthday-collision probability is < 0.01%.
      const id = (typeof crypto !== "undefined" && "randomUUID" in crypto)
        ? (crypto as { randomUUID: () => string }).randomUUID()
        : Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
      return id.replace(/-/g, "").slice(0, 8);
    };
    let slug: string | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      const candidate = generateSlug();
      const existing: any = await (ctx.prisma as any).tenant?.findUnique({
        where: { inboxSlug: candidate },
        select: { id: true },
      });
      if (!existing) {
        slug = candidate;
        break;
      }
    }
    if (!slug) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Slug collision after 3 attempts" });
    }
    await (ctx.prisma as any).tenant?.update({
      where: { id: ctx.tenantId },
      data: { inboxSlug: slug },
    });
    // KAN-818 fix: see requireLeadInboxDomain() — fails loud on missing env.
    const domain = requireLeadInboxDomain();
    return { slug, address: `${slug}@${domain}`, domain };
  }),

  // Per-tenant DKIM strict-mode toggle. Admin-only. Default true (strict).
  setDkimStrict: adminProcedure
    .input(z.object({ strict: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await (ctx.prisma as any).tenant?.update({
        where: { id: ctx.tenantId },
        data: { inboxDkimStrict: input.strict },
      });
      return { strict: input.strict };
    }),

  // List recent inbox events (audit + rejection visibility). Paginated;
  // status filter optional. KAN-741 ships this endpoint; the frontend
  // events table is deferrable to Sprint 4 if LoC tightens (per defer
  // order in PR description).
  listRecentEvents: protectedProcedure
    .input(z.object({
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      statusFilter: z.string().optional(),
    }))
    .query(async ({ ctx, input }) => {
      const where: any = { tenantId: ctx.tenantId };
      if (input.statusFilter) where.status = input.statusFilter;
      const rows: any[] =
        (await (ctx.prisma as any).leadInboxEvent?.findMany({
          where,
          orderBy: { createdAt: "desc" },
          take: input.limit,
          skip: input.offset,
        })) ?? [];
      return rows.map((r) => ({
        id: r.id,
        inboxAddress: r.inboxAddress,
        fromAddress: r.fromAddress,
        subject: r.subject,
        status: r.status,
        rejectionReason: r.rejectionReason,
        spfPass: r.spfPass,
        dkimPass: r.dkimPass,
        attachmentCount: r.attachmentCount,
        createdContactId: r.createdContactId,
        createdAt: r.createdAt.toISOString(),
      }));
    }),
});

// KAN-745 PR B — observability router (admin-only). Service files live in
// packages/api/src/services/observability/ and are loaded via variable-
// specifier dynamic imports per the established TS6059 hygiene pattern.
interface ObservabilityModule {
  listRollups: (
    prisma: unknown,
    tenantId: string,
    input: { fromHour: Date; toHour: Date },
  ) => Promise<unknown>;
  currentHourSummary: (prisma: unknown, tenantId: string, now?: Date) => Promise<unknown>;
}
let _observabilityModule: ObservabilityModule | null = null;
async function loadObservabilityModule(): Promise<ObservabilityModule> {
  if (_observabilityModule) return _observabilityModule;
  const spec = "../../../packages/api/src/services/observability/llm-cost-rollup.js";
  _observabilityModule = (await import(spec)) as ObservabilityModule;
  return _observabilityModule;
}

const observabilityRouter = router({
  list: adminProcedure
    .input(
      z.object({
        // ISO timestamps; router truncates to hour bucket. `toHour` is
        // exclusive at hour boundary.
        fromHour: z.string().datetime(),
        toHour: z.string().datetime(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listRollups } = await loadObservabilityModule();
      return listRollups(ctx.prisma, ctx.tenantId, {
        fromHour: new Date(input.fromHour),
        toHour: new Date(input.toHour),
      });
    }),

  currentHour: adminProcedure.query(async ({ ctx }) => {
    const { currentHourSummary } = await loadObservabilityModule();
    return currentHourSummary(ctx.prisma, ctx.tenantId);
  }),
});

export const appRouter = router({
  contacts: contactsRouter,
  pipelines: pipelinesRouter,
  stages: stagesRouter,
  targets: targetsRouter,
  knowledgeFilters: knowledgeFiltersRouter,
  knowledgeIngest: knowledgeIngestRouter,
  pipelineMicroObjectives: pipelineMicroObjectivesRouter,
  decisions: decisionsRouter,
  actions: actionsRouter,
  recommendations: recommendationsRouter,
  auditLog: auditLogRouter,
  brain: brainRouter,
  objectives: objectivesRouter,
  dashboard: dashboardRouter,
  knowledge: knowledgeRouter,
  competitors: competitorsRouter,
  salesObjections: salesObjectionsRouter,
  settings: settingsRouter,
  wedge: wedgeRouter,
  outcomes: outcomesRouter,
  inbox: inboxRouter,
  tenantApiKeys: tenantApiKeysRouter,
  observability: observabilityRouter,
});

export type AppRouter = typeof appRouter;
