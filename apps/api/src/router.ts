import { z } from "zod";
import { router, publicProcedure, protectedProcedure } from "./trpc.js";

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
// ROOT ROUTER
// ============================================================================

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
});

export type AppRouter = typeof appRouter;
