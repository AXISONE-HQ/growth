import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { createHash, randomUUID } from "node:crypto";
import type { Prisma, ChannelConnection } from "@prisma/client";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { router, publicProcedure, protectedProcedure, adminProcedure } from "./trpc.js";
import {
  ObjectiveTypeEnum,
  TargetMetricEnum,
  TargetPeriodEnum,
  KnowledgeCategoryEnum,
  LeadAssignmentPostureEnum,
  // KAN-852 — Account Page Cohort 1
  IdentityUpdateSchema,
  ContactUpdateSchema,
  HoursUpdateSchema,
  PaymentsUpdateSchema,
  LegalUpdateSchema,
  HolidayCreateSchema,
  SocialProfileCreateSchema,
  DisclosureCreateSchema,
  buildAccountFieldUpdatedEvent,
  // KAN-855 — Account Page Cohort 2 (logo upload)
  LogoUploadInputSchema,
  LogoFinalizeInputSchema,
} from "@growth/shared";
// KAN-852 — Account Page publisher + flag. Cross-rootDir static imports
// trigger TS6059 (KAN-689 cohort), so we use the variable-specifier
// dynamic-import workaround per `reference_variable_specifier_dynamic_import`
// memory + existing pattern in this file (see contactsRouter at line ~210).
// Test suites can still vi.mock the path because the dynamic spec resolves
// at runtime.
import type { AccountFieldUpdatedEvent } from "@growth/shared";
interface AccountPublisherModule {
  publishAccountFieldUpdated: (event: AccountFieldUpdatedEvent) => Promise<{
    messageId?: string;
    skipped: boolean;
  }>;
  accountEventsEnabled: () => boolean;
}
let _accountPublisherModule: AccountPublisherModule | null = null;
async function loadAccountPublisher(): Promise<AccountPublisherModule> {
  if (_accountPublisherModule) return _accountPublisherModule;
  const spec = "../../../packages/api/src/services/account-field-updated-publisher.js";
  _accountPublisherModule = (await import(spec)) as AccountPublisherModule;
  return _accountPublisherModule;
}

// KAN-855 — Account Page Cohort 2 logo storage helpers. Same dynamic-import
// dance as the publisher above (cross-rootDir; KAN-689 cohort hygiene).
interface AccountLogoStorageModule {
  ALLOWED_LOGO_MIME_TO_EXT: Record<string, "png" | "jpg" | "svg" | "webp">;
  getSignedUploadUrl: (
    tenantId: string,
    mime: "image/png" | "image/jpeg" | "image/svg+xml" | "image/webp",
  ) => Promise<{ uploadUrl: string; objectName: string; uploadId: string; contentType: string }>;
  getSignedReadUrl: (objectName: string) => Promise<string>;
  downloadObject: (objectName: string) => Promise<Buffer>;
  deleteObject: (objectName: string) => Promise<void>;
  objectExists: (objectName: string) => Promise<boolean>;
  generateAndUploadVariants: (
    tenantId: string,
    originalBuffer: Buffer,
    ext: "png" | "jpg" | "webp",
    timestamp: number,
  ) => Promise<{ size256: string; size128: string; size64: string }>;
  enrichLogoUrls: (
    storedLogoUrl: string | null,
    storedLogoVariants: { "256"?: string; "128"?: string; "64"?: string } | null,
  ) => Promise<{
    logoUrl: string | null;
    logoVariants: { 256: string; 128: string; 64: string } | null;
  }>;
  isOwnedByTenant: (objectName: string, tenantId: string) => boolean;
  parseExtFromObjectName: (objectName: string) => "png" | "jpg" | "svg" | "webp" | null;
  parseTimestampFromObjectName: (objectName: string) => number | null;
}
let _accountLogoStorageModule: AccountLogoStorageModule | null = null;
async function loadAccountLogoStorage(): Promise<AccountLogoStorageModule> {
  if (_accountLogoStorageModule) return _accountLogoStorageModule;
  const spec = "../../../packages/api/src/services/account-logo-storage.js";
  _accountLogoStorageModule = (await import(spec)) as AccountLogoStorageModule;
  return _accountLogoStorageModule;
}

// KAN-859 — Account Page Cohort 4 Blueprint defaults resolver. Same
// dynamic-import dance as the logo storage + publisher (cross-rootDir
// guard for KAN-689 cohort hygiene). Used by `account.get` to enrich
// the response with resolved Blueprint defaults so the Legal tab
// renders "Blueprint default" vs "Custom" without leaking Blueprint
// internals to the client.
interface BlueprintLoaderModule {
  getBlueprintForTenant: (tenantId: string) => Promise<{ legalDefaults: unknown } | null>;
  GENERIC_BLUEPRINT: { legalDefaults: unknown };
  resolveLegalDefaults: (input: {
    accountProfile: {
      optOutLanguage: string | null;
      emailFooterDisclosure: string | null;
      defaultLanguage: string;
    };
    blueprint: { legalDefaults: unknown };
  }) => {
    optOutLanguage: string;
    emailFooterDisclosure: string;
    source: {
      optOutLanguage: "override" | "language" | "fallback_en";
      emailFooterDisclosure: "override" | "language" | "fallback_en";
    };
  };
}
let _blueprintLoaderModule: BlueprintLoaderModule | null = null;
async function loadBlueprintLoader(): Promise<BlueprintLoaderModule> {
  if (_blueprintLoaderModule) return _blueprintLoaderModule;
  const spec = "../../../packages/api/src/services/blueprint-loader.js";
  _blueprintLoaderModule = (await import(spec)) as BlueprintLoaderModule;
  return _blueprintLoaderModule;
}

// KAN-826: legacy KAN-707 ingest imports REMOVED — KnowledgeSourceTypeEnum,
// KnowledgeSourceStatusEnum, PER_TENANT_INGEST_QUEUE_DEPTH_LIMIT,
// IngestRequestedEvent, IngestStatus, IngestRequestSchema, and the
// publishIngestRequested service. All consumers in this file deleted along
// with the legacy admin endpoints. Sprint 11a KAN-827 will reintroduce a
// new ingestion contract for the new knowledge_source/_chunk schema.

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
    input: {
      search?: string;
      lifecycleStage?: string;
      // KAN-883 — read-layer filter extensions. Source + companyId added so
      // the Customers UI can scope to a Company badge or filter by source.
      source?: string;
      companyId?: string;
      limit?: number;
      offset?: number;
    },
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
        // KAN-883 — read-layer filter extensions. Loose `z.string()` (not
        // `z.nativeEnum`) keeps the API tolerant to legacy values the UI
        // may still send during the transition; service-level Prisma will
        // reject anything truly invalid.
        source: z.string().optional(),
        companyId: z.string().cuid().optional(),
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
// COMPANIES ROUTER — KAN-883 (CRM read-layer cohort 1, PR 1 of 3)
// ============================================================================
//
// Thin tRPC layer over packages/api/src/services/companies-router.ts. Same
// variable-specifier dynamic-import pattern as contacts (TS6059 cohort).
// All read-only; mutations land in cohort 4.
interface CompaniesRouterModule {
  listCompanies: (
    prisma: unknown,
    tenantId: string,
    input: {
      search?: string;
      lifecycleStage?: string;
      ownerId?: string;
      limit: number;
      cursor?: string;
    },
  ) => Promise<unknown>;
  getCompanyById: (
    prisma: unknown,
    tenantId: string,
    input: { id: string },
  ) => Promise<unknown>;
}
let _companiesModule: CompaniesRouterModule | null = null;
async function loadCompaniesModule(): Promise<CompaniesRouterModule> {
  if (_companiesModule) return _companiesModule;
  const spec = "../../../packages/api/src/services/companies-router.js";
  _companiesModule = (await import(spec)) as CompaniesRouterModule;
  return _companiesModule;
}

const companiesRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        // Loose string here for the same reason as contacts.list — keeps
        // the API tolerant to legacy values; Prisma rejects invalid enum
        // values at query time.
        lifecycleStage: z.string().optional(),
        ownerId: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listCompanies } = await loadCompaniesModule();
      return listCompanies(ctx.prisma, ctx.tenantId, input);
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { getCompanyById } = await loadCompaniesModule();
      return getCompanyById(ctx.prisma, ctx.tenantId, input);
    }),
});

// ============================================================================
// ORDERS ROUTER — KAN-883
// ============================================================================
interface OrdersRouterModule {
  listOrders: (
    prisma: unknown,
    tenantId: string,
    input: {
      search?: string;
      status?: string;
      contactId?: string;
      companyId?: string;
      dealId?: string;
      limit: number;
      cursor?: string;
    },
  ) => Promise<unknown>;
  getOrderById: (
    prisma: unknown,
    tenantId: string,
    input: { id: string },
  ) => Promise<unknown>;
}
let _ordersModule: OrdersRouterModule | null = null;
async function loadOrdersModule(): Promise<OrdersRouterModule> {
  if (_ordersModule) return _ordersModule;
  const spec = "../../../packages/api/src/services/orders-router.js";
  _ordersModule = (await import(spec)) as OrdersRouterModule;
  return _ordersModule;
}

const ordersRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        status: z.string().optional(),
        contactId: z.string().uuid().optional(),
        companyId: z.string().cuid().optional(),
        dealId: z.string().cuid().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listOrders } = await loadOrdersModule();
      return listOrders(ctx.prisma, ctx.tenantId, input);
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { getOrderById } = await loadOrdersModule();
      return getOrderById(ctx.prisma, ctx.tenantId, input);
    }),
});

// ============================================================================
// DEALS ROUTER — KAN-883 (net-new — no prior Deal tRPC surface existed)
// ============================================================================
interface DealsRouterModule {
  listDeals: (
    prisma: unknown,
    tenantId: string,
    input: {
      search?: string;
      status?: string;
      companyId?: string;
      contactId?: string;
      ownerId?: string;
      limit: number;
      cursor?: string;
    },
  ) => Promise<unknown>;
  getDealById: (
    prisma: unknown,
    tenantId: string,
    input: { id: string },
  ) => Promise<unknown>;
}
let _dealsModule: DealsRouterModule | null = null;
async function loadDealsModule(): Promise<DealsRouterModule> {
  if (_dealsModule) return _dealsModule;
  const spec = "../../../packages/api/src/services/deals-router.js";
  _dealsModule = (await import(spec)) as DealsRouterModule;
  return _dealsModule;
}

const dealsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        status: z.string().optional(),
        companyId: z.string().cuid().optional(),
        contactId: z.string().uuid().optional(),
        ownerId: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listDeals } = await loadDealsModule();
      return listDeals(ctx.prisma, ctx.tenantId, input);
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { getDealById } = await loadDealsModule();
      return getDealById(ctx.prisma, ctx.tenantId, input);
    }),
});

// ============================================================================
// IMPORT JOBS ROUTER — KAN-896 Cohort 2.1a (upload backend)
// ============================================================================
//
// 4 procedures: createUploadUrl, confirmUpload, list, get.
// Service-layer in packages/api/src/services/import-jobs-router.ts.
// Variable-specifier dynamic-import pattern (KAN-689 cohort) to keep the
// services module out of apps/api's rootDir TS6059 graph.
//
// createdByUserId resolution: ctx.firebaseUser.email → User row in tenant.
// Pre-launch single-tenant posture; KAN-714 (GoRush onboarding) will
// replace this with proper TeamMember-based identity.

interface ImportJobsRouterModule {
  createUploadUrl: (
    prisma: unknown,
    tenantId: string,
    createdByUserId: string,
    input: {
      filename: string;
      fileSize: number;
      fileMimeType:
        | "text/csv"
        | "application/vnd.ms-excel"
        | "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      mode: "replace_all" | "update_add";
    },
  ) => Promise<unknown>;
  confirmUpload: (
    prisma: unknown,
    tenantId: string,
    input: { importJobId: string },
  ) => Promise<unknown>;
  listImportJobs: (
    prisma: unknown,
    tenantId: string,
    input: {
      status?:
        | "awaiting_upload"
        | "uploaded"
        | "inspecting"
        | "inspected"
        | "failed";
      limit: number;
      cursor?: string;
    },
  ) => Promise<unknown>;
  getImportJobById: (
    prisma: unknown,
    tenantId: string,
    input: { id: string },
  ) => Promise<unknown>;
  // KAN-904 — Cohort 2.2 AI entity detection.
  runEntityDetection: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
  ) => Promise<unknown>;
  // KAN-905 — Cohort 2.4 AI field mapping.
  runFieldMapping: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
  ) => Promise<unknown>;
  saveFieldMappings: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
    mappings: Array<{
      sourceColumn: string;
      targetField: string;
      confidence: number | null;
    }>,
  ) => Promise<unknown>;
  FIELD_UNIVERSE_BY_ENTITY: Record<
    string,
    Array<{
      name: string;
      label: string;
      description: string;
      kind: "canonical" | "lookup";
    }>
  >;
  // KAN-907 — Cohort 2.3 row-level classification.
  runRowClassification: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
  ) => Promise<unknown>;
  confirmRowClassification: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
  ) => Promise<unknown>;
  // KAN-911 — Cohort 2.6 duplicate detection.
  runDuplicateDetection: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
  ) => Promise<unknown>;
  getStagingForReview: (
    prisma: unknown,
    tenantId: string,
    input: {
      importJobId: string;
      entityType: "contacts" | "companies" | "deals" | "orders";
      filterAction?: "update" | "needs_review" | "insert" | "skip";
    },
  ) => Promise<unknown>;
  overrideStagingDecision: (
    prisma: unknown,
    tenantId: string,
    input: {
      stagingId: string;
      entityType: "contacts" | "companies" | "deals" | "orders";
      newAction: "update" | "needs_review" | "insert" | "skip";
      chosenCandidateId?: string;
    },
  ) => Promise<unknown>;
  confirmDuplicateResolution: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
  ) => Promise<unknown>;
  // KAN-913 — Cohort 2.7 commit + audit + Pub/Sub fanout.
  runCommit: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
  ) => Promise<unknown>;
  downloadCommitErrors: (
    prisma: unknown,
    importJobId: string,
    tenantId: string,
  ) => Promise<unknown>;
}
let _importJobsModule: ImportJobsRouterModule | null = null;
async function loadImportJobsModule(): Promise<ImportJobsRouterModule> {
  if (_importJobsModule) return _importJobsModule;
  const spec = "../../../packages/api/src/services/import-jobs-router.js";
  _importJobsModule = (await import(spec)) as ImportJobsRouterModule;
  return _importJobsModule;
}

