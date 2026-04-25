import { z } from "zod";
import { TRPCError } from "@trpc/server";
import type { Prisma, ChannelConnection } from "@prisma/client";
import { router, publicProcedure, protectedProcedure } from "./trpc.js";
import { generateObjectionResponses, regenerateSingleField } from "./llm.js";
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

const contactsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
        search: z.string().optional(),
        status: z.string().optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenant_id: ctx.tenantId,
        ...(input.search && {
          OR: [
            { name: { contains: input.search, mode: "insensitive" as const } },
            { email: { contains: input.search, mode: "insensitive" as const } },
          ],
        }),
        ...(input.status && { status: input.status }),
      };

      const [contacts, total] = await Promise.all([
        ctx.prisma.contact.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { created_at: "desc" },
        }),
        ctx.prisma.contact.count({ where }),
      ]);

      return {
        contacts,
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
      const contact = await ctx.prisma.contact.findFirst({
        where: {
          id: input.id,
          tenant_id: ctx.tenantId,
        },
      });

      if (!contact) {
        throw new Error("Contact not found");
      }

      return contact;
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        email: z.string().email(),
        phone: z.string().optional(),
        company: z.string().optional(),
        status: z.string().default("new"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.contact.create({
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
        name: z.string().optional(),
        email: z.string().email().optional(),
        phone: z.string().optional(),
        company: z.string().optional(),
        status: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      const existing = await ctx.prisma.contact.findFirst({
        where: { id, tenant_id: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Contact not found");
      }

      return ctx.prisma.contact.update({
        where: { id },
        data,
      });
    }),
});

// ============================================================================
// PIPELINES ROUTER
// ============================================================================

const pipelinesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) => {
    return ctx.prisma.pipeline.findMany({
      where: { tenant_id: ctx.tenantId },
      orderBy: { name: "asc" },
    });
  }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const pipeline = await ctx.prisma.pipeline.findFirst({
        where: {
          id: input.id,
          tenant_id: ctx.tenantId,
        },
      });

      if (!pipeline) {
        throw new Error("Pipeline not found");
      }

      return pipeline;
    }),

  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.pipeline.create({
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
        name: z.string().optional(),
        description: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;

      const existing = await ctx.prisma.pipeline.findFirst({
        where: { id, tenant_id: ctx.tenantId },
      });

      if (!existing) {
        throw new Error("Pipeline not found");
      }

      return ctx.prisma.pipeline.update({
        where: { id },
        data,
      });
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

const escalationsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        priority: z.enum(["low", "medium", "high", "critical"]).optional(),
        status: z.enum(["open", "claimed", "resolved", "dismissed"]).optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenant_id: ctx.tenantId,
        ...(input.priority && { priority: input.priority }),
        ...(input.status && { status: input.status }),
      };

      const [escalations, total] = await Promise.all([
        ctx.prisma.escalation.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { created_at: "desc" },
        }),
        ctx.prisma.escalation.count({ where }),
      ]);

      return {
        escalations,
        pagination: {
          page: input.page,
          limit: input.limit,
          total,
          pages: Math.ceil(total / input.limit),
        },
      };
    }),

  claim: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const escalation = await ctx.prisma.escalation.findFirst({
        where: { id: input.id, tenant_id: ctx.tenantId },
      });

      if (!escalation) {
        throw new Error("Escalation not found");
      }

      return ctx.prisma.escalation.update({
        where: { id: input.id },
        data: { status: "claimed", claimed_at: new Date() },
      });
    }),

  resolve: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const escalation = await ctx.prisma.escalation.findFirst({
        where: { id: input.id, tenant_id: ctx.tenantId },
      });

      if (!escalation) {
        throw new Error("Escalation not found");
      }

      return ctx.prisma.escalation.update({
        where: { id: input.id },
        data: { status: "resolved", resolved_at: new Date() },
      });
    }),

  dismiss: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const escalation = await ctx.prisma.escalation.findFirst({
        where: { id: input.id, tenant_id: ctx.tenantId },
      });

      if (!escalation) {
        throw new Error("Escalation not found");
      }

      return ctx.prisma.escalation.update({
        where: { id: input.id },
        data: { status: "dismissed", dismissed_at: new Date() },
      });
    }),
});

// ============================================================================
// AUDIT LOG ROUTER
// ============================================================================

const auditLogRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        category: z.string().optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where = {
        tenant_id: ctx.tenantId,
        ...(input.category && { category: input.category }),
      };

      const [logs, total] = await Promise.all([
        ctx.prisma.auditLog.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { created_at: "desc" },
        }),
        ctx.prisma.auditLog.count({ where }),
      ]);

      return {
        logs,
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
// ChannelConnection is the production model (KAN-661 SendGrid simple-mode +
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
  // production model used by the SendGrid simple-mode adapter + action-send
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

    // testConnection — per-provider credential validation deferred to
    // channel-specific epics (KAN-472 Twilio, KAN-473 SendGrid, KAN-474 Meta).
    // Stubbed here so the Settings UI's "Test Connection" button has a wired
    // endpoint instead of 404'ing. AC's "real provider validation" lands when
    // those epics ship the SendGrid /v3/scopes / Twilio Accounts / Meta Graph
    // health-check calls.
    testConnection: protectedProcedure
      .input(z.object({ type: z.enum(["email", "sms", "whatsapp", "messenger"]) }).strict())
      .mutation(async () => {
        // TODO(KAN-472|KAN-473|KAN-474): per-provider validation
        return {
          success: false,
          message:
            "Per-provider connection test deferred to KAN-472 (Twilio) / KAN-473 (SendGrid) / KAN-474 (Meta) epics.",
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

export const appRouter = router({
  contacts: contactsRouter,
  pipelines: pipelinesRouter,
  decisions: decisionsRouter,
  actions: actionsRouter,
  escalations: escalationsRouter,
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
});

export type AppRouter = typeof appRouter;
