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
// CONVERSATIONS ROUTER (NEW)
// ============================================================================
const conversationsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        contactId: z.string().cuid().optional(),
        channel: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().positive().default(50),
        offset: z.number().int().nonnegative().default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      const where = {
        tenantId: ctx.tenantId,
        ...(input.contactId && { contactId: input.contactId }),
        ...(input.channel && { channel: input.channel }),
        ...(input.status && { status: input.status }),
      };

      const [conversations, total] = await Promise.all([
        ctx.prisma.conversation.findMany({
          where,
          take: input.limit,
          skip: input.offset,
          orderBy: { createdAt: "desc" },
          include: { messages: { take: 5, orderBy: { createdAt: "desc" } } },
        }),
        ctx.prisma.conversation.count({ where }),
      ]);

      return { conversations, total };
    }),

  getById: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.conversation.findUnique({
        where: { id: input.id },
        include: {
          messages: {
            orderBy: { createdAt: "asc" },
          },
        },
      });

      if (!conversation || conversation.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return conversation;
    }),

  create: protectedProcedure
    .input(
      z.object({
        contactId: z.string().cuid(),
        channel: z.string(),
        status: z.string().default("open"),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const contact = await ctx.prisma.contact.findUnique({
        where: { id: input.contactId },
      });

      if (!contact || contact.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return ctx.prisma.conversation.create({
        data: {
          tenantId: ctx.tenantId,
          contactId: input.contactId,
          channel: input.channel,
          status: input.status,
          aiHandled: false,
        },
      });
    }),

  addMessage: protectedProcedure
    .input(
      z.object({
        conversationId: z.string().cuid(),
        senderId: z.string(),
        senderType: z.enum(["human", "ai", "system"]),
        content: z.string(),
        metadata: z.record(z.any()).optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.conversation.findUnique({
        where: { id: input.conversationId },
      });

      if (!conversation || conversation.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      return ctx.prisma.message.create({
        data: {
          conversationId: input.conversationId,
          senderId: input.senderId,
          senderType: input.senderType,
          content: input.content,
          channel: conversation.channel,
          metadata: input.metadata || {},
        },
      });
    }),

  updateStatus: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        status: z.string(),
        aiHandled: z.boolean().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const conversation = await ctx.prisma.conversation.findUnique({
        where: { id: input.id },
      });

      if (!conversation || conversation.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND" });
      }

      const updateData: any = { status: input.status };
      if (input.aiHandled !== undefined) {
        updateData.aiHandled = input.aiHandled;
      }

      return ctx.prisma.conversation.update({
        where: { id: input.id },
        data: updateData,
      });
    }),
});