/** Resolve the acting User.id from the Firebase auth context. Used by
 *  createUploadUrl to set ImportJob.createdByUserId. Pre-launch single-
 *  tenant posture: look up User by email within the tenant. Returns the
 *  User.id or throws UNAUTHORIZED if no matching User row exists. */
async function resolveCreatedByUserId(
  prisma: typeof import("./prisma.js").prisma,
  tenantId: string,
  email: string | undefined,
): Promise<string> {
  if (!email) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message:
        "Import upload requires a Firebase-authenticated user with email",
    });
  }
  const user = await prisma.user.findFirst({
    where: { email, tenantId },
    select: { id: true },
  });
  if (!user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: `No User row found for email '${email}' in this tenant. Onboarding (KAN-714) will resolve this; for now, ensure a User row exists.`,
    });
  }
  return user.id;
}

const importJobsRouter = router({
  createUploadUrl: protectedProcedure
    .input(
      z.object({
        filename: z.string().min(1).max(255),
        // 20 MB cap. Surface area is bounded by the inspection cohort —
        // larger files belong on an async pipeline (PR 4 / 2.2).
        fileSize: z.number().int().min(1).max(20 * 1024 * 1024),
        fileMimeType: z.enum([
          "text/csv",
          "application/vnd.ms-excel",
          "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ]),
        mode: z.enum(["replace_all", "update_add"]),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { createUploadUrl } = await loadImportJobsModule();
      const createdByUserId = await resolveCreatedByUserId(
        ctx.prisma,
        ctx.tenantId,
        ctx.firebaseUser?.email,
      );
      return createUploadUrl(
        ctx.prisma,
        ctx.tenantId,
        createdByUserId,
        input,
      );
    }),

  confirmUpload: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { confirmUpload } = await loadImportJobsModule();
      return confirmUpload(ctx.prisma, ctx.tenantId, input);
    }),

  list: protectedProcedure
    .input(
      z.object({
        status: z
          .enum([
            "awaiting_upload",
            "uploaded",
            "inspecting",
            "inspected",
            "failed",
          ])
          .optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listImportJobs } = await loadImportJobsModule();
      return listImportJobs(ctx.prisma, ctx.tenantId, input);
    }),

  get: protectedProcedure
    .input(z.object({ id: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { getImportJobById } = await loadImportJobsModule();
      return getImportJobById(ctx.prisma, ctx.tenantId, input);
    }),

  // KAN-904 — Cohort 2.2 AI entity detection. Runs Haiku-via-llm-client
  // on the file's headers + sample rows. Idempotent: re-running on a
  // job that already has detection results clears the previous fields
  // before writing fresh ones.
  runDetection: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { runEntityDetection } = await loadImportJobsModule();
      return runEntityDetection(ctx.prisma, input.importJobId, ctx.tenantId);
    }),

  // KAN-905 — Cohort 2.4 AI field mapping. Suggests column-to-field
  // mappings via Haiku. Gated on status='inspected' AND
  // detectedEntityType ∈ {contacts, companies, deals, orders}.
  // Returns BAD_REQUEST for mixed / unknown (V1 doesn't support
  // those — mixed needs PR 6, unknown needs manual entity pick).
  runMapping: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { runFieldMapping } = await loadImportJobsModule();
      return runFieldMapping(ctx.prisma, input.importJobId, ctx.tenantId);
    }),

  // KAN-905 — operator-confirmed mappings. Stricter validation than
  // runMapping: rejects collisions (two non-skip columns sharing the
  // same target_field). Sets fieldMappingConfirmedAt to the write
  // timestamp.
  saveMappings: protectedProcedure
    .input(
      z.object({
        importJobId: z.string().cuid(),
        mappings: z.array(
          z.object({
            sourceColumn: z.string().min(1),
            targetField: z.string().min(1),
            confidence: z.number().int().min(0).max(100).nullable(),
          }),
        ),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { saveFieldMappings } = await loadImportJobsModule();
      return saveFieldMappings(
        ctx.prisma,
        input.importJobId,
        ctx.tenantId,
        input.mappings,
      );
    }),

  // KAN-905 — UI dropdown options. Returns the entity's field universe
  // (CONTACT_FIELDS / COMPANY_FIELDS / DEAL_FIELDS / ORDER_FIELDS) so
  // the mapping page can render the target-field dropdown. Empty
  // array for 'mixed' / 'unknown' (the UI never reaches this state
  // anyway — Card 4 gates).
  getFieldUniverse: protectedProcedure
    .input(z.object({ entityType: z.string() }))
    .query(async ({ input }) => {
      const { FIELD_UNIVERSE_BY_ENTITY } = await loadImportJobsModule();
      return FIELD_UNIVERSE_BY_ENTITY[input.entityType] ?? [];
    }),

  // KAN-907 — Cohort 2.3 row-level classification. Re-downloads the
  // file from GCS, runs heuristic prefilter + LLM batch classifier,
  // and writes staging rows. Gated on status='inspected' AND
  // detectedEntityType IS NOT NULL AND IS NOT 'unknown'. Synchronous;
  // typical latency 5-30s depending on row count.
  runRowClassification: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { runRowClassification } = await loadImportJobsModule();
      return runRowClassification(ctx.prisma, input.importJobId, ctx.tenantId);
    }),

  // KAN-907 — operator confirmation. Sets rowClassificationConfirmedAt
  // to now() and unblocks the field-mapping card.
  confirmRowClassification: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { confirmRowClassification } = await loadImportJobsModule();
      return confirmRowClassification(ctx.prisma, input.importJobId, ctx.tenantId);
    }),

  // KAN-911 — Cohort 2.6 duplicate detection. Pure rule-based +
  // Levenshtein, no LLM. Gated on rowClassificationConfirmedAt being
  // non-null. Writes a MatchDecision JSON onto every staging row + a
  // DedupCounts aggregate onto the ImportJob.
  runDuplicateDetection: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { runDuplicateDetection } = await loadImportJobsModule();
      return runDuplicateDetection(ctx.prisma, input.importJobId, ctx.tenantId);
    }),

  // KAN-911 — UI list query for the duplicates resolution table.
  // Returns staging rows grouped under one of the 4 entity types, with
  // optional filter by suggestedAction (or userChoice action if set).
  getStagingForReview: protectedProcedure
    .input(
      z.object({
        importJobId: z.string().cuid(),
        entityType: z.enum(["contacts", "companies", "deals", "orders"]),
        filterAction: z
          .enum(["update", "needs_review", "insert", "skip"])
          .optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { getStagingForReview } = await loadImportJobsModule();
      return getStagingForReview(ctx.prisma, ctx.tenantId, input);
    }),

  // KAN-911 — operator per-row override. Sets MatchDecision.userChoice
  // on the staging row. Requires chosenCandidateId when newAction is
  // 'update' (so commit knows which canonical entity to merge into).
  overrideStagingDecision: protectedProcedure
    .input(
      z.object({
        stagingId: z.string().cuid(),
        entityType: z.enum(["contacts", "companies", "deals", "orders"]),
        newAction: z.enum(["update", "needs_review", "insert", "skip"]),
        chosenCandidateId: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { overrideStagingDecision } = await loadImportJobsModule();
      return overrideStagingDecision(ctx.prisma, ctx.tenantId, input);
    }),

  // KAN-911 — final gate before commit (PR 8). Refuses if any
  // needs_review row hasn't been overridden. Sets dedupConfirmedAt.
  confirmDuplicateResolution: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { confirmDuplicateResolution } = await loadImportJobsModule();
      return confirmDuplicateResolution(ctx.prisma, input.importJobId, ctx.tenantId);
    }),

  // KAN-913 — Cohort 2.7 commit + audit + Pub/Sub fanout. Iterates
  // staging rows in pending/ready state and applies the canonical
  // INSERT or UPDATE per row's KAN-911 matchDecision. Per-row
  // $transaction wraps canonical write + staging status update + audit
  // log entry. Pub/Sub fires AFTER the per-row tx commits (env-flag
  // gated IMPORT_EVENTS_ENABLED). Gated on dedupConfirmedAt IS NOT NULL
  // — preserves the KAN-907/911 *ConfirmedAt convention. Synchronous
  // for V1; ~30-60s typical for 10K rows. Async Cloud Run job is a
  // follow-up ticket.
  runCommit: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .mutation(async ({ ctx, input }) => {
      const { runCommit } = await loadImportJobsModule();
      return runCommit(ctx.prisma, input.importJobId, ctx.tenantId);
    }),

  // KAN-913 — on-demand CSV download of commitErrors JSON. Returns
  // { csvContent, rowCount } — the UI wires this to a Blob download.
  // No GCS write at commit time; CSV generated from the JSON every
  // call (small, simple, no cleanup burden).
  downloadCommitErrors: protectedProcedure
    .input(z.object({ importJobId: z.string().cuid() }))
    .query(async ({ ctx, input }) => {
      const { downloadCommitErrors } = await loadImportJobsModule();
      return downloadCommitErrors(ctx.prisma, input.importJobId, ctx.tenantId);
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
    // LEAD_INBOX_DOMAIN is read by the connectors service; the apps/api
    // surface returns the slug + a hint domain. Frontend composes the
    // displayed address; if the env var differs across services the
    // frontend value lags but the receive-side address is still authoritative.
    const domain = process.env.LEAD_INBOX_DOMAIN ?? "leads.axisone.app";
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
    const domain = process.env.LEAD_INBOX_DOMAIN ?? "leads.axisone.app";
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

// ============================================================================
// KAN-852 — Account Page Cohort 1. Tenant-facing Company Truth: identity,
// contact, hours, payments, legal. Spec page Confluence/SD/5046274.
//
// Cohort 1 ships: get + 5 tab-update mutations + child entity CRUD
// (holidays, social profiles, industry disclosures). Out of scope here per
// spec: detect-from-website (Cohort 5/6) and logo signed-URL flow (Cohort 2).
//
// Pub/Sub: every successful update emits one `account.field_updated` event
// per changed field. The publish call is gated by ACCOUNT_EVENTS_ENABLED
// env flag (default false) — Cohort 6 wires the AuditLog subscriber and
// flips the flag. Until then no real Pub/Sub call fires; the publisher
// returns `{skipped:true}` so existing tests + telemetry can still observe
// the call site.
// ============================================================================

/** KAN-855 — translate stored GCS object names on AccountProfile.logoUrl
 * + logoVariants into freshly-signed GET URLs (1hr TTL). Mutating helper:
 * returns the same row with the two columns rewritten. Called by
 * account.get + every mutation handler that returns the row. */
async function _withSignedLogoUrls(row: any): Promise<any> {
  if (!row) return row;
  const storage = await loadAccountLogoStorage();
  const enriched = await storage.enrichLogoUrls(
    row.logoUrl ?? null,
    (row.logoVariants ?? null) as { "256"?: string; "128"?: string; "64"?: string } | null,
  );
  return { ...row, logoUrl: enriched.logoUrl, logoVariants: enriched.logoVariants };
}

/** Deep-equality helper for diff detection — JSON-stringify is sufficient
 * because the columns we compare are scalars, primitive arrays, or JSON
 * blobs (weeklyHours, logoVariants). Order-sensitive on arrays, which is
 * the desired behavior — reordering supportedLanguages IS a change. */
function _accountValuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (a === undefined || b === undefined) return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Apply a partial update to AccountProfile, emit one Pub/Sub event per
 * changed field, return the updated row. Provisions on first call so
 * the UI never has to call a separate `create` endpoint. */
async function _applyAccountUpdate(
  ctx: { prisma: any; tenantId?: string; firebaseUser: { uid: string; email?: string } | null },
  data: Record<string, unknown>,
): Promise<any> {
  const tenantId = ctx.tenantId;
  if (!tenantId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
  }
  // Provision-on-first-touch: many UI flows hit a tab and Save before they
  // ever GET. Defaults to Tenant.name for legalName so the row passes the
  // NOT NULL constraint.
  const existing: any = await (ctx.prisma as any).accountProfile?.findUnique({
    where: { tenantId },
  });
  let current: any = existing;
  if (!current) {
    const tenant: any = await (ctx.prisma as any).tenant?.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    if (!tenant) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
    }
    current = await (ctx.prisma as any).accountProfile?.create({
      data: { tenantId, legalName: tenant.name },
    });
  }

  // Diff: only fields actually changed get an event. The mutation sends
  // the same row back via update.data either way; the event matters for
  // audit-log signal.
  const changed: Array<{ path: string; oldValue: unknown; newValue: unknown }> = [];
  for (const [path, newValue] of Object.entries(data)) {
    if (!_accountValuesEqual(current[path], newValue)) {
      changed.push({ path, oldValue: current[path] ?? null, newValue });
    }
  }

  const updated: any = await (ctx.prisma as any).accountProfile?.update({
    where: { tenantId },
    data,
    include: {
      socialProfiles: { orderBy: { position: "asc" } },
      observedHolidays: { orderBy: { date: "asc" } },
      industryDisclosures: { orderBy: { position: "asc" } },
    },
  });

  if (changed.length > 0) {
    const pub = await loadAccountPublisher();
    if (pub.accountEventsEnabled()) {
      for (const c of changed) {
        const event = buildAccountFieldUpdatedEvent({
          eventId: randomUUID(),
          tenantId,
          fieldPath: c.path,
          oldValue: c.oldValue,
          newValue: c.newValue,
          source: "human",
          userId: ctx.firebaseUser?.uid ?? null,
        });
        // Fire-and-forget: failures must NOT roll back the row update — the
        // user's save is the canonical action; the audit-log event is
        // best-effort. Cohort 6 wires retry/dead-letter at the subscriber.
        //
        // KAN-876: log the error rather than swallowing it silently. The
        // original `.catch(() => {})` hid a TypeError from a client-API
        // mismatch in the publisher for the entire Cohort 6 close-out
        // window. Best-effort posture preserved (no rethrow, save still
        // succeeds); visibility added so a future drift surfaces in
        // logs instead of vanishing into the void.
        await pub.publishAccountFieldUpdated(event).catch((err) => {
          console.error(
            `[account.field_updated] publish failed for fieldPath=${c.path} tenantId=${tenantId}:`,
            err,
          );
        });
      }
    }
  }

  return _withSignedLogoUrls(updated);
}

// Exported (rather than const) so the KAN-852 integration test in
// apps/api/src/__tests__/kan-852-account-router.test.ts can construct a
// caller directly via `accountRouter.createCaller(ctx)` without pulling
// the full appRouter graph.
export const accountRouter = router({
  // GET — load AccountProfile for the active tenant. Provisions on first
  // touch via upsert so the UI sees a usable row immediately after tenant
  // creation. KAN-855 (Cohort 2 / Fred E.4): switched from
  // findUnique+conditional create to upsert — the prior shape race-loses
  // when two concurrent requests both find the row missing and both try
  // to create, hitting the @unique constraint on tenantId.
  //
  // KAN-855 also enriches logoUrl/logoVariants from stored object names
  // to freshly-signed GET URLs (1hr TTL) so the browser can render the
  // logo without backing storage being public.
  get: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
    }
    const tenant: any = await (ctx.prisma as any).tenant?.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    if (!tenant) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Tenant not found" });
    }
    const row: any = await (ctx.prisma as any).accountProfile?.upsert({
      where: { tenantId },
      create: { tenantId, legalName: tenant.name },
      update: {},
      include: {
        socialProfiles: { orderBy: { position: "asc" } },
        observedHolidays: { orderBy: { date: "asc" } },
        industryDisclosures: { orderBy: { position: "asc" } },
      },
    });
    const enriched = await _withSignedLogoUrls(row);
    // KAN-859 — resolve Blueprint defaults for the Legal tab. Falls
    // back to the bundled GENERIC_BLUEPRINT when no active BrainSnapshot
    // exists for the tenant (new tenants pre-Cohort 5 detection).
    //
    // Defense-in-depth try/catch: the loadBlueprintLoader path crosses
    // a Prisma boundary (BrainSnapshot lookup). A schema/code drift
    // there must NOT 500 the entire account.get response — the Legal
    // tab gracefully falls back to GENERIC_BLUEPRINT. Captured the
    // same class of bug surfaced by the BrainSnapshot.status drift
    // (~ "fix/account-get-brainsnapshot-drift" PR).
    const bp = await loadBlueprintLoader();
    let blueprint;
    try {
      blueprint = (await bp.getBlueprintForTenant(tenantId)) ?? bp.GENERIC_BLUEPRINT;
    } catch (err) {
      console.warn(
        "[account.get] getBlueprintForTenant threw; falling back to GENERIC_BLUEPRINT",
        err,
      );
      blueprint = bp.GENERIC_BLUEPRINT;
    }
    const legalDefaults = bp.resolveLegalDefaults({
      accountProfile: {
        optOutLanguage: row?.optOutLanguage ?? null,
        emailFooterDisclosure: row?.emailFooterDisclosure ?? null,
        defaultLanguage: row?.defaultLanguage ?? "en",
      },
      blueprint,
    });
    return { ...enriched, legalDefaults };
  }),

  // ── Tab updates ──
  updateIdentity: protectedProcedure
    .input(IdentityUpdateSchema)
    .mutation(async ({ ctx, input }) => _applyAccountUpdate(ctx, input)),

  updateContact: protectedProcedure
    .input(ContactUpdateSchema)
    .mutation(async ({ ctx, input }) => {
      // KAN-857 Decision 8: when mailingSameAsPhysical=true, server
      // explicitly nulls mailingAddress so a stale value from a prior
      // toggle-off session can't survive a toggle-on save. The boolean
      // is the source of truth; downstream consumers (email composer,
      // etc.) read mailingSameAsPhysical and substitute physicalAddress
      // when reading. Wrapping at the procedure level keeps the shared
      // _applyAccountUpdate helper free of contact-specific logic.
      const normalized: typeof input =
        input.mailingSameAsPhysical === true
          ? { ...input, mailingAddress: null }
          : input;
      return _applyAccountUpdate(ctx, normalized);
    }),

  updateHours: protectedProcedure
    .input(HoursUpdateSchema)
    .mutation(async ({ ctx, input }) => _applyAccountUpdate(ctx, input)),

  updatePayments: protectedProcedure
    .input(PaymentsUpdateSchema)
    .mutation(async ({ ctx, input }) => _applyAccountUpdate(ctx, input)),

  updateLegal: protectedProcedure
    .input(LegalUpdateSchema)
    .mutation(async ({ ctx, input }) => _applyAccountUpdate(ctx, input)),

  // ── Holidays ──
  // Tenant scope flows transitively: all queries filter via the parent
  // AccountProfile.tenantId. We never trust a child id alone — always
  // verify the FK chain back to ctx.tenantId before mutating.
  addHoliday: protectedProcedure
    .input(HolidayCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const profile: any = await (ctx.prisma as any).accountProfile?.findUnique({
        where: { tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!profile) {
        throw new TRPCError({ code: "NOT_FOUND", message: "AccountProfile not provisioned" });
      }
      return (ctx.prisma as any).observedHoliday?.create({
        data: {
          accountProfileId: profile.id,
          name: input.name,
          date: new Date(input.date),
          recurring: input.recurring,
        },
      });
    }),

  removeHoliday: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      // FK-transitive isolation: deleteMany with a JOIN-shape where on the
      // parent's tenantId guarantees the row belongs to this tenant.
      const result: any = await (ctx.prisma as any).observedHoliday?.deleteMany({
        where: {
          id: input.id,
          accountProfile: { tenantId: ctx.tenantId },
        },
      });
      if (!result || result.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Holiday not found" });
      }
      return { ok: true };
    }),

  // ── Social profiles ──
  addSocialProfile: protectedProcedure
    .input(SocialProfileCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const profile: any = await (ctx.prisma as any).accountProfile?.findUnique({
        where: { tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!profile) {
        throw new TRPCError({ code: "NOT_FOUND", message: "AccountProfile not provisioned" });
      }
      // Append at end — UI can reorder later (Cohort 2+).
      const last: any = await (ctx.prisma as any).socialProfile?.findFirst({
        where: { accountProfileId: profile.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const position = (last?.position ?? -1) + 1;
      return (ctx.prisma as any).socialProfile?.create({
        data: {
          accountProfileId: profile.id,
          platform: input.platform,
          url: input.url,
          handle: input.handle ?? null,
          position,
        },
      });
    }),

  removeSocialProfile: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result: any = await (ctx.prisma as any).socialProfile?.deleteMany({
        where: {
          id: input.id,
          accountProfile: { tenantId: ctx.tenantId },
        },
      });
      if (!result || result.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Social profile not found" });
      }
      return { ok: true };
    }),

  // ── Industry disclosures ──
  addDisclosure: protectedProcedure
    .input(DisclosureCreateSchema)
    .mutation(async ({ ctx, input }) => {
      const profile: any = await (ctx.prisma as any).accountProfile?.findUnique({
        where: { tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!profile) {
        throw new TRPCError({ code: "NOT_FOUND", message: "AccountProfile not provisioned" });
      }
      const last: any = await (ctx.prisma as any).industryDisclosure?.findFirst({
        where: { accountProfileId: profile.id },
        orderBy: { position: "desc" },
        select: { position: true },
      });
      const position = (last?.position ?? -1) + 1;
      return (ctx.prisma as any).industryDisclosure?.create({
        data: {
          accountProfileId: profile.id,
          label: input.label,
          body: input.body,
          appliesToChannels: input.appliesToChannels,
          position,
        },
      });
    }),

  removeDisclosure: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const result: any = await (ctx.prisma as any).industryDisclosure?.deleteMany({
        where: {
          id: input.id,
          accountProfile: { tenantId: ctx.tenantId },
        },
      });
      if (!result || result.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Disclosure not found" });
      }
      return { ok: true };
    }),

  // ─────────────────────────────────────────────
  // KAN-862 — Detect-from-website mutations (spec §5)
  // ─────────────────────────────────────────────
  // 5 mutations cover the full UI surface for Cohort 6:
  //   detectFromWebsite       — kicks off a scan (rate-limited, enqueues Cloud Task)
  //   getDetectionProposals   — list status='proposed' rows for current tenant
  //   acceptDetection         — write proposed value to AccountProfile + mark accepted
  //   rejectDetection         — mark rejected (no AccountProfile write)
  //   acceptAllDetections     — bulk accept everything still 'proposed'
  //
  // Tenant scope is enforced via _applyAccountUpdate helper (for accept) +
  // FK-transitive deleteMany shape (for reject). The Cloud Task body
  // contains tenantId from ctx; the worker re-validates tenant scope when
  // it loads the AccountProfile by tenantId.
  //
  // Rate limit (1/tenant/60s) lives in account-detect-rate-limit.ts —
  // sibling helper to KAN-742's api-rate-limit.ts. Fail-open posture
  // matches.
  //
  // Cloud Tasks enqueue + OIDC dispatch chain provisioned via
  // infra/terraform/account-detect.tf (sibling Terraform PR landed
  // pre-code).
  detectFromWebsite: protectedProcedure
    .input(z.object({ websiteUrl: z.string().url() }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.tenantId;
      if (!tenantId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
      }
      // Dynamic-import the rate-limit + tasks-client + publisher modules
      // so the cross-rootDir TS6059 cohort hygiene holds. Same pattern
      // as the publisher loader at the top of this file.
      const rateLimitMod = (await import("./services/account-detect-rate-limit.js")) as {
        checkAccountDetectRateLimit: (
          tenantId: string,
        ) => Promise<{ allowed: boolean; resetAt: number; limit: number }>;
      };
      const limit = await rateLimitMod.checkAccountDetectRateLimit(tenantId);
      if (!limit.allowed) {
        throw new TRPCError({
          code: "TOO_MANY_REQUESTS",
          message: `Rate limit exceeded. Try again after ${new Date(limit.resetAt * 1000).toISOString()}.`,
        });
      }
      const tasksMod = (await import("./services/account-detect-tasks-client.js")) as {
        enqueueAccountDetectTask: (body: {
          tenantId: string;
          jobId: string;
          websiteUrl: string;
        }) => Promise<{ taskName: string }>;
      };
      const publishMod = (await import("./services/account-detect-publishers.js")) as {
        publishDetectStarted: (event: {
          tenantId: string;
          jobId: string;
          websiteUrl: string;
          enqueuedAt: string;
        }) => Promise<void>;
      };
      const jobId = randomUUID();
      const enqueuedAt = new Date().toISOString();
      await tasksMod.enqueueAccountDetectTask({
        tenantId,
        jobId,
        websiteUrl: input.websiteUrl,
      });
      await publishMod.publishDetectStarted({
        tenantId,
        jobId,
        websiteUrl: input.websiteUrl,
        enqueuedAt,
      });
      return { jobId, estimatedSeconds: 12 };
    }),

  getDetectionProposals: protectedProcedure.query(async ({ ctx }) => {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
    }
    const profile = (await (ctx.prisma as any).accountProfile?.findUnique({
      where: { tenantId },
      select: { id: true },
    })) as { id: string } | null;
    if (!profile) return { proposals: [] };
    const rows = (await (ctx.prisma as any).accountFieldDetection?.findMany({
      where: { accountProfileId: profile.id, status: "proposed" },
      orderBy: { createdAt: "asc" },
    })) as Array<{
      id: string;
      fieldPath: string;
      proposedValue: string;
      confidence: number;
      sourceUrl: string | null;
      sourceSnippet: string | null;
      createdAt: Date;
    }>;
    return { proposals: rows };
  }),

  acceptDetection: protectedProcedure
    .input(z.object({ detectionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.tenantId;
      if (!tenantId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
      }
      // Tenant-scope check via FK-transitive include
      const detection = (await (ctx.prisma as any).accountFieldDetection?.findFirst({
        where: {
          id: input.detectionId,
          status: "proposed",
          accountProfile: { tenantId },
        },
      })) as {
        id: string;
        fieldPath: string;
        proposedValue: string;
        accountProfileId: string;
      } | null;
      if (!detection) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Detection not found" });
      }
      // Decode the JSON-stringified value back to its native shape and
      // route through _applyAccountUpdate so the audit-event publisher
      // fires for the same field-path the detection wrote.
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(detection.proposedValue);
      } catch {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Stored proposedValue is not valid JSON — cannot accept",
        });
      }
      await _applyAccountUpdate(ctx, { [detection.fieldPath]: parsedValue });
      // Mark the detection accepted with audit metadata
      await (ctx.prisma as any).accountFieldDetection?.update({
        where: { id: detection.id },
        data: {
          status: "accepted",
          decidedAt: new Date(),
          decidedBy: ctx.firebaseUser?.uid ?? null,
        },
      });
      return { ok: true };
    }),

  rejectDetection: protectedProcedure
    .input(z.object({ detectionId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.tenantId;
      if (!tenantId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
      }
      const result = (await (ctx.prisma as any).accountFieldDetection?.updateMany({
        where: {
          id: input.detectionId,
          status: "proposed",
          accountProfile: { tenantId },
        },
        data: {
          status: "rejected",
          decidedAt: new Date(),
          decidedBy: ctx.firebaseUser?.uid ?? null,
        },
      })) as { count: number } | null;
      if (!result || result.count === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Detection not found" });
      }
      return { ok: true };
    }),

  acceptAllDetections: protectedProcedure.mutation(async ({ ctx }) => {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
    }
    const profile = (await (ctx.prisma as any).accountProfile?.findUnique({
      where: { tenantId },
      select: { id: true },
    })) as { id: string } | null;
    if (!profile) return { acceptedCount: 0 };
    const proposals = (await (ctx.prisma as any).accountFieldDetection?.findMany({
      where: { accountProfileId: profile.id, status: "proposed" },
      select: { id: true, fieldPath: true, proposedValue: true },
    })) as Array<{ id: string; fieldPath: string; proposedValue: string }>;
    let acceptedCount = 0;
    for (const p of proposals) {
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(p.proposedValue);
      } catch {
        continue; // skip malformed rows; per-row failure doesn't abort batch
      }
      try {
        await _applyAccountUpdate(ctx, { [p.fieldPath]: parsedValue });
        await (ctx.prisma as any).accountFieldDetection?.update({
          where: { id: p.id },
          data: {
            status: "accepted",
            decidedAt: new Date(),
            decidedBy: ctx.firebaseUser?.uid ?? null,
          },
        });
        acceptedCount++;
      } catch (err) {
        console.warn(`[acceptAllDetections] field ${p.fieldPath} write failed:`, err);
      }
    }
    return { acceptedCount };
  }),

  // ─────────────────────────────────────────────
  // KAN-866 — Cohort 6: per-field "Last updated" caption batch query.
  // ─────────────────────────────────────────────
  // Reads the most recent AuditLog row per fieldPath, scoped to
  // tenant + actionType='account_field_updated'. JSON-path filter on
  // payload.fieldPath — performance follow-up KAN-867 files a GIN index
  // when audit_log nears 100K rows per tenant. Single endpoint accepts
  // an array so each tab page does ONE roundtrip rather than N.
  //
  // Returns Record<fieldPath, { actor, createdAt } | null>. Missing
  // fieldPaths get `null` (no audit row yet). The web LastUpdatedCaption
  // renders nothing for null entries (matches HubSpot/Salesforce/GCC).
  getFieldsLastUpdated: protectedProcedure
    .input(z.object({ fieldPaths: z.array(z.string().min(1)).min(1).max(20) }))
    .query(async ({ ctx, input }) => {
      const tenantId = ctx.tenantId;
      if (!tenantId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
      }
      const out: Record<string, { actor: string; createdAt: string } | null> = {};
      for (const fp of input.fieldPaths) {
        const row = (await (ctx.prisma as any).auditLog?.findFirst({
          where: {
            tenantId,
            actionType: "account_field_updated",
            payload: { path: ["fieldPath"], equals: fp },
          },
          orderBy: { createdAt: "desc" },
          select: { actor: true, createdAt: true },
        })) as { actor: string | null; createdAt: Date } | null;
        out[fp] = row
          ? { actor: row.actor ?? "system", createdAt: row.createdAt.toISOString() }
          : null;
      }
      return out;
    }),

  // ─────────────────────────────────────────────
  // KAN-855 — logo upload (signed-URL flow)
  // ─────────────────────────────────────────────
  // Three-step flow:
  //   1. uploadLogo  — server returns a 15-min signed PUT URL + uploadId
  //   2. (browser PUTs the file body directly to GCS — no API roundtrip)
  //   3. finalizeLogo — server reads the uploaded original, runs Sharp
  //      to generate 256/128/64 variants, persists URLs in AccountProfile.
  //
  // Tenant scope: every mutation that accepts a client uploadId/objectName
  // calls isOwnedByTenant(name, ctx.tenantId) before touching GCS. The
  // path prefix `tenants/{tenantId}/account/logo-` is the only acceptable
  // shape — anything else throws FORBIDDEN.
  //
  // Concurrent-upload tech debt (Fred E.1): if a user uploads logo A and
  // immediately uploads B before A's variants finalize, A's variants may
  // get orphaned in GCS. Cleanup is deferred to a janitor cron later.

  uploadLogo: protectedProcedure
    .input(LogoUploadInputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.tenantId;
      if (!tenantId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
      }
      const storage = await loadAccountLogoStorage();
      const result = await storage.getSignedUploadUrl(tenantId, input.contentType);
      // Returned to the browser:
      //   uploadUrl  — PUT here within 15 min
      //   uploadId   — opaque, pass back to finalizeLogo (it equals
      //                objectName but the client shouldn't depend on
      //                that — server enforces tenant scope)
      //   contentType — same value the client sent; mirror so the
      //                browser PUT request can match Content-Type
      return {
        uploadUrl: result.uploadUrl,
        uploadId: result.uploadId,
        contentType: result.contentType,
      };
    }),

  finalizeLogo: protectedProcedure
    .input(LogoFinalizeInputSchema)
    .mutation(async ({ ctx, input }) => {
      const tenantId = ctx.tenantId;
      if (!tenantId) {
        throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
      }
      const storage = await loadAccountLogoStorage();
      // Tenant-scope guardrail — never trust the client.
      if (!storage.isOwnedByTenant(input.uploadId, tenantId)) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "uploadId does not belong to this tenant",
        });
      }
      // Object must already exist (PUT preceded this call).
      const exists = await storage.objectExists(input.uploadId);
      if (!exists) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Uploaded object not found — did the PUT complete?",
        });
      }
      const ext = storage.parseExtFromObjectName(input.uploadId);
      const ts = storage.parseTimestampFromObjectName(input.uploadId);
      if (!ext || ts === null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Malformed uploadId — expected logo-{timestamp}.{ext}",
        });
      }

      // Variant generation:
      //   SVG — vector, no raster resize. Point all 3 sizes at the
      //         original SVG path. Spec §2 decision 2.
      //   raster — Sharp generates + uploads 3 variants. On failure
      //         (or 10s timeout), the original logo upload still
      //         succeeds; logoVariants stays null; client shows a
      //         "Retry thumbnails" button that calls regenerateVariants.
      let logoVariants: { "256": string; "128": string; "64": string } | null = null;
      let variantWarning: string | null = null;

      if (ext === "svg") {
        logoVariants = {
          "256": input.uploadId,
          "128": input.uploadId,
          "64": input.uploadId,
        };
      } else {
        try {
          const original = await storage.downloadObject(input.uploadId);
          const v = await storage.generateAndUploadVariants(
            tenantId,
            original,
            ext as "png" | "jpg" | "webp",
            ts,
          );
          logoVariants = { "256": v.size256, "128": v.size128, "64": v.size64 };
        } catch (err) {
          variantWarning = err instanceof Error ? err.message : String(err);
        }
      }

      const updated: any = await (ctx.prisma as any).accountProfile?.update({
        where: { tenantId },
        data: {
          logoUrl: input.uploadId,
          logoVariants,
        },
        include: {
          socialProfiles: { orderBy: { position: "asc" } },
          observedHolidays: { orderBy: { date: "asc" } },
          industryDisclosures: { orderBy: { position: "asc" } },
        },
      });
      const enriched = await _withSignedLogoUrls(updated);
      return { ...enriched, variantWarning };
    }),

  removeLogo: protectedProcedure.mutation(async ({ ctx }) => {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
    }
    const storage = await loadAccountLogoStorage();
    const profile: any = await (ctx.prisma as any).accountProfile?.findUnique({
      where: { tenantId },
      select: { logoUrl: true, logoVariants: true },
    });
    // Best-effort GCS cleanup — `ignoreNotFound: true` on each delete so
    // a partial state from a failed earlier finalize doesn't block the
    // user from clearing the logo.
    if (profile?.logoUrl) {
      const namesToDelete = new Set<string>([profile.logoUrl]);
      const variants = (profile.logoVariants ?? null) as Record<string, string> | null;
      if (variants) {
        for (const v of Object.values(variants)) {
          if (typeof v === "string") namesToDelete.add(v);
        }
      }
      await Promise.all(
        Array.from(namesToDelete).map((n) => storage.deleteObject(n).catch(() => undefined)),
      );
    }
    const updated: any = await (ctx.prisma as any).accountProfile?.update({
      where: { tenantId },
      data: { logoUrl: null, logoVariants: null },
      include: {
        socialProfiles: { orderBy: { position: "asc" } },
        observedHolidays: { orderBy: { date: "asc" } },
        industryDisclosures: { orderBy: { position: "asc" } },
      },
    });
    return _withSignedLogoUrls(updated);
  }),

  // Recovery path (Fred E.2) — Sharp failed during finalizeLogo, the
  // original logo persisted but logoVariants stayed null. Client offers
  // a "Retry thumbnails" button that calls this mutation. Re-downloads
  // the original from GCS and re-runs variant generation. No new GCS
  // upload of the original; the existing logoUrl stays put.
  regenerateVariants: protectedProcedure.mutation(async ({ ctx }) => {
    const tenantId = ctx.tenantId;
    if (!tenantId) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Missing tenant context" });
    }
    const storage = await loadAccountLogoStorage();
    const profile: any = await (ctx.prisma as any).accountProfile?.findUnique({
      where: { tenantId },
      select: { logoUrl: true },
    });
    if (!profile?.logoUrl) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "No logo set — upload a logo first",
      });
    }
    const objectName = profile.logoUrl as string;
    if (!storage.isOwnedByTenant(objectName, tenantId)) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Logo not owned by this tenant" });
    }
    const ext = storage.parseExtFromObjectName(objectName);
    const ts = storage.parseTimestampFromObjectName(objectName);
    if (!ext || ts === null) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Stored logoUrl has malformed shape",
      });
    }
    if (ext === "svg") {
      // SVG never had real variants — short-circuit cleanly.
      const updated: any = await (ctx.prisma as any).accountProfile?.update({
        where: { tenantId },
        data: {
          logoVariants: { "256": objectName, "128": objectName, "64": objectName },
        },
        include: {
          socialProfiles: { orderBy: { position: "asc" } },
          observedHolidays: { orderBy: { date: "asc" } },
          industryDisclosures: { orderBy: { position: "asc" } },
        },
      });
      return _withSignedLogoUrls(updated);
    }
    const original = await storage.downloadObject(objectName);
    const v = await storage.generateAndUploadVariants(
      tenantId,
      original,
      ext as "png" | "jpg" | "webp",
      ts,
    );
    const updated: any = await (ctx.prisma as any).accountProfile?.update({
      where: { tenantId },
      data: {
        logoVariants: { "256": v.size256, "128": v.size128, "64": v.size64 },
      },
      include: {
        socialProfiles: { orderBy: { position: "asc" } },
        observedHolidays: { orderBy: { date: "asc" } },
        industryDisclosures: { orderBy: { position: "asc" } },
      },
    });
    return _withSignedLogoUrls(updated);
  }),
});

export const appRouter = router({
  contacts: contactsRouter,
  // KAN-883 — CRM read-layer cohort 1 (PR 1 of 3). UI lands in PR 2-3.
  companies: companiesRouter,
  orders: ordersRouter,
  deals: dealsRouter,
  // KAN-896 — Ingestion Cohort 2.1a (upload backend). UI in PR 2 (2.1b).
  importJobs: importJobsRouter,
  pipelines: pipelinesRouter,
  stages: stagesRouter,
  targets: targetsRouter,
  knowledgeFilters: knowledgeFiltersRouter,
  // KAN-826: knowledgeIngest router REMOVED. Legacy KAN-707 admin endpoints
  // were tied to the dropped KAN-786 schema. KAN-827 will introduce a new
  // ingestion API surface against the Sprint 11a knowledge_source/_chunk schema.
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
  // KAN-852 — Account Page Cohort 1
  account: accountRouter,
});

export type AppRouter = typeof appRouter;
