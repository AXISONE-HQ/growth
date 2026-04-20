import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure, protectedProcedure } from "./trpc.js";
import { generateObjectionResponses, regenerateSingleField } from "./llm.js";

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

const settingsRouter = router({
  ai: router({
    get: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        const tenant = await ctx.prisma.tenant.findUnique({
          where: { id: input.tenantId },
          select: {
            aiPermissions: true,
            confidenceThreshold: true,
          },
        });
        if (!tenant) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
        }
        return {
          aiPermissions: tenant.aiPermissions,
          confidenceThreshold: tenant.confidenceThreshold,
        };
      }),
    update: protectedProcedure
      .input(
        z.object({
          tenantId: z.string().uuid(),
          aiPermissions: z.record(z.any()).optional(),
          confidenceThreshold: z.number().min(0).max(100).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { tenantId, ...data } = input;
        const updated = await ctx.prisma.tenant.update({
          where: { id: tenantId },
          data,
          select: {
            aiPermissions: true,
            confidenceThreshold: true,
          },
        });
        return updated;
      }),
  }),

  channels: router({
    list: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid() }))
      .query(async ({ ctx, input }) => {
        return ctx.prisma.communicationChannel.findMany({
          where: { tenantId: input.tenantId },
          orderBy: { createdAt: "desc" },
        });
      }),
    update: protectedProcedure
      .input(
        z.object({
          tenantId: z.string().uuid(),
          id: z.string().uuid().optional(),
          type: z.enum(["email", "sms", "whatsapp"]),
          provider: z.string().min(1),
          config: z.record(z.any()).optional(),
          status: z.enum(["connected", "disconnected", "error"]).optional(),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { tenantId, id, type, provider, config, status } = input;
        if (id) {
          return ctx.prisma.communicationChannel.update({
            where: { id },
            data: { provider, config: config ?? undefined, status: status ?? undefined },
          });
        }
        return ctx.prisma.communicationChannel.upsert({
          where: { tenantId_type: { tenantId, type } },
          update: { provider, config: config ?? undefined, status: status ?? undefined },
          create: { tenantId, type, provider, config: config ?? {}, status: status ?? "disconnected" },
        });
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
          category: z.enum(["crm", "payments", "calendar", "commerce", "other"]),
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

  notifications: router({
    get: protectedProcedure
      .input(z.object({ tenantId: z.string().uuid(), userId: z.string() }))
      .query(async ({ ctx, input }) => {
        const prefs = await ctx.prisma.notificationPreference.findMany({
          where: { tenantId: input.tenantId, userId: input.userId },
        });
        if (prefs.length === 0) {
          return ["escalation", "daily_digest", "weekly_report", "brain_update"].map((type) => ({ type, enabled: true, channel: "email" }));
        }
        return prefs;
      }),
    update: protectedProcedure
      .input(
        z.object({
          tenantId: z.string().uuid(),
          userId: z.string(),
          type: z.enum(["escalation", "daily_digest", "weekly_report", "brain_update"]),
          enabled: z.boolean(),
          channel: z.string().default("email"),
        })
      )
      .mutation(async ({ ctx, input }) => {
        const { tenantId, userId, type, enabled, channel } = input;
        return ctx.prisma.notificationPreference.upsert({
          where: { tenantId_userId_type: { tenantId, userId, type } },
          update: { enabled, channel },
          create: { tenantId, userId, type, enabled, channel },
        });
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
});

export type AppRouter = typeof appRouter;