// ============================================================================
// SETTINGS ROUTER (NEW)
// ============================================================================
const settingsRouter = router({
  listByCategory: protectedProcedure
    .input(z.object({ category: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.tenantSettings.findMany({
        where: {
          tenantId: ctx.tenantId,
          category: input.category,
        },
        orderBy: { key: "asc" },
      });
    }),

  get: protectedProcedure
    .input(z.object({ category: z.string(), key: z.string() }))
    .query(async ({ ctx, input }) => {
      return ctx.prisma.tenantSettings.findUnique({
        where: {
          tenantId_category_key: {
            tenantId: ctx.tenantId,
            category: input.category,
            key: input.key,
          },
        },
      });
    }),

  upsert: protectedProcedure
    .input(
      z.object({
        category: z.string(),
        key: z.string(),
        value: z.any(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.tenantSettings.upsert({
        where: {
          tenantId_category_key: {
            tenantId: ctx.tenantId,
            category: input.category,
            key: input.key,
          },
        },
        create: {
          tenantId: ctx.tenantId,
          category: input.category,
          key: input.key,
          value: input.value,
        },
        update: {
          value: input.value,
        },
      });
    }),

  delete: protectedProcedure
    .input(z.object({ category: z.string(), key: z.string() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.tenantSettings.delete({
        where: {
          tenantId_category_key: {
            tenantId: ctx.tenantId,
            category: input.category,
            key: input.key,
          },
        },
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
  getCompanyInfo: protectedProcedure.query(async ({ ctx }) => {
    let info = await ctx.prisma.companyInfo.findUnique({ where: { tenantId: ctx.tenantId } });
    if (!info) { info = await ctx.prisma.companyInfo.create({ data: { tenantId: ctx.tenantId } }); }
    return info;
  }),

  updateCompanyInfo: protectedProcedure
    .input(z.object({ vision: z.string().optional(), mission: z.string().optional(), websiteUrl: z.string().url().optional().nullable() }))
    .mutation(async ({ ctx, input }) => {
      return ctx.prisma.companyInfo.upsert({ where: { tenantId: ctx.tenantId }, update: input, create: { tenantId: ctx.tenantId, ...input } });
    }),

  listProducts: protectedProcedure
    .input(z.object({ page: z.number().min(1).default(1), limit: z.number().min(1).max(100).default(20), category: z.string().optional(), search: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;
      const where = { tenantId: ctx.tenantId, active: true, ...(input.category && { category: input.category }), ...(input.search && { OR: [{ name: { contains: input.search, mode: "insensitive" as const } }, { sku: { contains: input.search, mode: "insensitive" as const } }] }) };
      const [products, total] = await Promise.all([ctx.prisma.product.findMany({ where, skip, take: input.limit, orderBy: { createdAt: "desc" } }), ctx.prisma.product.count({ where })]);
      return { products, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
    }),

  createProduct: protectedProcedure
    .input(z.object({ name: z.string().min(1), category: z.string().optional(), price: z.string().optional(), description: z.string().optional(), sku: z.string().optional() }))
    .mutation(async ({ ctx, input }) => { return ctx.prisma.product.create({ data: { ...input, tenantId: ctx.tenantId } }); }),

  updateProduct: protectedProcedure
    .input(z.object({ id: z.string().uuid(), name: z.string().optional(), category: z.string().optional(), price: z.string().optional(), description: z.string().optional(), sku: z.string().optional(), active: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const existing = await ctx.prisma.product.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw new Error("Product not found");
      return ctx.prisma.product.update({ where: { id }, data });
    }),

  deleteProduct: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.product.findFirst({ where: { id: input.id, tenantId: ctx.tenantId } });
      if (!existing) throw new Error("Product not found");
      return ctx.prisma.product.update({ where: { id: input.id }, data: { active: false } });
    }),

  listPolicies: protectedProcedure
    .input(z.object({ category: z.enum(["warranty", "financing", "rule"]).optional(), page: z.number().min(1).default(1), limit: z.number().min(1).max(100).default(50) }))
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;
      const where = { tenantId: ctx.tenantId, active: true, ...(input.category && { category: input.category }) };
      const [policies, total] = await Promise.all([ctx.prisma.policyRule.findMany({ where, skip, take: input.limit, orderBy: { sortOrder: "asc" } }), ctx.prisma.policyRule.count({ where })]);
      return { policies, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
    }),

  createPolicy: protectedProcedure
    .input(z.object({ category: z.enum(["warranty", "financing", "rule"]), title: z.string().min(1), content: z.string().min(1), sortOrder: z.number().default(0) }))
    .mutation(async ({ ctx, input }) => { return ctx.prisma.policyRule.create({ data: { ...input, tenantId: ctx.tenantId } }); }),

  updatePolicy: protectedProcedure
    .input(z.object({ id: z.string().uuid(), category: z.enum(["warranty", "financing", "rule"]).optional(), title: z.string().optional(), content: z.string().optional(), sortOrder: z.number().optional(), active: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const existing = await ctx.prisma.policyRule.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw new Error("Policy not found");
      return ctx.prisma.policyRule.update({ where: { id }, data });
    }),

  deletePolicy: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.policyRule.findFirst({ where: { id: input.id, tenantId: ctx.tenantId } });
      if (!existing) throw new Error("Policy not found");
      return ctx.prisma.policyRule.update({ where: { id: input.id }, data: { active: false } });
    }),

  listFAQs: protectedProcedure
    .input(z.object({ page: z.number().min(1).default(1), limit: z.number().min(1).max(100).default(50), search: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;
      const where = { tenantId: ctx.tenantId, active: true, ...(input.search && { OR: [{ question: { contains: input.search, mode: "insensitive" as const } }, { answer: { contains: input.search, mode: "insensitive" as const } }] }) };
      const [faqs, total] = await Promise.all([ctx.prisma.fAQ.findMany({ where, skip, take: input.limit, orderBy: { sortOrder: "asc" } }), ctx.prisma.fAQ.count({ where })]);
      return { faqs, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
    }),

  createFAQ: protectedProcedure
    .input(z.object({ question: z.string().min(1), answer: z.string().min(1), sortOrder: z.number().default(0) }))
    .mutation(async ({ ctx, input }) => { return ctx.prisma.fAQ.create({ data: { ...input, tenantId: ctx.tenantId } }); }),

  updateFAQ: protectedProcedure
    .input(z.object({ id: z.string().uuid(), question: z.string().optional(), answer: z.string().optional(), sortOrder: z.number().optional(), active: z.boolean().optional() }))
    .mutation(async ({ ctx, input }) => {
      const { id, ...data } = input;
      const existing = await ctx.prisma.fAQ.findFirst({ where: { id, tenantId: ctx.tenantId } });
      if (!existing) throw new Error("FAQ not found");
      return ctx.prisma.fAQ.update({ where: { id }, data });
    }),

  deleteFAQ: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.fAQ.findFirst({ where: { id: input.id, tenantId: ctx.tenantId } });
      if (!existing) throw new Error("FAQ not found");
      return ctx.prisma.fAQ.update({ where: { id: input.id }, data: { active: false } });
    }),

  listDocuments: protectedProcedure
    .input(z.object({ page: z.number().min(1).default(1), limit: z.number().min(1).max(100).default(20), type: z.string().optional() }))
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;
      const where = { tenantId: ctx.tenantId, ...(input.type && { type: input.type }) };
      const [documents, total] = await Promise.all([ctx.prisma.knowledgeDocument.findMany({ where, skip, take: input.limit, orderBy: { uploadedAt: "desc" } }), ctx.prisma.knowledgeDocument.count({ where })]);
      return { documents, pagination: { page: input.page, limit: input.limit, total, pages: Math.ceil(total / input.limit) } };
    }),

  createDocument: protectedProcedure
    .input(z.object({ name: z.string().min(1), type: z.string().min(1), sizeBytes: z.number().default(0), gcsPath: z.string().optional() }))
    .mutation(async ({ ctx, input }) => { return ctx.prisma.knowledgeDocument.create({ data: { ...input, tenantId: ctx.tenantId } }); }),

  deleteDocument: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const existing = await ctx.prisma.knowledgeDocument.findFirst({ where: { id: input.id, tenantId: ctx.tenantId } });
      if (!existing) throw new Error("Document not found");
      return ctx.prisma.knowledgeDocument.delete({ where: { id: input.id } });
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
  conversations: conversationsRouter,
  settings: settingsRouter,
  dashboard: dashboardRouter,
  knowledge: knowledgeRouter,
  competitors: competitorsRouter,
});

export type AppRouter = typeof appRouter;
