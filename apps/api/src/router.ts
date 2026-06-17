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
  // KAN-1140 PR 9a — tenant parser customization rule schema
  ParseRuleBodySchema,
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

// KAN-936 fix-forward — Shared id-string validator (uuid/cuid/firebase-uid
// class fix). Hand-picked `.uuid()` vs `.cuid()` Zod validators have bitten
// us 4× this session because the schema is heterogeneous: UUID defaults
// (Contact, Pipeline, Stage, User-schema-default), CUID defaults (Deal,
// Company, Order, Engagement, ImportJob, ...), and User rows in PROD carry
// 28-char Firebase Auth UIDs that bypass the schema default. Trust the DB
// FK + tenant-scoped `assertX` helpers to do real existence validation;
// the wire layer only needs "this is a plausibly-shaped id string."
//
// Bounds: min 20 / max 40 covers all three formats with a safety floor
// against empty-string + a ceiling against trivially-bad inputs. Charset
// is base62 + `-` + `_` (uuid dashes, cuid lowercase alphanumeric, Firebase
// base62-like).
//
// Class follow-up KAN-949 will fold the existing ~85 hand-picked validators
// in this file onto this shared shape where the FK-target is heterogeneous.
const entityId = z
  .string()
  .min(20)
  .max(40)
  .regex(/^[a-zA-Z0-9_-]+$/, "Invalid id format");
export { entityId };

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

/**
 * KAN-1169 — Pipeline deletability check (replaces KAN-702 canDeletePipeline).
 *
 * Reads Deal.pipelineId (canonical per KAN-700+791) instead of the deprecated
 * Contact.currentPipelineId that the prior helper used. Surfaces three signals
 * that the procedure branches on:
 *
 *   - `blockReason`: hard-block paths that no reassignment can resolve
 *     - 'last_pipeline': tenant has 1 active pipeline; deleting leaves inbounds nowhere to land
 *     - 'default_assignment': pipeline is `Tenant.defaultAssignmentPipelineId`
 *   - `dealCount`: total deals on the pipeline (terminal + active per
 *     Q-ADD-TERMINAL-DEAL-EXCLUSION lock — count ALL deals)
 *   - `destinationCandidates`: count of OTHER active pipelines (operator must
 *     have a destination if dealCount > 0)
 *   - `hasStageHistory`: TRUE if any DealStageHistory row references this
 *     pipeline's stages. Per Phase 2 architectural escalation (Option C),
 *     `DealStageHistory.toStageId Restrict` would block Stage cascade-delete;
 *     the audit_log NEVER deleted precedent (sibling to KAN-1083 Op D memo)
 *     extends to DealStageHistory. The procedure soft-archives (isActive=false)
 *     instead of hard-deleting when hasStageHistory is true.
 *
 * Async + Prisma-dependent — unit tests exercise the procedure (Step 8) rather
 * than this helper directly. Integration test (Step 9) verifies the real
 * Postgres FK behavior.
 */
export async function checkPipelineDeletability(
  prisma: unknown,
  tenantId: string,
  pipelineId: string,
): Promise<{
  blockReason: 'last_pipeline' | 'default_assignment' | null;
  dealCount: number;
  destinationCandidates: number;
  hasStageHistory: boolean;
}> {
  const p = prisma as {
    pipeline: { count: (args: unknown) => Promise<number> };
    tenant: { findUnique: (args: unknown) => Promise<{ defaultAssignmentPipelineId: string | null } | null> };
    deal: { count: (args: unknown) => Promise<number> };
    dealStageHistory: { count: (args: unknown) => Promise<number> };
  };

  // Block-if-last-pipeline (Q6 lock: isActive=true count === 1).
  const activePipelineCount = await p.pipeline.count({
    where: { tenantId, isActive: true },
  });
  if (activePipelineCount === 1) {
    return { blockReason: 'last_pipeline', dealCount: 0, destinationCandidates: 0, hasStageHistory: false };
  }

  // Block-if-default-assignment (Q-ADD-DEFAULT-PIPELINE-CASCADE: block hard
  // vs auto-null pointer; Phase 1 lean = block to preserve operator visibility).
  const tenant = await p.tenant.findUnique({
    where: { id: tenantId },
    select: { defaultAssignmentPipelineId: true },
  });
  if (tenant?.defaultAssignmentPipelineId === pipelineId) {
    return { blockReason: 'default_assignment', dealCount: 0, destinationCandidates: 0, hasStageHistory: false };
  }

  // Count deals (ALL — terminal_won/terminal_lost included per Q-ADD-TERMINAL-DEAL-EXCLUSION lock).
  const dealCount = await p.deal.count({
    where: { tenantId, pipelineId },
  });

  // Count destination candidates (other isActive=true pipelines per Q-ADD-INACTIVE-DESTINATION lock).
  const destinationCandidates = await p.pipeline.count({
    where: { tenantId, isActive: true, id: { not: pipelineId } },
  });

  // KAN-1169 Phase 2 Option C — detect stage history that would block Stage
  // cascade-delete (DealStageHistory.toStageId has onDelete: Restrict). If
  // present, the procedure soft-archives instead of hard-deleting; deal-scoped
  // historical retrospective ("how did Deal X arrive at its current stage?")
  // stays intact per the audit_log NEVER deleted precedent.
  const stageHistoryCount = await p.dealStageHistory.count({
    where: {
      OR: [
        { fromStage: { pipelineId } },
        { toStage: { pipelineId } },
      ],
    },
  });

  return {
    blockReason: null,
    dealCount,
    destinationCandidates,
    hasStageHistory: stageHistoryCount > 0,
  };
}

// KAN-1168 — writePipelineAuditBestEffort (6th inline copy from KAN-1169) deleted;
// consolidated into packages/api/src/utils/audit-helpers.ts. The single caller
// (pipelines.delete procedure) uses variable-specifier dynamic import to keep
// the helper out of apps/api rootDir static graph (TS6059 avoidance).

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
      // KAN-980 — KAN-882 cursor convergence. `offset` retired in favor of
      // `cursor` (canonical opaque token from _pagination.ts).
      limit?: number;
      cursor?: string;
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
        // KAN-980 — KAN-882 cursor convergence. Offset/limit retired in
        // favor of the canonical cursor shape shared with deals/companies/
        // orders. Old `offset` param removed; clients on the old shape will
        // 400 (no soft-fallback — UI lands together in this PR).
        limit: z.number().min(1).max(200).default(50),
        cursor: z.string().optional(),
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
        // KAN-934 — Cohort 3.1 form-eligible fields (Path β: full 14-field
        // surface; companyId backed by AsyncSelect Company picker).
        companyId: z.string().nullable().optional(),
        addressLine1: z.string().nullable().optional(),
        addressLine2: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        region: z.string().nullable().optional(),
        postalCode: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
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
        // KAN-934 — same 7 fields added to update.
        companyId: z.string().nullable().optional(),
        addressLine1: z.string().nullable().optional(),
        addressLine2: z.string().nullable().optional(),
        city: z.string().nullable().optional(),
        region: z.string().nullable().optional(),
        postalCode: z.string().nullable().optional(),
        country: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { updateContact } = await loadContactsModule();
      return updateContact(ctx.prisma, ctx.tenantId, input);
    }),
});

// ============================================================================
// COMPANIES ROUTER — KAN-883 (read surface) + KAN-937 (Sub-cohort 3.2 mutations)
// ============================================================================
//
// Thin tRPC layer over packages/api/src/services/companies-router.ts. Same
// variable-specifier dynamic-import pattern as contacts (TS6059 cohort).
// Read surface (list/get) shipped in KAN-883; mutations (create/update) added
// in KAN-937 for Sub-cohort 3.2 Company CRUD form.
interface CompaniesCreateInput {
  name: string;
  legalName?: string | null;
  domain?: string | null;
  website?: string | null;
  industry?: string | null;
  sizeRange?: string | null;
  annualRevenue?: string | null;
  description?: string | null;
  lifecycleStage?: string;
  phone?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingRegion?: string | null;
  billingPostalCode?: string | null;
  billingCountry?: string | null;
  mailingAddressLine1?: string | null;
  mailingAddressLine2?: string | null;
  mailingCity?: string | null;
  mailingRegion?: string | null;
  mailingPostalCode?: string | null;
  mailingCountry?: string | null;
  taxId?: string | null;
  taxIdType?: string | null;
  businessRegistrationNumber?: string | null;
  incorporationJurisdiction?: string | null;
  isTaxExempt?: boolean;
  taxExemptionCertificate?: string | null;
}
type CompaniesUpdateInput = Partial<Omit<CompaniesCreateInput, "name">> & {
  id: string;
  name?: string;
};
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
  createCompany: (
    prisma: unknown,
    tenantId: string,
    input: CompaniesCreateInput,
  ) => Promise<unknown>;
  updateCompany: (
    prisma: unknown,
    tenantId: string,
    input: CompaniesUpdateInput,
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

  // KAN-937 — Sub-cohort 3.2 Company CRUD: 30 form-eligible fields across
  // 5 cards. Loose enums match contacts.create's pattern; Prisma rejects bad
  // values at write time. `annualRevenue` is Decimal serialized as string.
  create: protectedProcedure
    .input(
      z.object({
        // Card 1 — Core Info
        name: z.string().min(1),
        legalName: z.string().nullable().optional(),
        domain: z.string().nullable().optional(),
        website: z.string().nullable().optional(),
        industry: z.string().nullable().optional(),
        sizeRange: z.string().nullable().optional(),
        annualRevenue: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        lifecycleStage: z.string().optional(),
        // Card 2 — Contact Info
        phone: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        linkedinUrl: z.string().nullable().optional(),
        // Card 3 — Billing Address
        billingAddressLine1: z.string().nullable().optional(),
        billingAddressLine2: z.string().nullable().optional(),
        billingCity: z.string().nullable().optional(),
        billingRegion: z.string().nullable().optional(),
        billingPostalCode: z.string().nullable().optional(),
        billingCountry: z.string().nullable().optional(),
        // Card 4 — Mailing Address
        mailingAddressLine1: z.string().nullable().optional(),
        mailingAddressLine2: z.string().nullable().optional(),
        mailingCity: z.string().nullable().optional(),
        mailingRegion: z.string().nullable().optional(),
        mailingPostalCode: z.string().nullable().optional(),
        mailingCountry: z.string().nullable().optional(),
        // Card 5 — Tax & Compliance
        taxId: z.string().nullable().optional(),
        taxIdType: z.string().nullable().optional(),
        businessRegistrationNumber: z.string().nullable().optional(),
        incorporationJurisdiction: z.string().nullable().optional(),
        isTaxExempt: z.boolean().optional(),
        taxExemptionCertificate: z.string().nullable().optional(),
        // KAN-936 — optional FK to User
        // KAN-936 fix-forward — entityId covers uuid/cuid/firebase-uid (User
        // rows in PROD use Firebase Auth UIDs which bypass the schema's
        // @default(uuid())). See entityId definition for class-fix rationale.
        ownerId: entityId.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { createCompany } = await loadCompaniesModule();
      return createCompany(ctx.prisma, ctx.tenantId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        // All fields optional on update — partial-update semantics.
        name: z.string().min(1).optional(),
        legalName: z.string().nullable().optional(),
        domain: z.string().nullable().optional(),
        website: z.string().nullable().optional(),
        industry: z.string().nullable().optional(),
        sizeRange: z.string().nullable().optional(),
        annualRevenue: z.string().nullable().optional(),
        description: z.string().nullable().optional(),
        lifecycleStage: z.string().optional(),
        phone: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        linkedinUrl: z.string().nullable().optional(),
        billingAddressLine1: z.string().nullable().optional(),
        billingAddressLine2: z.string().nullable().optional(),
        billingCity: z.string().nullable().optional(),
        billingRegion: z.string().nullable().optional(),
        billingPostalCode: z.string().nullable().optional(),
        billingCountry: z.string().nullable().optional(),
        mailingAddressLine1: z.string().nullable().optional(),
        mailingAddressLine2: z.string().nullable().optional(),
        mailingCity: z.string().nullable().optional(),
        mailingRegion: z.string().nullable().optional(),
        mailingPostalCode: z.string().nullable().optional(),
        mailingCountry: z.string().nullable().optional(),
        taxId: z.string().nullable().optional(),
        taxIdType: z.string().nullable().optional(),
        businessRegistrationNumber: z.string().nullable().optional(),
        incorporationJurisdiction: z.string().nullable().optional(),
        isTaxExempt: z.boolean().optional(),
        taxExemptionCertificate: z.string().nullable().optional(),
        // KAN-936 — optional FK to User
        // KAN-936 fix-forward — entityId covers uuid/cuid/firebase-uid (User
        // rows in PROD use Firebase Auth UIDs which bypass the schema's
        // @default(uuid())). See entityId definition for class-fix rationale.
        ownerId: entityId.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { updateCompany } = await loadCompaniesModule();
      return updateCompany(ctx.prisma, ctx.tenantId, input);
    }),
});

// ============================================================================
// ORDERS ROUTER — KAN-883 (read surface) + KAN-945 (Sub-cohort 3.4 mutations)
// ============================================================================
interface OrdersCreateInput {
  // Card 1
  orderNumber: string;
  status?: string;
  source?: string;
  // Card 2
  totalAmount?: string;
  taxAmount?: string;
  discountAmount?: string;
  grandTotal?: string;
  currency?: string;
  // Card 3
  paymentMethod?: string | null;
  paymentProvider?: string | null;
  providerOrderId?: string | null;
  placedAt?: string | null;
  paidAt?: string | null;
  refundedAt?: string | null;
  cancelledAt?: string | null;
  // Card 4
  contactId: string;
  companyId?: string | null;
  dealId?: string | null;
  // Card 5
  attributionFirstSource?: string | null;
  attributionLastSource?: string | null;
  customerNotes?: string | null;
  internalNotes?: string | null;
}
type OrdersUpdateInput = Partial<Omit<OrdersCreateInput, "orderNumber" | "contactId">> & {
  id: string;
  contactId?: string;
};
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
  createOrder: (
    prisma: unknown,
    tenantId: string,
    input: OrdersCreateInput,
  ) => Promise<unknown>;
  updateOrder: (
    prisma: unknown,
    tenantId: string,
    input: OrdersUpdateInput,
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
        // KAN-944 — Contact.id is @default(uuid()) — verified directly in
        // packages/db/prisma/schema.prisma. KAN-945 Q9 erroneously flipped
        // this to .cuid() based on a wrong-premise audit claim (the smoke
        // didn't catch it because the contactId filter wasn't exercised).
        // Reverted here as part of the KAN-944 sweep. Per-procedure schema
        // cross-reference confirmed this is the ONLY validator mismatch in
        // router.ts — all 81 other .uuid()/.cuid() occurrences are correct.
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

  // KAN-945 — Sub-cohort 3.4 Order CRUD. 22 form-eligible fields across 5
  // cards. Required: orderNumber + contactId. Optional FKs: companyId,
  // dealId. Loose enums match contacts/companies/deals pattern; Prisma
  // rejects bad values at write time. Money fields are Decimal serialized
  // as string. Date fields are full DateTime (form sends yyyy-mm-dd;
  // backend's `toDate()` coerces). orderNumber is unique per tenant —
  // P2002 collisions surface as friendly BAD_REQUEST.
  create: protectedProcedure
    .input(
      z.object({
        // Card 1 — Core Order
        orderNumber: z.string().min(1),
        status: z.string().optional(),
        source: z.string().optional(),
        // Card 2 — Money
        totalAmount: z.string().optional(),
        taxAmount: z.string().optional(),
        discountAmount: z.string().optional(),
        grandTotal: z.string().optional(),
        currency: z.string().optional(),
        // Card 3 — Payment & Timeline
        paymentMethod: z.string().nullable().optional(),
        paymentProvider: z.string().nullable().optional(),
        providerOrderId: z.string().nullable().optional(),
        placedAt: z.string().nullable().optional(),
        paidAt: z.string().nullable().optional(),
        refundedAt: z.string().nullable().optional(),
        cancelledAt: z.string().nullable().optional(),
        // Card 4 — Relationships
        contactId: z.string().min(1),
        companyId: z.string().nullable().optional(),
        dealId: z.string().nullable().optional(),
        // Card 5 — Attribution & Notes
        attributionFirstSource: z.string().nullable().optional(),
        attributionLastSource: z.string().nullable().optional(),
        customerNotes: z.string().nullable().optional(),
        internalNotes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { createOrder } = await loadOrdersModule();
      return createOrder(ctx.prisma, ctx.tenantId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        // orderNumber NOT in update surface (Q8 read-only-on-edit decision).
        // All other fields optional — partial-update semantics. Time-
        // preservation (Q6.1) relies on the form omitting unchanged date
        // fields entirely.
        status: z.string().optional(),
        source: z.string().optional(),
        totalAmount: z.string().optional(),
        taxAmount: z.string().optional(),
        discountAmount: z.string().optional(),
        grandTotal: z.string().optional(),
        currency: z.string().optional(),
        paymentMethod: z.string().nullable().optional(),
        paymentProvider: z.string().nullable().optional(),
        providerOrderId: z.string().nullable().optional(),
        placedAt: z.string().nullable().optional(),
        paidAt: z.string().nullable().optional(),
        refundedAt: z.string().nullable().optional(),
        cancelledAt: z.string().nullable().optional(),
        contactId: z.string().min(1).optional(),
        companyId: z.string().nullable().optional(),
        dealId: z.string().nullable().optional(),
        attributionFirstSource: z.string().nullable().optional(),
        attributionLastSource: z.string().nullable().optional(),
        customerNotes: z.string().nullable().optional(),
        internalNotes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { updateOrder } = await loadOrdersModule();
      return updateOrder(ctx.prisma, ctx.tenantId, input);
    }),
});

// ============================================================================
// DEALS ROUTER — KAN-883 (read surface) + KAN-938 (Sub-cohort 3.3 mutations)
// ============================================================================
interface DealsCreateInput {
  // Card 1 — Core
  name?: string;
  value?: string;
  currency?: string;
  probability?: number | null;
  // Card 2 — Status & Outcomes
  status?: string;
  expectedCloseDate?: string | null;
  lostReason?: string | null;
  lostReasonDetail?: string | null;
  wonProductSummary?: string | null;
  // Card 3 — Pipeline & Stage (REQUIRED)
  pipelineId: string;
  currentStageId: string;
  // Card 4 — Relationships
  contactId: string;
  companyId?: string | null;
}
type DealsUpdateInput = Partial<Omit<DealsCreateInput, "pipelineId" | "currentStageId" | "contactId">> & {
  id: string;
  pipelineId?: string;
  currentStageId?: string;
  contactId?: string;
};
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
  // KAN-967 — Pipelines board grouped read.
  listDealsByPipeline: (
    prisma: unknown,
    tenantId: string,
    input: { pipelineId: string },
  ) => Promise<unknown>;
  getDealById: (
    prisma: unknown,
    tenantId: string,
    input: { id: string },
  ) => Promise<unknown>;
  createDeal: (
    prisma: unknown,
    tenantId: string,
    input: DealsCreateInput,
  ) => Promise<unknown>;
  updateDeal: (
    prisma: unknown,
    tenantId: string,
    input: DealsUpdateInput,
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

  // KAN-967 — Pipelines kanban board grouped read. Returns deals grouped by
  // stage for one Pipeline, with the AI's latest Decision joined per deal,
  // capped at 50 cards per stage with a truncatedCount for "+N more".
  // Tenant-scoping in the underlying raw SQL is explicit (raw queries skip
  // Prisma tenant middleware) — cross-tenant-isolation pinned by test.
  listByPipeline: protectedProcedure
    .input(z.object({ pipelineId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { listDealsByPipeline } = await loadDealsModule();
      return listDealsByPipeline(ctx.prisma, ctx.tenantId, input);
    }),

  // KAN-938 — Sub-cohort 3.3 Deal CRUD. 13 form-eligible fields across 4
  // cards. Required FKs: contactId, pipelineId, currentStageId. Optional
  // FK: companyId. Loose enums match contacts/companies pattern; Prisma
  // rejects bad values at write time. `value` is Decimal(12,2) serialized
  // as string. `expectedCloseDate` is @db.Date (yyyy-mm-dd).
  create: protectedProcedure
    .input(
      z.object({
        // Card 1 — Core
        name: z.string().optional(),
        value: z.string().optional(),
        currency: z.string().optional(),
        probability: z.number().int().min(0).max(100).nullable().optional(),
        // Card 2 — Status & Outcomes
        status: z.string().optional(),
        expectedCloseDate: z.string().nullable().optional(),
        lostReason: z.string().nullable().optional(),
        lostReasonDetail: z.string().nullable().optional(),
        wonProductSummary: z.string().nullable().optional(),
        // Card 3 — Pipeline & Stage (REQUIRED)
        pipelineId: z.string().min(1),
        currentStageId: z.string().min(1),
        // Card 4 — Relationships
        contactId: z.string().min(1),
        companyId: z.string().nullable().optional(),
        // KAN-936 — optional FK to User
        // KAN-936 fix-forward — entityId covers uuid/cuid/firebase-uid (User
        // rows in PROD use Firebase Auth UIDs which bypass the schema's
        // @default(uuid())). See entityId definition for class-fix rationale.
        ownerId: entityId.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { createDeal } = await loadDealsModule();
      return createDeal(ctx.prisma, ctx.tenantId, input);
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().cuid(),
        // All fields optional on update — partial-update semantics.
        name: z.string().optional(),
        value: z.string().optional(),
        currency: z.string().optional(),
        probability: z.number().int().min(0).max(100).nullable().optional(),
        status: z.string().optional(),
        expectedCloseDate: z.string().nullable().optional(),
        lostReason: z.string().nullable().optional(),
        lostReasonDetail: z.string().nullable().optional(),
        wonProductSummary: z.string().nullable().optional(),
        pipelineId: z.string().min(1).optional(),
        currentStageId: z.string().min(1).optional(),
        contactId: z.string().min(1).optional(),
        companyId: z.string().nullable().optional(),
        // KAN-936 — optional FK to User
        // KAN-936 fix-forward — entityId covers uuid/cuid/firebase-uid (User
        // rows in PROD use Firebase Auth UIDs which bypass the schema's
        // @default(uuid())). See entityId definition for class-fix rationale.
        ownerId: entityId.nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { updateDeal } = await loadDealsModule();
      return updateDeal(ctx.prisma, ctx.tenantId, input);
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
    // KAN-922 — optional per-import match configuration.
    matchConfig?: {
      dedupMatchField?: string | null;
      externalSourceTag?: string | null;
      customerLinkField?: string | null;
      dealLinkField?: string | null;
    },
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
        // KAN-922 — per-import match configuration. All nullable;
        // undefined leaves the column unchanged; null clears it.
        dedupMatchField: z.string().nullable().optional(),
        externalSourceTag: z.string().nullable().optional(),
        customerLinkField: z.string().nullable().optional(),
        dealLinkField: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { saveFieldMappings } = await loadImportJobsModule();
      return saveFieldMappings(
        ctx.prisma,
        input.importJobId,
        ctx.tenantId,
        input.mappings,
        {
          dedupMatchField: input.dedupMatchField,
          externalSourceTag: input.externalSourceTag,
          customerLinkField: input.customerLinkField,
          dealLinkField: input.dealLinkField,
        },
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
        tenantId: ctx.tenantId,
        ...(input.contactId && { contactId: input.contactId }),
      };

      const [decisions, total] = await Promise.all([
        ctx.prisma.decision.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { createdAt: "desc" },
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
          tenantId: ctx.tenantId,
        },
      });

      if (!decision) {
        throw new Error("Decision not found");
      }

      return decision;
    }),

  // KAN-1107 — Dashboard Decision Feed. Chronological UNION of recent
  // Decisions + OPEN Escalations. Phase 1 Finding B reframe: Decision.source
  // doesn't exist; "AI vs H" semantic surfaces via Escalation rows mixed
  // chronologically with Decision rows. Each item carries `kind` discriminator.
  //
  // Phase 1 Q6 (Finding C): Decision.channel doesn't exist. Hybrid resolution:
  // (a) JOINed actions[0]?.channel when present, (b) actionType-derived proxy
  // (send_email → 'email', send_message → 'sms', send_follow_up → null).
  // Empirical vocab audit 2026-06-06: Action table is currently empty in PROD
  // (all 13.6k decisions, 0 dispatches yet — engine pre-launch posture).
  // Action.channel resolution will populate as dispatches accumulate.
  feed: protectedProcedure
    .input(z.object({ limit: z.number().min(1).max(50).default(5) }))
    .query(async ({ ctx, input }) => {
      const [decisions, escalations] = await Promise.all([
        ctx.prisma.decision.findMany({
          where: { tenantId: ctx.tenantId },
          orderBy: { createdAt: "desc" },
          take: input.limit,
          include: {
            contact: {
              select: { firstName: true, lastName: true, email: true, companyName: true },
            },
            actions: {
              take: 1,
              orderBy: { createdAt: "desc" },
              select: { channel: true },
            },
          },
        }),
        ctx.prisma.escalation.findMany({
          where: { tenantId: ctx.tenantId, status: "open" },
          orderBy: { createdAt: "desc" },
          take: input.limit,
          include: {
            contact: {
              select: { firstName: true, lastName: true, email: true, companyName: true },
            },
          },
        }),
      ]);

      // Q6 hybrid channel derivation (server-side projection, kept local
      // here; UI-side projection helper in action-icon-projection.ts handles
      // labeling + icons).
      const actionTypeToChannel: Record<string, string | null> = {
        send_email: "email",
        send_message: "sms",
        send_follow_up: null,
      };

      type FeedItem = {
        id: string;
        kind: "decision" | "escalation";
        contactId: string;
        contact: {
          firstName: string | null;
          lastName: string | null;
          email: string | null;
          companyName: string | null;
        };
        createdAt: Date;
        reasoning: string | null;
        // Decision-side
        strategy?: string;
        actionType?: string;
        channel?: string | null;
        confidence?: number;
        // Escalation-side
        severity?: string;
        triggerType?: string;
      };

      const items: FeedItem[] = [
        ...decisions.map((d): FeedItem => ({
          id: d.id,
          kind: "decision",
          contactId: d.contactId,
          contact: d.contact,
          createdAt: d.createdAt,
          reasoning: d.reasoning,
          strategy: d.strategySelected,
          actionType: d.actionType,
          channel: d.actions[0]?.channel ?? actionTypeToChannel[d.actionType] ?? null,
          confidence: d.confidence,
        })),
        ...escalations.map((e): FeedItem => ({
          id: e.id,
          kind: "escalation",
          contactId: e.contactId,
          contact: e.contact,
          createdAt: e.createdAt,
          reasoning: e.triggerReason ?? null,
          severity: e.severity,
          triggerType: e.triggerType,
        })),
      ];

      // Chronological merge: createdAt DESC.
      items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

      return {
        items: items.slice(0, input.limit),
        total: decisions.length + escalations.length,
      };
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
        tenantId: ctx.tenantId,
        ...(input.decisionId && { decisionId: input.decisionId }),
      };

      const [actions, total] = await Promise.all([
        ctx.prisma.action.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { createdAt: "desc" },
          // KAN-1107 — Contact JOIN for Agent Actions panel; lean select.
          include: {
            contact: {
              select: { firstName: true, lastName: true, email: true, companyName: true },
            },
          },
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
      // KAN-1005 M2-5 — 'info' for sampled post-hoc reviews.
      severity?: "low" | "medium" | "high" | "critical" | "info";
      limit?: number;
      offset?: number;
      // KAN-1005 M2-5 — queue partition (default 'pending' excludes samples).
      kind?: "pending" | "sample" | "all";
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
  // KAN-1140 Phase 3 PR 6 — operator-corrected metadata for
  // parse_confidence_review escalations. Stamp Contact.language /
  // Deal.metadata.leadVendor, then synthetic-republish the original
  // lead.received event so the consumer re-normalizes with the
  // corrected locale + lands the corrections on Engagement/Deal
  // metadata. Loop-guard: synthetic event carries
  // `parseConfidenceOverride: true`.
  reclassifyRecommendation: (
    ctx: {
      prisma: unknown;
      tenantId: string;
      actor: string;
      pubsubClient?: unknown | null;
    },
    input: {
      id: string;
      correctedFormat?: string;
      correctedLanguage?: string;
      correctedVendor?: string;
    },
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
        // KAN-1005 M2-5 — 'info' added for sampled post-hoc reviews.
        severity: z.enum(["low", "medium", "high", "critical", "info"]).optional(),
        limit: z.number().min(1).max(100).default(20),
        offset: z.number().min(0).default(0),
        // KAN-1005 M2-5 — queue partition. Default 'pending' EXCLUDES
        // sampled post-hoc reviews so they never surface as actionable
        // pending approvals. UI opts in to view samples via 'sample'
        // or 'all'.
        kind: z.enum(["pending", "sample", "all"]).default("pending"),
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

  // KAN-1140 Phase 3 PR 6 — operator-corrected metadata path for
  // parse_confidence_review escalations. Stamps corrected language/
  // vendor onto Contact/Deal then republishes the original wire
  // event with `parseConfidenceOverride: true` (loop-guard) so the
  // consumer's existing flow re-normalizes with the corrected
  // locale + lands forensics on Engagement/Deal metadata.
  reclassify: adminProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        correctedFormat: z.string().min(1).max(50).optional(),
        // ISO 639-1 (`en`/`fr`/`es`/...). Tight bound mirrors the
        // wire schema's `language` field (min 2, max 8).
        correctedLanguage: z.string().min(2).max(8).optional(),
        correctedVendor: z.string().min(1).max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { reclassifyRecommendation } = await loadRecsModule();
      const { getPubSubClient } = await loadPubSubLib();
      return reclassifyRecommendation(
        {
          prisma: ctx.prisma,
          tenantId: ctx.tenantId,
          actor: ctx.firebaseUser?.uid ?? "unknown",
          pubsubClient: getPubSubClient(),
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
// COGNITIVE METRICS ROUTER (KAN-1086 — Tier 2 telemetry)
// ============================================================================
// Variable-specifier dynamic import per KAN-689; mirrors loadAuditLogModule.
// Lives in packages/api/src/services/cognitive-metrics-aggregator.ts.
interface CognitiveMetricsModule {
  getAllCognitiveMetrics: (
    prisma: unknown,
    input: {
      tenantId: string | null;
      windowStart: Date;
      windowEnd: Date;
      forceRefresh?: boolean;
      sparklineBucket?: 'hour' | 'day';
    },
  ) => Promise<unknown>;
}
let _cognitiveMetricsModule: CognitiveMetricsModule | null = null;
async function loadCognitiveMetricsModule(): Promise<CognitiveMetricsModule> {
  if (_cognitiveMetricsModule) return _cognitiveMetricsModule;
  const spec = "../../../packages/api/src/services/cognitive-metrics-aggregator.js";
  _cognitiveMetricsModule = (await import(spec)) as CognitiveMetricsModule;
  return _cognitiveMetricsModule;
}

// adminProcedure gate: ADMIN_EMAILS env-var allowlist (see apps/api/src/trpc.ts:116).
// Phase 1 Lock 4: super-admin only — cross-tenant aggregate view is forensic
// observability, not operator-facing UX.
// Phase 1 Lock B (Anchor 5): tenantId is OPTIONAL — null means cross-tenant.
// ============================================================================
// PARSER PATTERNS ROUTER (KAN-1140 Phase 3 PR 7 — new-format discovery)
// ============================================================================
// Variable-specifier dynamic import per KAN-689; mirrors loadAuditLogModule.
// Lives in packages/api/src/services/parse-fingerprint-aggregator.ts.
//
// protectedProcedure gate (Q-ADD-4 lock): operator-grade tenant-scoped
// authority. Fingerprints are per-tenant operational data — every
// operator within a tenant can see THEIR tenant's fingerprints. Distinct
// from cognitiveMetrics (adminProcedure / super-admin only) because that
// surface aggregates cross-tenant; this one strictly does not.
interface ParseFingerprintsModule {
  listParseFingerprints: (
    prisma: unknown,
    input: {
      tenantId: string;
      sortBy: 'lastSeenAt' | 'occurrenceCount' | 'escalationCount';
      limit: number;
      offset: number;
      formatFilter?: string;
      languageFilter?: string;
      vendorFilter?: string;
      showOnlyWithEscalations?: boolean;
      // KAN-1140 PR 8 — capability announcement status filter
      statusFilter?: 'pending' | 'suggested' | 'supported' | 'unsupported';
    },
  ) => Promise<unknown>;
  getParseFingerprintDetail: (
    prisma: unknown,
    input: { tenantId: string; fingerprintId: string },
  ) => Promise<unknown>;
  // KAN-1140 PR 8 — capability announcement mutations
  markFingerprintSupported: (
    prisma: unknown,
    input: { tenantId: string; userId: string; fingerprintId: string },
  ) => Promise<unknown>;
  markFingerprintUnsupported: (
    prisma: unknown,
    input: { tenantId: string; userId: string; fingerprintId: string },
  ) => Promise<unknown>;
  unmarkFingerprint: (
    prisma: unknown,
    input: { tenantId: string; userId: string; fingerprintId: string },
  ) => Promise<unknown>;
}
let _parseFingerprintsModule: ParseFingerprintsModule | null = null;
async function loadParseFingerprintsModule(): Promise<ParseFingerprintsModule> {
  if (_parseFingerprintsModule) return _parseFingerprintsModule;
  const spec = "../../../packages/api/src/services/parse-fingerprint-aggregator.js";
  _parseFingerprintsModule = (await import(spec)) as ParseFingerprintsModule;
  return _parseFingerprintsModule;
}

const parserPatternsRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        sortBy: z.enum(['lastSeenAt', 'occurrenceCount', 'escalationCount']).default('lastSeenAt'),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
        formatFilter: z.string().optional(),
        languageFilter: z.string().optional(),
        vendorFilter: z.string().optional(),
        showOnlyWithEscalations: z.boolean().default(false),
        // KAN-1140 PR 8 — capability announcement status filter for the
        // Settings UI affordance.
        statusFilter: z.enum(['pending', 'suggested', 'supported', 'unsupported']).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listParseFingerprints } = await loadParseFingerprintsModule();
      return listParseFingerprints(ctx.prisma, {
        tenantId: ctx.tenantId,
        ...input,
      });
    }),

  getDetail: protectedProcedure
    .input(z.object({ fingerprintId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { getParseFingerprintDetail } = await loadParseFingerprintsModule();
      return getParseFingerprintDetail(ctx.prisma, {
        tenantId: ctx.tenantId,
        fingerprintId: input.fingerprintId,
      });
    }),

  // KAN-1140 Phase 3 PR 8 — capability announcement mutations.
  //
  // protectedProcedure (tenant-scoped operator authority); ctx.tenantId
  // gates the row + audit log. userId from ctx.firebaseUser?.uid lands
  // on the supported_by column (operator forensic trail).
  //
  // BAD_REQUEST on transitions from a state the mutation can't accept
  // (e.g., mark-as-supported on an already-supported row). NOT_FOUND on
  // wrong tenant OR unknown fingerprintId — minimal info-leak.
  markSupported: protectedProcedure
    .input(z.object({ fingerprintId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { markFingerprintSupported } = await loadParseFingerprintsModule();
      return markFingerprintSupported(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        fingerprintId: input.fingerprintId,
      });
    }),

  markUnsupported: protectedProcedure
    .input(z.object({ fingerprintId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { markFingerprintUnsupported } = await loadParseFingerprintsModule();
      return markFingerprintUnsupported(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        fingerprintId: input.fingerprintId,
      });
    }),

  unmark: protectedProcedure
    .input(z.object({ fingerprintId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { unmarkFingerprint } = await loadParseFingerprintsModule();
      return unmarkFingerprint(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        fingerprintId: input.fingerprintId,
      });
    }),
});

// KAN-1140 Phase 3 PR 9a — Tenant parser customization rule substrate.
//
// Variable-specifier dynamic-import per KAN-689 cohort discipline
// (cross-rootDir static imports trigger TS6059). Mirrors the
// parseFingerprintsModule pattern at line ~1987.
//
// PR 9a ships substrate only — these procedures are unreachable from the
// operator-facing surface (no UI in 9a). PR 9b adds the rule executor;
// PR 9c adds the Settings → Parse Rules sub-tab.
interface ParseRulesModule {
  createParseRule: (
    prisma: unknown,
    input: {
      tenantId: string;
      userId: string;
      label: string;
      body: unknown;
      fingerprintId?: string;
      format?: string;
      vendor?: string;
    },
  ) => Promise<{ id: string }>;
  updateParseRule: (
    prisma: unknown,
    input: {
      tenantId: string;
      userId: string;
      ruleId: string;
      label?: string;
      body?: unknown;
      status?: "pending" | "active" | "disabled";
    },
  ) => Promise<{ id: string }>;
  deleteParseRule: (
    prisma: unknown,
    input: { tenantId: string; userId: string; ruleId: string },
  ) => Promise<{ id: string }>;
  listParseRules: (
    prisma: unknown,
    input: {
      tenantId: string;
      fingerprintId?: string;
      format?: string;
      vendor?: string;
      statusFilter?: "pending" | "active" | "disabled";
      limit?: number;
      offset?: number;
    },
  ) => Promise<unknown>;
  getParseRuleDetail: (
    prisma: unknown,
    input: { tenantId: string; ruleId: string },
  ) => Promise<unknown>;
  restoreParseRulePreviousVersion: (
    prisma: unknown,
    input: { tenantId: string; userId: string; ruleId: string },
  ) => Promise<{ id: string }>;
  // KAN-1140 PR 9c — Status lifecycle + sample testing.
  activateParseRule: (
    prisma: unknown,
    input: { tenantId: string; userId: string; ruleId: string },
  ) => Promise<{ id: string; status: string }>;
  deactivateParseRule: (
    prisma: unknown,
    input: { tenantId: string; userId: string; ruleId: string },
  ) => Promise<{ id: string; status: string }>;
  testRuleAgainstSample: (
    prisma: unknown,
    input: {
      tenantId: string;
      userId: string;
      ruleBody: unknown;
      sampleSource: "stored" | "paste" | "recent";
      sampleId?: string;
      rawBody?: string;
      rawStructured?: Record<string, unknown>;
      fromAddress?: string;
    },
  ) => Promise<{
    output: Record<string, string>;
    metrics: {
      rulesEvaluated: number;
      fieldsWritten: number;
      rulesThrown: number;
      rulesTimedOut: number;
      pipelineBudgetExceeded: boolean;
      totalDurationMs: number;
    };
  }>;
}
let _parseRulesModule: ParseRulesModule | null = null;
async function loadParseRulesModule(): Promise<ParseRulesModule> {
  if (_parseRulesModule) return _parseRulesModule;
  const spec = "../../../packages/api/src/services/parse-rule-service.js";
  _parseRulesModule = (await import(spec)) as ParseRulesModule;
  return _parseRulesModule;
}

const parseRulesRouter = router({
  create: protectedProcedure
    .input(
      z.object({
        label: z.string().min(1).max(100),
        body: ParseRuleBodySchema,
        fingerprintId: z.string().uuid().optional(),
        format: z.string().optional(),
        vendor: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { createParseRule } = await loadParseRulesModule();
      return createParseRule(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        label: input.label,
        body: input.body,
        fingerprintId: input.fingerprintId,
        format: input.format,
        vendor: input.vendor,
      });
    }),

  update: protectedProcedure
    .input(
      z.object({
        ruleId: z.string().uuid(),
        label: z.string().min(1).max(100).optional(),
        body: ParseRuleBodySchema.optional(),
        status: z.enum(["pending", "active", "disabled"]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { updateParseRule } = await loadParseRulesModule();
      return updateParseRule(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        ruleId: input.ruleId,
        label: input.label,
        body: input.body,
        status: input.status,
      });
    }),

  delete: protectedProcedure
    .input(z.object({ ruleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { deleteParseRule } = await loadParseRulesModule();
      return deleteParseRule(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        ruleId: input.ruleId,
      });
    }),

  list: protectedProcedure
    .input(
      z.object({
        fingerprintId: z.string().uuid().optional(),
        format: z.string().optional(),
        vendor: z.string().optional(),
        statusFilter: z.enum(["pending", "active", "disabled"]).optional(),
        limit: z.number().int().min(1).max(100).default(50),
        offset: z.number().int().min(0).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listParseRules } = await loadParseRulesModule();
      return listParseRules(ctx.prisma, {
        tenantId: ctx.tenantId,
        ...input,
      });
    }),

  getDetail: protectedProcedure
    .input(z.object({ ruleId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const { getParseRuleDetail } = await loadParseRulesModule();
      return getParseRuleDetail(ctx.prisma, {
        tenantId: ctx.tenantId,
        ruleId: input.ruleId,
      });
    }),

  restorePreviousVersion: protectedProcedure
    .input(z.object({ ruleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { restoreParseRulePreviousVersion } = await loadParseRulesModule();
      return restoreParseRulePreviousVersion(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        ruleId: input.ruleId,
      });
    }),

  // KAN-1140 PR 9c — Status lifecycle: activate / deactivate.
  // KAN-1158 (P1) empirically verified the runtime budget mechanism in CI
  // before activate shipped; rules with status='active' fire on every
  // matching inbound starting immediately.
  activate: protectedProcedure
    .input(z.object({ ruleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { activateParseRule } = await loadParseRulesModule();
      return activateParseRule(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        ruleId: input.ruleId,
      });
    }),

  deactivate: protectedProcedure
    .input(z.object({ ruleId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { deactivateParseRule } = await loadParseRulesModule();
      return deactivateParseRule(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        ruleId: input.ruleId,
      });
    }),

  // KAN-1140 PR 9c — Sample testing (Q-ADD-TEST-AGAINST-DRAFT lock).
  // Accepts ruleBody as input (form state, not a saved rule). Calls the
  // existing executor (Memo 37 single source of truth); returns
  // ExtractedFields output + execution metrics for the authoring UI.
  testAgainstSample: protectedProcedure
    .input(
      z.object({
        ruleBody: z.unknown(),
        sampleSource: z.enum(["stored", "paste", "recent"]),
        sampleId: z.string().uuid().optional(),
        rawBody: z.string().max(8000).optional(),
        rawStructured: z.record(z.unknown()).optional(),
        fromAddress: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { testRuleAgainstSample } = await loadParseRulesModule();
      return testRuleAgainstSample(ctx.prisma, {
        tenantId: ctx.tenantId,
        userId: ctx.firebaseUser?.uid ?? "unknown",
        ruleBody: input.ruleBody,
        sampleSource: input.sampleSource,
        sampleId: input.sampleId,
        rawBody: input.rawBody,
        rawStructured: input.rawStructured,
        fromAddress: input.fromAddress,
      });
    }),
});

const cognitiveMetricsRouter = router({
  getMetrics: adminProcedure
    .input(
      z.object({
        tenantId: z.string().uuid().nullable(),
        windowStart: z.string().datetime(),
        windowEnd: z.string().datetime(),
        forceRefresh: z.boolean().default(false),
        sparklineBucket: z.enum(['hour', 'day']).default('day'),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { getAllCognitiveMetrics } = await loadCognitiveMetricsModule();
      return getAllCognitiveMetrics(ctx.prisma, {
        tenantId: input.tenantId,
        windowStart: new Date(input.windowStart),
        windowEnd: new Date(input.windowEnd),
        forceRefresh: input.forceRefresh,
        sparklineBucket: input.sparklineBucket,
      });
    }),
});

// ============================================================================
// BRAIN ROUTER
// ============================================================================

const brainRouter = router({
  getSnapshot: protectedProcedure.query(async ({ ctx }) => {
    // Returns aggregated snapshot of the AI brain state
    const [contacts, objectives, actions, escalations] = await Promise.all([
      ctx.prisma.contact.count({ where: { tenantId: ctx.tenantId } }),
      ctx.prisma.objective.count({ where: { tenantId: ctx.tenantId } }),
      ctx.prisma.action.count({ where: { tenantId: ctx.tenantId } }),
      ctx.prisma.escalation.count({
        where: { tenantId: ctx.tenantId, status: "open" },
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

// KAN-962 (slice 2a) — load the proposer via variable-specifier dynamic
// import to keep cross-rootDir modules out of the static graph
// (reference_variable_specifier_dynamic_import).
interface PipelineProposerModule {
  proposeForTenant: (input: {
    prisma: unknown;
    tenantId: string;
    entityScope: "contact" | "order" | "company" | "deal";
  }) => Promise<unknown[]>;
}
let _pipelineProposerModule: PipelineProposerModule | null = null;
async function loadPipelineProposer(): Promise<PipelineProposerModule> {
  if (_pipelineProposerModule) return _pipelineProposerModule;
  const spec = "../../../packages/api/src/services/pipeline-proposer.js";
  _pipelineProposerModule = (await import(spec)) as PipelineProposerModule;
  return _pipelineProposerModule;
}

const ObjectiveEntityScopeSchema = z.enum(["contact", "order", "company", "deal"]);

const objectivesRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        // KAN-962 — optional entityScope filter so the declaration UX
        // can fetch only contact-scoped (or future order-scoped) rows.
        entityScope: ObjectiveEntityScopeSchema.optional(),
        page: z.number().min(1).default(1),
        limit: z.number().min(1).max(100).default(20),
      })
    )
    .query(async ({ ctx, input }) => {
      const skip = (input.page - 1) * input.limit;

      const where: Record<string, unknown> = { tenantId: ctx.tenantId };
      if (input.entityScope) {
        where.entityScope = input.entityScope;
      }

      const [objectives, total] = await Promise.all([
        // KAN-962 — surface type/entityScope/source explicitly so the
        // declaration UX has everything it needs without round-trips.
        (ctx.prisma as any).objective.findMany({
          where,
          skip,
          take: input.limit,
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            tenantId: true,
            name: true,
            type: true,
            entityScope: true,
            source: true,
            successCondition: true,
            subObjectives: true,
            blueprintId: true,
            isActive: true,
            createdAt: true,
            updatedAt: true,
          },
        }),
        (ctx.prisma as any).objective.count({ where }),
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

  // KAN-962 (slice 2a) — propose ranked ProposedPipeline[] for the
  // tenant's catalog at the requested entityScope. Returns deterministic
  // counts + LLM-or-fallback naming/reasoning. Trigger-agnostic — same
  // function powers slice-2b's daily scheduled discovery.
  propose: protectedProcedure
    .input(
      z.object({
        entityScope: ObjectiveEntityScopeSchema,
      })
    )
    .query(async ({ ctx, input }) => {
      const { proposeForTenant } = await loadPipelineProposer();
      const proposals = await proposeForTenant({
        prisma: ctx.prisma,
        tenantId: ctx.tenantId,
        entityScope: input.entityScope,
      });
      return { proposals };
    }),

  // KAN-962 (slice 2a) — write the tenant's declaration to
  // TenantObjectiveSelection. Replace-all per (tenantId, entityScope):
  // every prior selection for the scope is deleted, then new rows
  // inserted. Atomic via $transaction so a partial write can't leave
  // the declaration in a torn state.
  //
  // Validates: every objectiveId belongs to the tenant + matches the
  // requested entityScope (no cross-tenant or cross-scope leakage).
  adopt: protectedProcedure
    .input(
      z.object({
        entityScope: ObjectiveEntityScopeSchema,
        selections: z
          .array(
            z.object({
              objectiveId: z.string().uuid(),
              priority: z.number().int().min(1),
            })
          )
          .min(0),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Validate every objectiveId belongs to this tenant + scope.
      if (input.selections.length > 0) {
        const objectives: Array<{ id: string }> = await (ctx.prisma as any).objective.findMany({
          where: {
            id: { in: input.selections.map((s) => s.objectiveId) },
            tenantId: ctx.tenantId,
            entityScope: input.entityScope,
          },
          select: { id: true },
        });
        const validIds = new Set(objectives.map((o: { id: string }) => o.id));
        const invalidIds = input.selections
          .map((s) => s.objectiveId)
          .filter((id) => !validIds.has(id));
        if (invalidIds.length > 0) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: `objectiveId(s) not in tenant catalog at scope=${input.entityScope}: ${invalidIds.join(", ")}`,
          });
        }
      }

      return (ctx.prisma as any).$transaction(async (tx: any) => {
        // Replace-all semantics: delete every prior selection for this
        // (tenant, entityScope) tuple.
        const deleted = await tx.tenantObjectiveSelection.deleteMany({
          where: { tenantId: ctx.tenantId, entityScope: input.entityScope },
        });

        // Re-insert with user-chosen priorities. createMany skips conflict
        // detection because the deleteMany above cleared the unique-key space.
        let writtenCount = 0;
        if (input.selections.length > 0) {
          const result = await tx.tenantObjectiveSelection.createMany({
            data: input.selections.map((s) => ({
              tenantId: ctx.tenantId,
              objectiveId: s.objectiveId,
              entityScope: input.entityScope,
              priority: s.priority,
              status: "selected",
            })),
          });
          writtenCount = result.count;
        }

        const declaration = await tx.tenantObjectiveSelection.findMany({
          where: { tenantId: ctx.tenantId, entityScope: input.entityScope },
          orderBy: { priority: "asc" },
          include: {
            objective: {
              select: { id: true, type: true, name: true, entityScope: true },
            },
          },
        });

        return {
          replaced: deleted.count,
          written: writtenCount,
          declaration,
        };
      });
    }),

  // KAN-964 (slice 2a PR C) — loop-closer: persist a real Pipeline from a
  // ProposedPipeline shape. Called from the /settings/objectives Phase-B
  // "Create" button on Ready proposals.
  //
  // Idempotent: if a Pipeline already exists at (tenantId, objectiveId,
  // segment), returns it instead of creating a duplicate. Re-accepting the
  // same objective+segment is a no-op (returns the existing row).
  //
  // The catalog `Objective.type` String can hold 8 values (slice-1 seed);
  // `Pipeline.objectiveType` is the legacy 4-value enum. Backward-compat
  // mapping below collapses the broader vocab into the narrower enum so
  // the existing column stays populated. Taxonomy consolidation deferred
  // (per slice-1 audit) — eventual drop of `objectiveType` waits on the
  // `objectiveId` FK being the canonical signal.
  createPipelineFromProposal: protectedProcedure
    .input(
      z.object({
        objectiveId: z.string().uuid(),
        segment: z.enum([
          "new_leads",
          "winback",
          "closed_lost_recovery",
          "cancelled_orders_recovery",
          "inactive_customers_reengagement",
          "other",
        ]),
        proposedName: z.string().min(1).max(100),
        proposedStages: z
          .array(
            z.object({
              name: z.string().min(1).max(50),
              order: z.number().int().min(0),
              isInitial: z.boolean(),
              isTerminal: z.boolean(),
              outcomeType: z.enum(["open", "terminal_won", "terminal_lost"]),
            }),
          )
          .min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // 1. Validate the Objective belongs to this tenant + read its type
      //    (used to derive the legacy objectiveType enum for the Pipeline row).
      const objective: { id: string; type: string; name: string } | null =
        await (ctx.prisma as any).objective?.findFirst({
          where: { id: input.objectiveId, tenantId: ctx.tenantId, isActive: true },
          select: { id: true, type: true, name: true },
        });
      if (!objective) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Objective ${input.objectiveId} not found in tenant catalog or inactive`,
        });
      }

      // 2. Idempotency check — if a Pipeline at (tenantId, objectiveId, segment)
      //    already exists, return it. Re-accepting same proposal is a no-op.
      const existing: any = await (ctx.prisma as any).pipeline?.findFirst({
        where: {
          tenantId: ctx.tenantId,
          objectiveId: input.objectiveId,
          segment: input.segment,
        },
        include: { stages: { orderBy: { order: "asc" } } },
      });
      if (existing) {
        return { created: false, pipeline: existing };
      }

      // 3. Legacy objectiveType mapping. Pipeline.objectiveType is the
      //    pre-slice-1 enum (4 values); the catalog has 8. Map by closest
      //    semantic fit so the column stays populated for back-compat with
      //    every existing reader (pipeline-router, lead-assignment AI tier,
      //    Brain prompt). The canonical signal going forward is objectiveId.
      const legacyObjectiveType = ((): string => {
        switch (objective.type) {
          case "book_appointment":
            return "book_appointment";
          case "sell_online":
          case "recover_failed_payment":
            return "buy_online";
          case "warm_up":
          case "enrich_lead":
          case "reactivate":
            return "warm_up_lead";
          case "retain_customer":
          case "upsell":
            return "send_quote";
          default:
            return "warm_up_lead";
        }
      })();

      // 4. Create Pipeline + nested Stages in a single round-trip. Inherits
      //    KAN-959's bound-objective semantics + KAN-962's segment marker.
      const created: any = await (ctx.prisma as any).pipeline?.create({
        data: {
          tenantId: ctx.tenantId,
          name: input.proposedName,
          description: `${objective.name} pipeline (proposer-generated).`,
          isActive: true,
          order: 0,
          objectiveType: legacyObjectiveType,
          objectiveDescription: objective.name,
          objectiveId: objective.id,
          segment: input.segment,
          stages: {
            create: input.proposedStages.map((s) => ({
              name: s.name,
              order: s.order,
              isInitial: s.isInitial,
              isTerminal: s.isTerminal,
              outcomeType: s.outcomeType,
            })),
          },
        },
        include: { stages: { orderBy: { order: "asc" } } },
      });

      return { created: true, pipeline: created };
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
      ctx.prisma.contact.count({ where: { tenantId: ctx.tenantId } }),
      // KAN-1104 cascade fix: Objective model has no `status` field (verified
      // schema L442-466). Using `isActive: true` as temporary approximation —
      // counts currently-active objectives in tenant catalog. Proper completion
      // semantic (via ContactObjectiveStack or Outcome) tracked at KAN-1105.
      ctx.prisma.objective.count({
        where: { tenantId: ctx.tenantId, isActive: true },
      }),
      ctx.prisma.action.count({
        where: {
          tenantId: ctx.tenantId,
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
      ctx.prisma.escalation.findMany({
        where: { tenantId: ctx.tenantId },
      }),
      ctx.prisma.auditLog.findMany({
        where: {
          tenantId: ctx.tenantId,
          createdAt: {
            gte: new Date(new Date().setHours(0, 0, 0, 0)),
          },
        },
      }),
    ]);

    // KAN-1103 — replaces the pre-KAN-1103 hardcoded `avgResponseTime = 2.5`
    // mock (commented "would use actual data") with the real T1 response-time
    // calculation. Pair definition: per contact, `email_received` paired with
    // the next chronological `email_send`. Window: rolling 7 days. Returns
    // minutes (field renamed `avgResponseTimeMinutes` for explicit unit
    // suffix; no future drift on consumer side). Empty-tenant posture: zero
    // matched pairs → return 0 (honest "no responses happened yet" signal
    // rather than null/NaN sentinel).
    //
    // Semantic note (relative to sibling fields above): `actionsToday` uses
    // `setHours(0,0,0,0)` = calendar today (operator's "what fired today"
    // signal); `avgResponseTimeMinutes` uses rolling 7d (operator's "how
    // fast is the engine responding lately" signal, avoiding weekend step
    // effects). Two different windows for two different operator questions.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentEngagements = await ctx.prisma.engagement.findMany({
      where: {
        tenantId: ctx.tenantId,
        occurredAt: { gte: sevenDaysAgo },
        engagementType: { in: ["email_received", "email_send"] },
      },
      select: { contactId: true, engagementType: true, occurredAt: true },
      orderBy: { occurredAt: "asc" },
    });

    const responseDeltasMin: number[] = [];
    const pendingReceiveByContact = new Map<string, Date>();
    for (const e of recentEngagements) {
      if (e.engagementType === "email_received") {
        pendingReceiveByContact.set(e.contactId, e.occurredAt);
      } else if (e.engagementType === "email_send") {
        const receivedAt = pendingReceiveByContact.get(e.contactId);
        if (receivedAt) {
          const deltaMs = e.occurredAt.getTime() - receivedAt.getTime();
          responseDeltasMin.push(deltaMs / (1000 * 60));
          pendingReceiveByContact.delete(e.contactId);
        }
      }
    }
    const avgResponseTimeMinutes =
      responseDeltasMin.length === 0
        ? 0
        : Math.round(
            (responseDeltasMin.reduce((a, b) => a + b, 0) /
              responseDeltasMin.length) *
              10,
          ) / 10;

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
      avgResponseTimeMinutes,
      escalationRate: Math.round(escalationRate),
      totalEscalations,
    };
  }),

  // KAN-1108 — Focus Contact selection for the Dashboard Sub-objective Gap
  // panel. Selection priority (Phase 1 Q13 lock):
  //   (i)  highest-severity OPEN Escalation (excluding triggerType='sampled')
  //        → contactId; focusReason='escalation'
  //   (ii) fallback: most-recent Decision row → contactId;
  //        focusReason='recent_decision'
  //   (iii) fallback: null (empty panel)
  //
  // Return shape carries the focusReason discriminator so the UI can render
  // operator-honest framing ("In focus because of this escalation" vs
  // "In focus because of recent engine activity"). Sub-objective gap state is
  // a SEPARATE chained call from the client (subObjectives.getStateForContact
  // by contactId returned here) — keeps endpoints orthogonal.
  getFocusContact: protectedProcedure.query(async ({ ctx }) => {
    // (i) Highest-severity OPEN Escalation (excluding sampled post-hoc reviews)
    const escalation = await ctx.prisma.escalation.findFirst({
      where: {
        tenantId: ctx.tenantId,
        status: "open",
        triggerType: { not: "sampled" },
      },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      select: { contactId: true },
    });

    // (ii) Fallback: most-recent Decision row
    let resolvedContactId: string | null = escalation?.contactId ?? null;
    let resolvedReason: "escalation" | "recent_decision" | null = escalation
      ? "escalation"
      : null;
    if (!resolvedContactId) {
      const decision = await ctx.prisma.decision.findFirst({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: "desc" },
        select: { contactId: true },
      });
      if (decision) {
        resolvedContactId = decision.contactId;
        resolvedReason = "recent_decision";
      }
    }

    // (iii) Empty state: no escalations + no decisions → null
    if (!resolvedContactId) return null;

    // Resolve contact + most-recent Decision metadata for the header
    // (currentObjective name + strategy + confidence).
    const [contact, latestDecision] = await Promise.all([
      ctx.prisma.contact.findFirst({
        where: { id: resolvedContactId, tenantId: ctx.tenantId },
        select: {
          firstName: true,
          lastName: true,
          email: true,
          companyName: true,
          currentStageId: true,
        },
      }),
      ctx.prisma.decision.findFirst({
        where: { tenantId: ctx.tenantId, contactId: resolvedContactId },
        orderBy: { createdAt: "desc" },
        select: { strategySelected: true, actionType: true, confidence: true },
      }),
    ]);

    if (!contact) return null;

    let currentStageName: string | null = null;
    if (contact.currentStageId) {
      const stage = await ctx.prisma.stage.findUnique({
        where: { id: contact.currentStageId },
        select: { name: true },
      });
      currentStageName = stage?.name ?? null;
    }

    return {
      contactId: resolvedContactId,
      contact: {
        firstName: contact.firstName,
        lastName: contact.lastName,
        email: contact.email,
        companyName: contact.companyName,
        currentStageName,
      },
      currentObjective: latestDecision
        ? {
            strategy: latestDecision.strategySelected,
            actionType: latestDecision.actionType,
            confidence: latestDecision.confidence,
          }
        : null,
      focusReason: resolvedReason,
    };
  }),

  // KAN-1113 (KAN-1108b) — Brain Layers cognitive-readiness panel. Closes
  // Dashboard v2 epic. Reads canonical BrainSnapshot schema (`packages/db/
  // prisma/schema.prisma:283`) which exposes the 3 JSON columns
  // companyTruth/behavioralModel/outcomeModel — each cognitive layer is a
  // first-class schema artifact, NOT a derived heuristic.
  //
  // Phase 1 + 1.5 locked decisions (Fred + PO 2026-06-06):
  // - Layer 1 Blueprint: boolean Active/Inactive
  // - Layer 2 Company Truth: populated categories / 7 (Zod-declared 7 categories)
  // - Layer 3 Behavioral: behavioralModel JSON top-level populated keys (future-ready)
  // - Layer 4 Outcome: outcomeModel JSON top-level populated keys (architectural consistency)
  // - Overall Score HYBRID: blueprintId IS NULL → empty-state; isActive=false →
  //   Doctrine-gated cap 25; isActive=true → simple average of 4 layers
  // - Polling 5min + window-focus
  // - HARD RULE: NO raw SQL (KAN-1111 banked memo; KAN-1112 prerequisite for raw SQL)
  //
  // Phase 1.5 PROD sniff revealed AxisOne tenant + entire PROD DB have ZERO
  // BrainSnapshot rows + ZERO Blueprint rows. Empty-state branch will fire
  // on day-1 deploy. UI auto-evolves as Blueprint + BrainSnapshot data flows.
  getBrainLayers: protectedProcedure.query(async ({ ctx }) => {
    // KAN-1115 fix-forward — implementation extracted to
    // apps/api/src/services/brain-layers-impl.ts for backend-level testability
    // ahead of KAN-1112 integration-test infrastructure. The placement bug
    // fixed there (gap rule #1 hoist above empty-state early-return) was
    // undetectable by mocked-response-shape sentinels in apps/web tests.
    const { getBrainLayersImpl } = await import('./services/brain-layers-impl.js');
    // PrismaClient type → BrainLayersPrismaSurface (the minimal subset the impl
    // needs); cast preserves Prisma typing at the call site while the impl
    // works against a lightweight interface for testability.
    return getBrainLayersImpl(ctx.prisma as unknown as Parameters<typeof getBrainLayersImpl>[0], ctx.tenantId);
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
  // KAN-932 — Lean nested fetch for Cohort 3 Deal CRUD form dropdowns.
  // Returns active Pipelines with their Stages (id+name+order+isInitial+
  // isTerminal). Separate procedure from `list` (which returns stage IDs
  // only + summary metadata for the pipeline-management UI) to avoid
  // regressing that UI's shape.
  //
  // KAN-1206 — Optional `campaignId` filter. When present, only Pipelines
  // bound to the given Campaign are returned. Drives the post-commit
  // /campaigns/[id] CommittedCampaignView; existing callers omit the input
  // and continue to receive all active tenant Pipelines (back-compat).
  listWithStages: protectedProcedure
    .input(z.object({ campaignId: z.string().uuid().optional() }).optional())
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = {
        tenantId: ctx.tenantId,
        isActive: true,
      };
      if (input?.campaignId) where.campaignId = input.campaignId;

      const pipelines: any[] =
        (await (ctx.prisma as any).pipeline?.findMany({
          where,
          orderBy: [{ order: "asc" }, { createdAt: "asc" }],
          include: {
            stages: {
              orderBy: { order: "asc" },
              select: {
                id: true,
                name: true,
                order: true,
                isInitial: true,
                isTerminal: true,
                // KAN-968 — outcomeType lets the board distinguish won/lost
                // terminal stages for the column-header accent treatment.
                outcomeType: true,
              },
            },
          },
        })) ?? [];

      return pipelines.map((p) => ({
        id: p.id,
        name: p.name,
        description: p.description ?? null,
        // KAN-968 — objectiveId surfaced for the Pipelines board's
        // objective-bound filter (board hides isActive=true pipelines that
        // aren't bound to an Objective row, i.e. the KAN-793 fixture).
        // Nullable: legacy fixtures + pre-slice-2a tenants will have null.
        objectiveId: (p.objectiveId as string | null) ?? null,
        // KAN-1211 — campaignId surfaced for the Pipelines board's filter
        // to recognize chat-flow Pipelines (V3 lock binds them to Campaign
        // instead of Objective; commit-action-plan.ts:344 sets
        // `objectiveId: null` + `campaignId: <campaign-id>` deliberately).
        // Without this, chat-flow Pipelines share the NULL objectiveId
        // shape with the KAN-793 fixture and get silently excluded.
        // See `legacy_filter_predicate_doctrine` memo.
        campaignId: (p.campaignId as string | null) ?? null,
        stages: (p.stages ?? []) as Array<{
          id: string;
          name: string;
          order: number;
          isInitial: boolean;
          isTerminal: boolean;
          outcomeType: "open" | "terminal_won" | "terminal_lost";
        }>,
      }));
    }),

  // List the tenant's pipelines with computed counts (active leads + stages)
  // and the current period's target progress where a Target row exists.
  //
  // KAN-1108 — Dashboard v2 PR 4 extensions:
  //   1. `as any` cast removed (was vestigial KAN-700 cohort pattern; Prisma
  //      types have caught up — verified zero cascade 2026-06-06).
  //   2. NEW `microObjectives` include — Phase 1 Q3 lock: catalog only (names);
  //      per-pipeline completion progress derivation → KAN-1110 follow-up.
  //   3. NEW `pipelineValue` aggregation — Phase 1 Q1: SUM(Deal.value) by
  //      pipelineId; status='open' filter; index-perfect (Deal.@@index([tenantId,
  //      pipelineId]) + @@index([tenantId, status])).
  //   4. NEW `avgConfidence` aggregation — Phase 1 Q2 Path B (Fred 2026-06-06):
  //      AVG(Decision.confidence) via Deal join on contactId; 7d rolling window;
  //      Path B uses Deal.pipelineId (durable; Contact.currentPipelineId is
  //      deprecated per schema L330). B.1 variant: accept duplicates from
  //      multi-deal contacts (AVG normalizes; revisit if smoke shows skew).
  list: protectedProcedure.query(async ({ ctx }) => {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const [pipelines, pipelineValueAggs, avgConfidenceRows] = await Promise.all([
      ctx.prisma.pipeline.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        include: {
          targets: true,
          stages: { select: { id: true } },
          contacts: { select: { id: true } },
          // KAN-1108 Q3 lock — microObjective catalog only (no per-pipeline
          // progress derivation in this PR; KAN-1110 follow-up).
          microObjectives: {
            where: { isActive: true },
            include: {
              microObjective: {
                select: { id: true, name: true, isDefault: true, order: true },
              },
            },
          },
        },
      }),
      // KAN-1108 Q1 — pipelineValue aggregation.
      ctx.prisma.deal.groupBy({
        by: ["pipelineId"],
        where: { tenantId: ctx.tenantId, status: "open", deletedAt: null },
        _sum: { value: true },
      }),
      // KAN-1108 Q2 Path B.1 — avgConfidence via raw SQL (Prisma can't express
      // GROUP BY across a JOIN cleanly). Aggregates last 7d of Decision rows
      // joined to open Deals by tenantId + contactId. Index coverage:
      //   - decisions (tenantId, createdAt) — covers the WHERE filter
      //   - decisions (tenantId, contactId) — covers the JOIN
      //   - deals (tenantId, pipelineId) — covers GROUP BY
      //   - deals (tenantId, contactId) — covers JOIN
      // Result shape: Array<{ pipelineId: string, avg_confidence: number }>.
      ctx.prisma.$queryRaw<Array<{ pipelineId: string; avg_confidence: number }>>`
        SELECT
          deal.pipeline_id AS "pipelineId",
          AVG(d.confidence)::float AS avg_confidence
        FROM decisions d
        JOIN deals deal
          ON d.contact_id = deal.contact_id
          AND deal.tenant_id = d.tenant_id
        WHERE d.tenant_id = ${ctx.tenantId}
          AND d.created_at > ${sevenDaysAgo}
          AND deal.status = 'open'
          AND deal.deleted_at IS NULL
        GROUP BY deal.pipeline_id
      `,
    ]);

    // Build lookup maps keyed by pipelineId.
    const valueByPipeline = new Map<string, number>();
    for (const agg of pipelineValueAggs) {
      if (agg.pipelineId && agg._sum.value != null) {
        valueByPipeline.set(
          agg.pipelineId,
          typeof agg._sum.value === "object" && "toNumber" in agg._sum.value
            ? agg._sum.value.toNumber()
            : Number(agg._sum.value),
        );
      }
    }
    const confidenceByPipeline = new Map<string, number>();
    for (const row of avgConfidenceRows) {
      confidenceByPipeline.set(row.pipelineId, row.avg_confidence);
    }

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
      // KAN-1108 — new aggregations
      pipelineValue: valueByPipeline.get(p.id) ?? 0,
      avgConfidence: confidenceByPipeline.get(p.id) ?? null,
      // KAN-1108 Q3 — microObjective catalog (names only; KAN-1110 progress)
      microObjectives: (p.microObjectives ?? []).map((pmo) => ({
        id: pmo.microObjective.id,
        name: pmo.microObjective.name,
        isDefault: pmo.microObjective.isDefault,
        order: pmo.microObjective.order,
      })),
      targets: (p.targets ?? []).map((t) => ({
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
  //
  // KAN-1167 — `campaignId` is now REQUIRED. Every Pipeline must be owned by
  // a Campaign (use the tenant's Always-On Campaign for non-outcome-bound
  // Pipelines). Closes Q-ADD-PIPELINE-FK-NULLABLE-WINDOW from Phase 1 trace:
  // the schema column stays nullable (KAN-1001 legacy), but the application
  // layer enforces required-ness so no NEW Pipeline can be orphaned.
  create: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(100),
        description: z.string().max(1000).optional().nullable(),
        objectiveType: ObjectiveTypeEnum,
        objectiveDescription: z.string().max(2000).optional().nullable(),
        order: z.number().int().min(0).default(0),
        stages: z.array(StageInputSchema).min(1),
        // KAN-1167 — required FK. tRPC + Zod reject a missing value before the
        // mutation runs. The backfill script (Step 4) ensured every existing
        // tenant has an Always-On Campaign id available to callers.
        campaignId: z.string().uuid({
          message:
            'KAN-1167: campaignId is required. Use the tenant\'s Always-On Campaign id if no outcome-Campaign applies.',
        }),
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
      // KAN-959 — bind new pipelines to an Objective row. Look up the
      // catalog Objective for this tenant matching `type === input.objectiveType`.
      // Backward-compat: if no matching Objective exists (e.g., tenant not yet
      // seeded with catalog rows), Pipeline.objectiveId stays NULL — the
      // legacy `objectiveType` enum + `objectiveDescription` columns still
      // carry the metadata. Acceptance bound: new pipelines persist a
      // non-null objectiveId IFF the catalog exists for the tenant.
      const matchingObjective: { id: string } | null = await (ctx.prisma as any).objective?.findFirst({
        where: { tenantId: ctx.tenantId, type: input.objectiveType, isActive: true },
        select: { id: true },
      });

      // KAN-1167 — verify the supplied Campaign belongs to this tenant before
      // attaching the Pipeline. Prevents cross-tenant Pipeline→Campaign FK
      // attachment via spoofed campaignId in the request.
      const campaign: { id: string } | null = await (ctx.prisma as any).campaign?.findFirst({
        where: { id: input.campaignId, tenantId: ctx.tenantId },
        select: { id: true },
      });
      if (!campaign) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "KAN-1167: Campaign not found in this tenant for the supplied campaignId.",
        });
      }

      const created: any = await (ctx.prisma as any).pipeline?.create({
        data: {
          tenantId: ctx.tenantId,
          name: input.name,
          description: input.description ?? null,
          objectiveType: input.objectiveType,
          objectiveDescription: input.objectiveDescription ?? null,
          // KAN-959 — new column. Null on tenants without the catalog seed.
          objectiveId: matchingObjective?.id ?? null,
          // KAN-1167 — required FK; verified above to belong to this tenant.
          campaignId: input.campaignId,
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

  // KAN-1167 — `campaignId` is intentionally NOT in this update schema. Zod's
  // default behavior strips extra keys, so callers cannot orphan a Pipeline
  // from its Campaign via update. To REASSIGN a Pipeline to a different
  // Campaign (when KAN-1166 PR 5 multi-Pipeline orchestration lands), a
  // dedicated `pipelines.reassignCampaign` procedure will be added — it will
  // verify the destination Campaign belongs to the same tenant and refuse
  // null. Closes Q-ADD-PIPELINE-FK-NULLABLE-WINDOW for the update path.
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
      // KAN-1167 — defensive belt-and-suspenders: if any future maintainer
      // adds campaignId to the update schema and forgets the guard, the
      // explicit "delete" here ensures it never reaches Prisma.
      delete (data as Record<string, unknown>).campaignId;
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

  /**
   * KAN-1169 — Pre-delete inspection query. UI calls this on Delete-button
   * click to drive the ReassignmentModal copy:
   *   - blockReason set → modal shows block-with-reason banner (no destination picker)
   *   - dealCount === 0 + hasStageHistory === false → simple "Delete X?" confirm
   *   - dealCount === 0 + hasStageHistory === true → "Archive X — preserves history"
   *   - dealCount > 0 → reassignment picker over `destinations`
   */
  previewDelete: protectedProcedure
    .input(z.object({ pipelineId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const prisma = ctx.prisma as any;
      const source: { id: string; name: string } | null =
        (await prisma.pipeline?.findFirst({
          where: { id: input.pipelineId, tenantId: ctx.tenantId },
          select: { id: true, name: true },
        })) ?? null;
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }

      const check = await checkPipelineDeletability(
        ctx.prisma,
        ctx.tenantId,
        input.pipelineId,
      );

      // Pull destination candidates (other active pipelines with their initial
      // stage name surfaced) so the modal can render "they'll land at [stage]"
      // per Q2 lock.
      const candidates: Array<{ id: string; name: string; stages: Array<{ id: string; name: string; isInitial: boolean }> }> =
        check.destinationCandidates > 0
          ? await prisma.pipeline.findMany({
              where: { tenantId: ctx.tenantId, isActive: true, id: { not: input.pipelineId } },
              orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
              select: {
                id: true,
                name: true,
                stages: {
                  where: { isInitial: true },
                  select: { id: true, name: true, isInitial: true },
                  take: 1,
                },
              },
            })
          : [];

      return {
        source,
        blockReason: check.blockReason,
        dealCount: check.dealCount,
        hasStageHistory: check.hasStageHistory,
        destinations: candidates
          .map((c) => ({
            id: c.id,
            name: c.name,
            initialStageId: c.stages[0]?.id ?? null,
            initialStageName: c.stages[0]?.name ?? null,
          }))
          // Destinations missing an initial stage can't accept reassigned deals;
          // filter to actionable candidates only.
          .filter((d) => d.initialStageId !== null),
      };
    }),

  /**
   * KAN-1169 — Pipeline delete with reassignment + soft-archive when history
   * exists (Option C — see Phase 2 architectural escalation).
   *
   * Three audit actionTypes distinguish the outcome paths:
   *   - `pipeline.deleted_empty`: hard delete (zero deals + zero history)
   *   - `pipeline.archived_empty`: soft archive (zero deals but has history)
   *   - `pipeline.archived_with_reassign`: deals reassigned + soft archive
   *
   * Hard-block paths (BLOCK before any mutation):
   *   - `last_pipeline`: tenant's only active pipeline
   *   - `default_assignment`: tenant's `defaultAssignmentPipelineId` target
   *
   * Reassignment semantics:
   *   - destination must be isActive=true + same tenant + not source
   *   - destination must have an isInitial=true stage configured
   *   - all source deals land at destination's initial stage with
   *     refreshed enteredStageAt = now() (Q-ADD-DEAL-STAGE-MAPPING lock)
   *   - terminal_won/terminal_lost deals are moved too (Q-ADD-TERMINAL-DEAL-EXCLUSION lock)
   */
  delete: adminProcedure
    .input(
      z.object({
        pipelineId: z.string().uuid(),
        reassignTo: z.string().uuid().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const prisma = ctx.prisma as any;
      const source: { id: string; name: string } | null =
        (await prisma.pipeline?.findFirst({
          where: { id: input.pipelineId, tenantId: ctx.tenantId },
          select: { id: true, name: true },
        })) ?? null;
      if (!source) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Pipeline not found in this tenant" });
      }

      const check = await checkPipelineDeletability(
        ctx.prisma,
        ctx.tenantId,
        input.pipelineId,
      );

      if (check.blockReason === 'last_pipeline') {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot delete "${source.name}" — it's your tenant's only active pipeline. Create another pipeline first.`,
        });
      }
      if (check.blockReason === 'default_assignment') {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: `Cannot delete "${source.name}" — it's the tenant's default-assignment pipeline. Change the default-assignment in Tenant Settings first.`,
        });
      }

      // Non-empty pipeline requires reassignTo (operator must pick destination).
      if (check.dealCount > 0 && !input.reassignTo) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Pipeline "${source.name}" has ${check.dealCount} deals. Provide reassignTo destination.`,
        });
      }

      // Resolve destination + its initial stage if reassigning.
      let dest: { id: string; name: string } | null = null;
      let destInitialStage: { id: string; name: string } | null = null;
      if (input.reassignTo) {
        if (input.reassignTo === input.pipelineId) {
          throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot reassign deals to the pipeline being deleted." });
        }
        dest =
          (await prisma.pipeline?.findFirst({
            where: { id: input.reassignTo, tenantId: ctx.tenantId, isActive: true },
            select: { id: true, name: true },
          })) ?? null;
        if (!dest) {
          throw new TRPCError({ code: "NOT_FOUND", message: "Destination pipeline not found or inactive." });
        }
        destInitialStage =
          (await prisma.stage?.findFirst({
            where: { pipelineId: dest.id, isInitial: true },
            select: { id: true, name: true },
          })) ?? null;
        if (!destInitialStage) {
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: `Destination pipeline "${dest.name}" has no initial stage configured.`,
          });
        }
      }

      // Option C — soft-archive when stage history exists (preserves
      // deal-scoped retrospective audit trail per the audit_log NEVER
      // deleted precedent + DealStageHistory.toStageId Restrict schema intent).
      const shouldArchive = check.hasStageHistory;

      // Atomic transaction (Q4 mandatory): reassign deals (if any) + delete-or-archive
      // pipeline. Either all succeed or all roll back.
      const transactionOps: unknown[] = [];
      if (input.reassignTo && destInitialStage) {
        transactionOps.push(
          prisma.deal.updateMany({
            where: { tenantId: ctx.tenantId, pipelineId: input.pipelineId },
            data: {
              pipelineId: input.reassignTo,
              currentStageId: destInitialStage.id,
              enteredStageAt: new Date(),
            },
          }),
        );
      }
      if (shouldArchive) {
        transactionOps.push(
          prisma.pipeline.update({
            where: { id: input.pipelineId },
            data: { isActive: false },
          }),
        );
      } else {
        transactionOps.push(
          prisma.pipeline.delete({ where: { id: input.pipelineId } }),
        );
      }
      await prisma.$transaction(transactionOps);

      // Audit (best-effort; consistent with parse arc convention — KAN-1150
      // P2 consolidation pressure: this is the 6th inline copy).
      let actionType: string;
      if (!shouldArchive && check.dealCount === 0) {
        actionType = 'pipeline.deleted_empty';
      } else if (shouldArchive && check.dealCount === 0) {
        actionType = 'pipeline.archived_empty';
      } else {
        actionType = 'pipeline.archived_with_reassign';
      }

      // KAN-1168 — Consolidated via shared writeAuditBestEffort helper. KAN-689
      // cohort discipline: variable-specifier dynamic import keeps the helper
      // out of the apps/api rootDir static graph (TS6059 avoidance per
      // feedback_cc_prompt_cross_rootdir_imports_must_be_pattern_conformant).
      // Same pattern KAN-1167 used for campaigns.setGoal.
      const auditHelpersSpec = "../../../packages/api/src/utils/audit-helpers.js";
      const { writeAuditBestEffort } = (await import(auditHelpersSpec)) as {
        writeAuditBestEffort: (
          prisma: unknown,
          params: {
            tenantId: string;
            actor: string;
            actionType: string;
            payload: Record<string, unknown>;
            reasoning?: string;
          },
        ) => Promise<void>;
      };
      await writeAuditBestEffort(ctx.prisma, {
        tenantId: ctx.tenantId,
        actor: ctx.firebaseUser?.uid ?? 'unknown',
        actionType,
        payload: {
          sourceId: source.id,
          sourceLabel: source.name,
          destinationId: dest?.id ?? null,
          destinationLabel: dest?.name ?? null,
          destinationInitialStageId: destInitialStage?.id ?? null,
          destinationInitialStageLabel: destInitialStage?.name ?? null,
          dealCount: check.dealCount,
          hasStageHistory: check.hasStageHistory,
          softArchived: shouldArchive,
        },
      });

      return {
        id: input.pipelineId,
        outcome: actionType,
        dealCount: check.dealCount,
        softArchived: shouldArchive,
      };
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
  //
  // KAN-1140 PR 11 — `isNewLead` per-row derivation via Contact JOIN.
  // Reply = the Contact existed BEFORE this LeadInboxEvent landed.
  // Implementation: JOIN Contact by `createdContactId` (the Contact PK
  // the webhook upserted for this event); compare `Contact.createdAt`
  // vs `LeadInboxEvent.createdAt` with 5s tolerance.
  //
  // Why JOIN on Contact.id (not Contact.email):
  //   1. Contact.email is nullable + non-unique per tenant; multiple
  //      Contacts may share an email
  //   2. `createdContactId` is the exact PK the webhook upserted —
  //      no ambiguity about which Contact row to compare
  //   3. PK JOIN is the most efficient query shape
  //
  // 5s tolerance rationale:
  //   - Webhook flow: upsert Contact → write LeadInboxEvent within
  //     the same handler (~50-200ms typical)
  //   - 5s absorbs DB clock skew, replication lag, process scheduling
  //   - Edge case: Contact created via non-inbox path (CRM import,
  //     lead-API, manual) within 5s of inbound — misclassifies as
  //     new-lead. Low probability + UX-only severity.
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

      // KAN-1140 PR 11: bulk-fetch Contacts referenced by accepted events.
      // Only `status === 'accepted'` rows get a Type badge (Q-ADD-OOO lock);
      // rejected_autoresponder + rejected_* surface via the status column.
      const contactIds = rows
        .filter((r) => r.status === "accepted" && r.createdContactId)
        .map((r) => r.createdContactId as string);
      const contactCreatedAtById = new Map<string, Date>();
      if (contactIds.length > 0) {
        const contacts: Array<{ id: string; createdAt: Date }> =
          (await (ctx.prisma as any).contact?.findMany({
            where: { id: { in: contactIds }, tenantId: ctx.tenantId },
            select: { id: true, createdAt: true },
          })) ?? [];
        for (const c of contacts) {
          contactCreatedAtById.set(c.id, c.createdAt);
        }
      }

      return rows.map((r) => {
        const isNewLead = deriveIsNewLead({
          status: r.status,
          createdContactId: r.createdContactId,
          eventCreatedAt: r.createdAt,
          contactCreatedAt:
            r.createdContactId && contactCreatedAtById.has(r.createdContactId)
              ? (contactCreatedAtById.get(r.createdContactId) as Date)
              : null,
        });
        return {
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
          isNewLead,
        };
      });
    }),

  // KAN-1140 PR 9c — On-demand body fetch for sample testing in the rule
  // authoring UI. NOT included in listRecentEvents wire shape (security:
  // bodyPreview is sensitive; surfaced only when operator explicitly picks
  // a specific event in the Sample Test panel).
  getEventBody: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const event: { id: string; bodyPreview: string | null; fromAddress: string; subject: string | null } | null =
        (await (ctx.prisma as any).leadInboxEvent?.findFirst({
          where: { id: input.id, tenantId: ctx.tenantId },
          select: { id: true, bodyPreview: true, fromAddress: true, subject: true },
        })) ?? null;
      if (!event) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Inbox event not found in tenant scope." });
      }
      return {
        id: event.id,
        bodyPreview: event.bodyPreview,
        fromAddress: event.fromAddress,
        subject: event.subject,
      };
    }),
});

/**
 * KAN-1140 PR 11 — Reply vs new-lead derivation.
 *
 * Pure function (no IO) extracted from `inbox.listRecentEvents` for unit
 * testability. Returns:
 *   - `true`  if the Contact was created within 5s of this LeadInboxEvent
 *             (new lead — Contact was upserted-and-created by this inbound)
 *   - `false` if the Contact predates the event by > 5s
 *             (reply — Contact already existed when this inbound landed)
 *   - `null`  for non-accepted statuses OR when Contact lookup missed
 *             (rejection rows don't get a Type badge; null Contact happens
 *             on data-loss races — defensive null surface)
 *
 * 5s tolerance absorbs DB clock skew + replication lag for the
 * webhook-upserts-Contact-then-writes-LeadInboxEvent flow.
 *
 * Edge case: a Contact created via non-inbox path (CRM import, lead-API,
 * manual) within 5s of an inbound from the same sender would misclassify
 * as new-lead. Low probability + UX-only severity.
 */
export const ISNEWLEAD_TOLERANCE_MS_PR11 = 5_000;
export function deriveIsNewLead(input: {
  status: string;
  createdContactId: string | null;
  eventCreatedAt: Date;
  contactCreatedAt: Date | null;
}): boolean | null {
  if (input.status !== "accepted") return null;
  if (!input.createdContactId) return null;
  if (!input.contactCreatedAt) return null;
  return (
    input.contactCreatedAt.getTime() >=
    input.eventCreatedAt.getTime() - ISNEWLEAD_TOLERANCE_MS_PR11
  );
}

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

// ============================================================================
// USERS ROUTER — KAN-936 (tenant-scoped users list for AsyncSelect picker)
// ============================================================================
//
// Single procedure (users.list). Powers the AsyncSelect User picker in
// Deal + Company forms. Tenant-scoped via ctx.tenantId. Search by name
// OR email (case-insensitive). Limit-bounded — no cursor pagination
// because tenants typically have <100 users.
//
// Inlined here (no separate service file) — single procedure with simple
// prisma query, matches pipelines.listWithStages precedent.
// ─────────────────────────────────────────────
// KAN-997 — Campaign Layer Slice 1: text-to-segment (read-only).
// campaigns.count + campaigns.textToSegment tRPC procedures.
// Module loaded via variable-specifier dynamic import to bypass TS6059
// cross-rootDir (packages/api/src/services lives outside apps/api/src
// rootDir; same pattern as loadDealsModule above).
// ─────────────────────────────────────────────
interface CampaignsRouterModule {
  countAudience: (
    prisma: unknown,
    tenantId: string,
    input: { conditions: unknown },
  ) => Promise<{ count: number; isThin: boolean; historicalValueUsd: number }>;
  textToSegment: (
    prisma: unknown,
    tenantId: string,
    input: { nl: string; todayUtc?: Date },
    llm: unknown,
  ) => Promise<unknown>;
  // KAN-1000 Slice 2 — full campaign proposal (read-only).
  proposeCampaign: (
    prisma: unknown,
    tenantId: string,
    input: { nl: string; todayUtc?: Date },
    llm: unknown,
  ) => Promise<unknown>;
}

// KAN-1001 Campaign Layer Slice 3a — commit & materialize (INERT).
// Lives in packages/api/src/services/campaign-commit.ts; loaded via
// variable-specifier dynamic import (same pattern as the rest of the
// cross-rootDir services).
interface CampaignCommitModule {
  commitCampaign: (
    prisma: unknown,
    tenantId: string,
    input: {
      proposal: unknown;
      edits?: { name?: string; windowStartUtc?: string | null; windowEndUtc?: string | null };
      idempotencyKey: string;
      userId?: string;
    },
    hooks: unknown,
  ) => Promise<{
    alreadyExisted: boolean;
    campaignId: string;
    pipelineId: string;
    stageIds: string[];
    audienceCount: number;
    membershipStatus: 'materialized_sync' | 'deferred_async';
    membershipSnapshotCountSync: number;
  }>;
  archiveCampaign: (
    prisma: unknown,
    tenantId: string,
    input: { campaignId: string; userId?: string },
    hooks: unknown,
  ) => Promise<{ campaignId: string; status: 'archived'; archivedAt: Date }>;
  materializeAudienceSnapshot: (
    prisma: unknown,
    args: { tenantId: string; campaignId: string; conditions: unknown },
  ) => Promise<{
    campaignId: string;
    totalContactsScanned: number;
    totalMembershipInserted: number;
    batchCount: number;
  }>;
}
let _campaignCommitModule: CampaignCommitModule | null = null;
async function loadCampaignCommitModule(): Promise<CampaignCommitModule> {
  if (_campaignCommitModule) return _campaignCommitModule;
  const spec = "../../../packages/api/src/services/campaign-commit.js";
  _campaignCommitModule = (await import(spec)) as CampaignCommitModule;
  return _campaignCommitModule;
}

// KAN-1010 SAE PR5 — campaign-activation service (activate, pause, drip)
interface CampaignActivationModule {
  activateCampaign: (
    prisma: unknown,
    tenantId: string,
    input: { campaignId: string; userId?: string },
    hooks: unknown,
    opts?: { publishesPerSecond?: number },
  ) => Promise<{
    kind: 'activated' | 'already_active' | 'rejected';
    campaignId: string;
    memberCount?: number;
    stackEntriesCreated?: number;
    stackEntriesReactivated?: number;
    dripPublishesPerSecond?: number;
    reason?: string;
    currentStatus?: string;
  }>;
  pauseCampaign: (
    prisma: unknown,
    tenantId: string,
    input: { campaignId: string; userId?: string },
    hooks: unknown,
  ) => Promise<{
    kind: 'paused' | 'already_inactive' | 'rejected';
    campaignId: string;
    stackEntriesPaused?: number;
    currentStatus?: string;
    reason?: string;
  }>;
}
let _campaignActivationModule: CampaignActivationModule | null = null;
async function loadCampaignActivationModule(): Promise<CampaignActivationModule> {
  if (_campaignActivationModule) return _campaignActivationModule;
  const spec = "../../../packages/api/src/services/campaign-activation.js";
  _campaignActivationModule = (await import(spec)) as CampaignActivationModule;
  return _campaignActivationModule;
}

// KAN-1007 SAE PR3 — pubsub-client loader for the durable materialize
// publish path. Variable-specifier dynamic import (same cross-rootDir
// posture as the campaign-commit + audience modules above).
interface PubSubClientModule {
  getPubSubClient: () => {
    publish: (
      topic: string,
      data: Buffer,
      attributes?: Record<string, string>,
    ) => Promise<string>;
  };
}
let _pubsubClientModule: PubSubClientModule | null = null;
async function loadPubSubClientModule(): Promise<PubSubClientModule> {
  if (_pubsubClientModule) return _pubsubClientModule;
  const spec = "../../../packages/api/src/lib/pubsub-client.js";
  _pubsubClientModule = (await import(spec)) as PubSubClientModule;
  return _pubsubClientModule;
}

let _campaignsModule: CampaignsRouterModule | null = null;
async function loadCampaignsModule(): Promise<CampaignsRouterModule> {
  if (_campaignsModule) return _campaignsModule;
  const spec = "../../../packages/api/src/services/audience-router.js";
  _campaignsModule = (await import(spec)) as CampaignsRouterModule;
  return _campaignsModule;
}

// KAN-1183 — campaigns-list loader. Same KAN-689 cohort variable-specifier
// dynamic-import discipline as the audience-router loader above.
interface CampaignsListModule {
  listCampaigns: (
    prisma: unknown,
    tenantId: string,
    input: {
      search?: string;
      status?: string;
      limit: number;
      cursor?: string;
      includeAlwaysOn?: boolean;
    },
  ) => Promise<{
    items: Array<{
      id: string;
      name: string;
      status: string;
      goalType: string | null;
      goalTarget: number | null;
      goalDescription: string | null;
      feasibilityAnalysisKind: string | null;
      achievability: string | null;
      activatedAt: string | null;
      updatedAt: string;
    }>;
    nextCursor: string | null;
    totalCount: number;
  }>;
}
let _campaignsListModule: CampaignsListModule | null = null;
async function loadCampaignsListModule(): Promise<CampaignsListModule> {
  if (_campaignsListModule) return _campaignsListModule;
  const spec = "../../../packages/api/src/services/campaigns-list.js";
  _campaignsListModule = (await import(spec)) as CampaignsListModule;
  return _campaignsListModule;
}

// KAN-1216c — product-variant-service loader. KAN-689 cohort variable-
// specifier dynamic import. Seeds M1 (content-hash dedup) + M2 (price
// inheritance) memos at the resolving service module.
interface ProductVariantServiceModule {
  createVariant: (
    prisma: unknown,
    tenantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ variant: unknown; auditLogId: string; isDedup: boolean }>;
  updateVariant: (
    prisma: unknown,
    tenantId: string,
    variantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ variant: unknown; auditLogId: string }>;
  resolveEffectivePrice: (
    variant: { price: number | null },
    product: { price: number | null },
  ) => number | null;
}
let _productVariantServiceModule: ProductVariantServiceModule | null = null;
async function loadProductVariantServiceModule(): Promise<ProductVariantServiceModule> {
  if (_productVariantServiceModule) return _productVariantServiceModule;
  const spec = "../../../packages/api/src/services/product-variant-service.js";
  _productVariantServiceModule = (await import(spec)) as ProductVariantServiceModule;
  return _productVariantServiceModule;
}

// KAN-1216b — product-service loader. KAN-689 cohort variable-specifier
// dynamic import. Seeds M4 (soft_delete_archive_only_crud_discipline) memo
// at the resolving service module header.
interface ProductServiceModule {
  createProduct: (
    prisma: unknown,
    tenantId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ product: unknown; auditLogId: string }>;
  updateProduct: (
    prisma: unknown,
    tenantId: string,
    productId: string,
    input: unknown,
    actor: string,
    hooks: unknown,
  ) => Promise<{ product: unknown; auditLogId: string }>;
  archiveProduct: (
    prisma: unknown,
    tenantId: string,
    productId: string,
    actor: string,
    hooks: unknown,
  ) => Promise<{ product: unknown; auditLogId: string; alreadyArchived: boolean }>;
}
let _productServiceModule: ProductServiceModule | null = null;
async function loadProductServiceModule(): Promise<ProductServiceModule> {
  if (_productServiceModule) return _productServiceModule;
  const spec = "../../../packages/api/src/services/product-service.js";
  _productServiceModule = (await import(spec)) as ProductServiceModule;
  return _productServiceModule;
}

// KAN-1184 — conversational orchestrator loader. KAN-689 cohort variable-
// specifier dynamic import.
interface ConversationalOrchestratorModule {
  handleChatTurn: (
    prisma: unknown,
    llm: unknown,
    audienceCount: unknown,
    params: {
      campaignId?: string;
      tenantId: string;
      message: string;
      state: unknown;
    },
    todayUtc?: Date,
  ) => Promise<unknown>;
}
let _orchestratorModule: ConversationalOrchestratorModule | null = null;
async function loadConversationalOrchestrator(): Promise<ConversationalOrchestratorModule> {
  if (_orchestratorModule) return _orchestratorModule;
  const spec = "../../../packages/api/src/services/conversational-orchestrator.js";
  _orchestratorModule = (await import(spec)) as ConversationalOrchestratorModule;
  return _orchestratorModule;
}

// KAN-1185 — Action Plan generator loader. KAN-689 cohort variable-specifier
// dynamic import. Operator-initiated dispatch — NOT auto-chained from the
// orchestrator's `all_dimensions_confirmed` turn (Q-ADD-NEW-2 lock).
interface ActionPlanGeneratorModule {
  generateActionPlan: (
    prisma: unknown,
    redis: unknown,
    llm: unknown,
    countAudience: unknown,
    params: {
      campaignId: string;
      tenantId: string;
      todayUtc?: Date;
    },
  ) => Promise<unknown>;
}
let _actionPlanGeneratorModule: ActionPlanGeneratorModule | null = null;
async function loadActionPlanGenerator(): Promise<ActionPlanGeneratorModule> {
  if (_actionPlanGeneratorModule) return _actionPlanGeneratorModule;
  const spec = "../../../packages/api/src/services/action-plan-generator.js";
  _actionPlanGeneratorModule = (await import(spec)) as ActionPlanGeneratorModule;
  return _actionPlanGeneratorModule;
}

// KAN-1186 — Action Plan refiner loader. KAN-689 cohort variable-specifier
// dynamic import. Operator-initiated dispatch — NOT auto-chained from chat
// or from generator (E1 + E6 locks).
interface ActionPlanRefinerModule {
  refineActionPlan: (
    prisma: unknown,
    redis: unknown,
    llm: unknown,
    countAudience: unknown,
    params: {
      campaignId: string;
      tenantId: string;
      refinementMessage: string;
      expectedUpdatedAt?: string;
      todayUtc?: Date;
    },
  ) => Promise<unknown>;
  revertLastRefinement: (
    prisma: unknown,
    params: {
      campaignId: string;
      tenantId: string;
      todayUtc?: Date;
    },
  ) => Promise<unknown>;
}
let _actionPlanRefinerModule: ActionPlanRefinerModule | null = null;
async function loadActionPlanRefiner(): Promise<ActionPlanRefinerModule> {
  if (_actionPlanRefinerModule) return _actionPlanRefinerModule;
  const spec = "../../../packages/api/src/services/action-plan-refiner.js";
  _actionPlanRefinerModule = (await import(spec)) as ActionPlanRefinerModule;
  return _actionPlanRefinerModule;
}

// KAN-1190 — Commit Action Plan loader. KAN-689 cohort variable-specifier
// dynamic import. Sibling to legacy KAN-1001 campaign-commit.ts; preserves
// both surfaces (legacy CampaignProposal vs ActionPlan) per substrate-
// discovery sibling-vs-extend doctrine.
interface CommitActionPlanModule {
  commitActionPlan: (
    prisma: unknown,
    params: {
      campaignId: string;
      tenantId: string;
      expectedUpdatedAt?: string;
      userId?: string;
      todayUtc?: Date;
    },
  ) => Promise<unknown>;
}
let _commitActionPlanModule: CommitActionPlanModule | null = null;
async function loadCommitActionPlanModule(): Promise<CommitActionPlanModule> {
  if (_commitActionPlanModule) return _commitActionPlanModule;
  const spec = "../../../packages/api/src/services/commit-action-plan.js";
  _commitActionPlanModule = (await import(spec)) as CommitActionPlanModule;
  return _commitActionPlanModule;
}

// LLM client wrapper — matches the LLMCompleteFn shape the campaigns
// module expects. Real llm-client imported the same way (variable
// specifier) so the apps/api tsc rootDir doesn't complain.
interface LlmClientModule {
  complete: (input: {
    tenantId: string;
    tier: 'reasoning' | 'cheap';
    systemPrompt?: string;
    userPrompt: string;
    callerTag?: string;
    jsonMode?: boolean;
    maxTokens?: number;
  }) => Promise<{
    text: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    latencyMs: number;
  }>;
}
let _llmModule: LlmClientModule | null = null;
async function loadLlmModule(): Promise<LlmClientModule> {
  if (_llmModule) return _llmModule;
  const spec = "../../../packages/api/src/services/llm-client.js";
  _llmModule = (await import(spec)) as LlmClientModule;
  return _llmModule;
}

const campaignsRouter = router({
  // Direct count — exposed for Slice 2 manual filter builder + future
  // API consumers. Slice 1 UI doesn't call this directly; textToSegment
  // calls it internally after LLM extraction.
  count: protectedProcedure
    .input(
      z.object({
        // Conditions arrive as raw JSON; the service-side schema parse
        // (AudienceConditionsSchema.parse inside countAudience) validates
        // shape. Keeping it z.unknown() here means we don't double-import
        // the AudienceConditions zod schema into the tRPC layer (which
        // would re-introduce the cross-rootDir issue).
        conditions: z.unknown(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { countAudience } = await loadCampaignsModule();
      return countAudience(ctx.prisma, ctx.tenantId, input);
    }),

  // KAN-1183 — Filterable Campaign list for the operator-facing /campaigns
  // page. Mirrors the canonical list shape (companies.list / contacts.list):
  // search + status + cursor + limit, returns CursorPage<CampaignListItem>.
  // Always-On Campaigns are hidden by default (Q-ADD F lock); pass
  // includeAlwaysOn: true to surface them for debugging.
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        // Loose string so the API tolerates legacy values; service-level
        // Prisma rejects anything truly invalid.
        status: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
        includeAlwaysOn: z.boolean().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { listCampaigns } = await loadCampaignsListModule();
      return listCampaigns(ctx.prisma, ctx.tenantId, input);
    }),

  // KAN-1189 — Conversation history read for /campaigns/new?campaignId= restoration.
  //
  // Separate from campaigns.get (H2 lock) to preserve single-Campaign-fetch
  // ergonomics for KAN-1166/1187/1188 consumers; this procedure handles the
  // distinct concern of paginated turn retrieval.
  //
  // Cursor-based pagination matches KAN-1183 list-view doctrine. Default
  // limit 100 (H5 lock) — turns are small payloads; typical conversation
  // arc fits in one round-trip. Cursor preserved for the rare 100+ case.
  //
  // Tenant-scoped via where: { campaignId, campaign: { tenantId } } —
  // never leak cross-tenant conversation data.
  getConversationHistory: protectedProcedure
    .input(
      z.object({
        campaignId: z.string().uuid(),
        cursor: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(100),
      }),
    )
    .query(async ({ ctx, input }) => {
      const turns = await (ctx.prisma as any).campaignConversationTurn.findMany({
        where: {
          campaignId: input.campaignId,
          tenantId: ctx.tenantId,
        },
        select: {
          id: true,
          turnType: true,
          content: true,
          proposalSnapshot: true,
          dataRequest: true,
          dataIngestionEvent: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
        take: input.limit + 1, // one extra for cursor detection
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = turns.length > input.limit;
      const items = hasMore ? turns.slice(0, input.limit) : turns;
      const nextCursor = hasMore ? items[items.length - 1].id : null;
      return { items, nextCursor, totalCount: items.length };
    }),

  // KAN-1166 PR 3 — Campaign read for chat UI (/campaigns/[id]). Tenant-scoped
  // via where: { id, tenantId } — never leak cross-tenant Campaign data.
  // Selects only the fields the chat substrate reads (goal triplet +
  // feasibilityAnalysis + proposedPlan + audience snapshot + lifecycle).
  get: protectedProcedure
    .input(z.object({ campaignId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const campaign = await (ctx.prisma as any).campaign?.findFirst({
        where: { id: input.campaignId, tenantId: ctx.tenantId },
        select: {
          id: true,
          tenantId: true,
          name: true,
          status: true,
          objectiveId: true,
          strategy: true,
          audienceConditions: true,
          audienceMode: true,
          audienceSnapshotCount: true,
          windowStart: true,
          windowEnd: true,
          goalType: true,
          goalTarget: true,
          goalProductId: true,
          goalDescription: true,
          feasibilityAnalysis: true,
          proposedPlan: true,
          committedPlan: true,
          conversationThreadId: true,
          activatedAt: true,
          completedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!campaign) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }
      return campaign;
    }),

  // NL → audience_conditions + count, single round-trip.
  textToSegment: protectedProcedure
    .input(
      z.object({
        nl: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [{ textToSegment }, llmModule] = await Promise.all([
        loadCampaignsModule(),
        loadLlmModule(),
      ]);
      return textToSegment(
        ctx.prisma,
        ctx.tenantId,
        { nl: input.nl },
        llmModule.complete,
      );
    }),

  // KAN-1184 — Conversational orchestrator entry. Multi-turn dialogue;
  // extracts the 4 dimensions (Product / Objectives / Timeline / Audience)
  // in canonical order; persists turns to CampaignConversationTurn.
  // Per Q-ADD C3: Campaign row created on first turn if `campaignId` omitted.
  // Per Q-ADD D / Finding E: campaigns.propose retired; orchestrator calls
  // audience-router substrate functions directly.
  chat: protectedProcedure
    .input(
      z.object({
        campaignId: z.string().uuid().optional(),
        message: z.string().min(1).max(2000),
        // ConversationState parsed via the shared Zod schema downstream
        // (handler imports ConversationStateSchema from @growth/shared).
        state: z.unknown(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [orchestratorMod, llmMod, audienceMod] = await Promise.all([
        loadConversationalOrchestrator(),
        loadLlmModule(),
        loadCampaignsModule(),
      ]);
      return orchestratorMod.handleChatTurn(
        ctx.prisma,
        llmMod.complete,
        audienceMod.countAudience,
        {
          campaignId: input.campaignId,
          tenantId: ctx.tenantId,
          message: input.message,
          state: input.state,
        },
      );
    }),

  // KAN-1185 — Action Plan generator (Campaign Module Reset PR 4).
  //
  // Operator-initiated (Q-ADD-NEW-2 lock — NOT auto-chained from chat
  // `all_dimensions_confirmed` turn): UI surfaces a "Generate Action Plan"
  // affordance once the 4 dimensions are Confirmed. Multi-LLM round-trips
  // (one per Pipeline) can take 5-30s — auto-chain would block chat UX.
  //
  // Layer separation (Q-ADD-NEW-1 lock): generator owns Campaign.proposedPlan;
  // feasibility-analyzer owns Campaign.feasibilityAnalysis. See doctrine
  // comment on persistCampaignFeasibility for the cleanup rationale.
  generateActionPlan: protectedProcedure
    .input(
      z.object({
        campaignId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [generatorMod, llmMod, audienceMod] = await Promise.all([
        loadActionPlanGenerator(),
        loadLlmModule(),
        loadCampaignsModule(),
      ]);
      return generatorMod.generateActionPlan(
        ctx.prisma,
        null, // Redis is optional — generator's FCS call tolerates null
        llmMod.complete,
        audienceMod.countAudience,
        {
          campaignId: input.campaignId,
          tenantId: ctx.tenantId,
        },
      );
    }),

  // KAN-1186 — Action Plan refiner (Campaign Module Reset PR 5).
  //
  // Operator-initiated NL refinement of an existing Campaign.proposedPlan.
  // LLM classifies into ONE of 4 edit-axis families (stage / first_actions /
  // audience / dimension) and dispatches to family-specific handler. E2 lock.
  //
  // Locks honored:
  //   E1   — refiner does NOT regenerate; returns no_plan_to_refine if plan missing
  //   E3   — stage edits validated against STRATEGY_STAGE_BOUNDS
  //   E4   — unconditional gap recompute on every successful refinement
  //   E5   — campaign.action_plan_refined audit row with before/after delta
  //   E6   — ZERO callsites in conversational-orchestrator.ts (separate surface)
  //   E7   — confidence preserved on stage/first-actions/audience edits
  //   NEW-A — reasoning tier ONLY (no cheap-tier fast-path)
  //   NEW-B — optimistic concurrency via Campaign.updatedAt token
  //   NEW-C — no_plan_to_refine variant when proposedPlan IS NULL
  //   NEW-D — dimension-axis edits write Campaign columns + emit separate
  //           audit type campaign.dimension_post_confirm_edit
  refineActionPlan: protectedProcedure
    .input(
      z.object({
        campaignId: z.string().uuid(),
        refinementMessage: z.string().min(1).max(2000),
        /** Optional optimistic concurrency token (NEW-B). */
        expectedUpdatedAt: z.string().datetime().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const [refinerMod, llmMod, audienceMod] = await Promise.all([
        loadActionPlanRefiner(),
        loadLlmModule(),
        loadCampaignsModule(),
      ]);
      return refinerMod.refineActionPlan(
        ctx.prisma,
        null,
        llmMod.complete,
        audienceMod.countAudience,
        {
          campaignId: input.campaignId,
          tenantId: ctx.tenantId,
          refinementMessage: input.refinementMessage,
          expectedUpdatedAt: input.expectedUpdatedAt,
        },
      );
    }),

  // KAN-1186 — Revert last Action Plan refinement (E8 lock).
  //
  // Walks audit_log for the most recent campaign.action_plan_refined row;
  // materializes the `before` snapshot to Campaign.proposedPlan; emits
  // campaign.action_plan_refinement_reverted audit row. NEVER destroys
  // forensic history.
  revertLastActionPlanRefinement: protectedProcedure
    .input(
      z.object({
        campaignId: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const refinerMod = await loadActionPlanRefiner();
      return refinerMod.revertLastRefinement(ctx.prisma, {
        campaignId: input.campaignId,
        tenantId: ctx.tenantId,
      });
    }),

  // KAN-1190 — Commit multi-Pipeline Action Plan (Campaign Module Reset PR 9).
  //
  // Sibling to legacy `commit` procedure above — the input shape diverges
  // fundamentally (proposedPlan column read vs. CampaignProposal payload),
  // so re-wiring the existing surface would erase load-bearing audience-
  // snapshot semantics. The two coexist until KAN-1001's propose-preview
  // consumers retire (none in active surfaces post-KAN-1183 list view).
  //
  // Locks honored:
  //   J1 — distinct procedure name (avoids legacy collision)
  //   J2 — service uses single prisma.$transaction wrapping all writes
  //   J3 — ActionPlanSchema.parse + STRATEGY_STAGE_BOUNDS re-validation
  //        at commit time (defense-in-depth — refiner enforces, commit
  //        re-checks against on-disk state)
  //   J4 — status flips to 'committed' NOT 'active' (preserves KAN-1001
  //        INERT-post-commit doctrine)
  //   J5 — per-Pipeline strategy from ActionPlanPipeline.strategy
  //   J6 — first-actions INERT (KAN-1199 follow-up enqueues execution)
  //   J7 — campaign.action_plan_committed audit type (distinct from legacy
  //        campaign.commit; dual-audit-type discipline)
  //   J8 — idempotent via already_committed discriminated variant
  //   J11 — optimistic concurrency via expectedUpdatedAt token (matches
  //         refiner NEW-B variant shape)
  commitActionPlan: protectedProcedure
    .input(
      z.object({
        campaignId: z.string().uuid(),
        /** Optimistic concurrency token (J11). Caller passes
         *  Campaign.updatedAt observed at commit-button-press time. */
        expectedUpdatedAt: z.string().datetime().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const commitMod = await loadCommitActionPlanModule();
      return commitMod.commitActionPlan(ctx.prisma, {
        campaignId: input.campaignId,
        tenantId: ctx.tenantId,
        expectedUpdatedAt: input.expectedUpdatedAt,
        userId: ctx.firebaseUser?.uid,
      });
    }),

  // KAN-1001 Campaign Layer Slice 3a — commit & materialize (INERT).
  //
  // Persists Campaign + campaign-owned Pipeline + Stages + initial
  // CampaignMembership snapshot. INERT: no ContactObjectiveStack writes,
  // no Decision Engine handoff, no action publishes possible. Slice 3b
  // adds the engine-handoff layer.
  //
  // For audiences > MEMBERSHIP_SYNC_LIMIT (500), the membership snapshot
  // is materialized out-of-band by an in-process fire-and-forget worker
  // (see materializeAsync hook below). This is a documented deviation
  // from a full Pub/Sub subscriber chain; tracked as a 3a follow-up.
  commit: protectedProcedure
    .input(
      z.object({
        // The proposal payload is large + nested; treat as z.unknown()
        // here and re-parse via CampaignProposalSchema inside the
        // service (same pattern as campaigns.count's conditions input).
        proposal: z.unknown(),
        edits: z
          .object({
            name: z.string().min(1).max(200).optional(),
            windowStartUtc: z.string().datetime().nullable().optional(),
            windowEndUtc: z.string().datetime().nullable().optional(),
          })
          .optional(),
        idempotencyKey: z.string().uuid(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // KAN-1007 — only commitCampaign needed at the tRPC layer; the
      // materializeAudienceSnapshot worker now runs inside the
      // /pubsub/campaign-materialize subscriber, invoked by Pub/Sub
      // delivery instead of the previous fire-and-forget call here.
      const { commitCampaign } = await loadCampaignCommitModule();
      // Hooks:
      //   auditLog.writeInTx → tx.auditLog.create (in-tx, atomic rollback)
      //   materializeAsync.kickOff → in-process Promise (fire-and-forget,
      //     never throws to caller; errors land in structured logs)
      const hooks = {
        auditLog: {
          writeInTx: async (
            tx: { auditLog: { create: (args: unknown) => Promise<{ id: string }> } },
            payload: {
              tenantId: string;
              actor: string;
              actionType: string;
              payload: Record<string, unknown>;
              reasoning: string;
            },
          ): Promise<{ id: string }> =>
            tx.auditLog.create({
              data: {
                tenantId: payload.tenantId,
                actor: payload.actor,
                actionType: payload.actionType,
                payload: payload.payload,
                reasoning: payload.reasoning,
              },
            }),
        },
        materializeAsync: {
          kickOff: (a: {
            tenantId: string;
            campaignId: string;
            conditions: unknown;
          }): void => {
            // KAN-1007 SAE PR3 — swapped from in-process fire-and-forget
            // (KAN-1002 in-process worker, fragile to container restart)
            // to durable Pub/Sub publish (folds KAN-1003). The subscriber
            // at /pubsub/campaign-materialize invokes the same
            // materializeAudienceSnapshot() function the in-process worker
            // used; Pub/Sub at-least-once + ack/nack gives the durability
            // the in-process approach lacked. Container restart mid-
            // pagination → Pub/Sub redelivers → skipDuplicates on the
            // CampaignMembership @@unique keeps the snapshot idempotent.
            void (async () => {
              try {
                const { getPubSubClient } = await loadPubSubClientModule();
                const data = Buffer.from(
                  JSON.stringify({
                    tenantId: a.tenantId,
                    campaignId: a.campaignId,
                    conditions: a.conditions,
                  }),
                );
                const messageId = await getPubSubClient().publish(
                  'campaign.materialize',
                  data,
                  {
                    tenantId: a.tenantId,
                    campaignId: a.campaignId,
                  },
                );
                // eslint-disable-next-line no-console
                console.log(
                  JSON.stringify({
                    type: 'campaign_materialize_async',
                    status: 'published',
                    tenantId: a.tenantId,
                    campaignId: a.campaignId,
                    messageId,
                    durableTransport: 'pubsub',
                  }),
                );
              } catch (err: unknown) {
                // eslint-disable-next-line no-console
                console.log(
                  JSON.stringify({
                    type: 'campaign_materialize_async',
                    status: 'publish_failed',
                    tenantId: a.tenantId,
                    campaignId: a.campaignId,
                    error:
                      err instanceof Error ? err.message : String(err),
                  }),
                );
                // Intentionally no rethrow — fire-and-forget contract
                // (kickOff is `: void`). audienceEvaluatedAt stays NULL
                // until materialization completes; PR5's activation gate
                // refuses any campaign with NULL audienceEvaluatedAt, so
                // a lost publish blocks activation rather than firing
                // a partial run.
              }
            })();
          },
        },
      };
      return commitCampaign(
        ctx.prisma,
        ctx.tenantId,
        {
          proposal: input.proposal,
          edits: input.edits,
          idempotencyKey: input.idempotencyKey,
          userId: ctx.firebaseUser?.uid ?? undefined,
        },
        hooks,
      );
    }),

  // KAN-1001 Slice 3a — archive lifecycle transition. Sets status=
  // 'archived' + archivedAt=now. Audit-logged.
  //
  // NOTE: 'paused' is not in the CampaignStatus enum (draft|active|
  // completed|archived). If 3b needs pause/resume, add 'paused' via an
  // additive enum migration; for 3a, archive is the "can be stopped"
  // lever.
  archive: protectedProcedure
    .input(z.object({ campaignId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { archiveCampaign } = await loadCampaignCommitModule();
      const hooks = {
        auditLog: {
          writeInTx: async (
            tx: { auditLog: { create: (args: unknown) => Promise<{ id: string }> } },
            payload: {
              tenantId: string;
              actor: string;
              actionType: string;
              payload: Record<string, unknown>;
              reasoning: string;
            },
          ): Promise<{ id: string }> =>
            tx.auditLog.create({
              data: {
                tenantId: payload.tenantId,
                actor: payload.actor,
                actionType: payload.actionType,
                payload: payload.payload,
                reasoning: payload.reasoning,
              },
            }),
        },
      };
      return archiveCampaign(
        ctx.prisma,
        ctx.tenantId,
        {
          campaignId: input.campaignId,
          userId: ctx.firebaseUser?.uid ?? undefined,
        },
        hooks,
      );
    }),

  // KAN-1010 SAE PR5 — campaigns.activate(): the M1 trigger
  //
  // Flips committed campaign to active, upserts ContactObjectiveStack
  // entries, drip-publishes decision.run per member. Under
  // autoApproveEnabled=false (M1 posture) every eval lands as an
  // Escalation row in the PR2 queue — zero unsupervised sends. PR3's
  // dormant consumer is the canonical gate; PR4's cost cap + dedup
  // stand guard against runaway spend.
  //
  // Preconditions: campaign.status='committed' AND audienceEvaluatedAt
  // IS NOT NULL. Else rejects with a named reason. Idempotent on active.
  activate: protectedProcedure
    .input(z.object({ campaignId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { activateCampaign } = await loadCampaignActivationModule();
      const { getPubSubClient } = await loadPubSubClientModule();
      const hooks = {
        auditLog: {
          writeInTx: async (
            tx: { auditLog: { create: (args: unknown) => Promise<{ id: string }> } },
            payload: {
              tenantId: string;
              actor: string;
              actionType: string;
              payload: Record<string, unknown>;
              reasoning: string;
            },
          ): Promise<{ id: string }> =>
            tx.auditLog.create({
              data: {
                tenantId: payload.tenantId,
                actor: payload.actor,
                actionType: payload.actionType,
                payload: payload.payload,
                reasoning: payload.reasoning,
              },
            }),
        },
        pubsub: {
          publishDecisionRun: async (args: {
            tenantId: string;
            contactId: string;
            campaignId: string;
          }): Promise<string> => {
            const data = Buffer.from(
              JSON.stringify({
                tenantId: args.tenantId,
                contactId: args.contactId,
                campaignId: args.campaignId,
                source: 'activate',
              }),
            );
            return getPubSubClient().publish('decision.run', data, {
              tenantId: args.tenantId,
              campaignId: args.campaignId,
            });
          },
        },
      };
      // Env-tunable drip cap; default 10 pubs/sec from service module.
      const envRate = parseInt(
        process.env.ACTIVATE_DRIP_PUBLISHES_PER_SECOND ?? '',
        10,
      );
      const publishesPerSecond =
        Number.isFinite(envRate) && envRate > 0 ? envRate : undefined;
      return activateCampaign(
        ctx.prisma,
        ctx.tenantId,
        {
          campaignId: input.campaignId,
          userId: ctx.firebaseUser?.uid ?? undefined,
        },
        hooks,
        { publishesPerSecond },
      );
    }),

  // KAN-1010 SAE PR5 — campaigns.pause(): the M1 stop lever
  //
  // Flips active campaign to paused + updateMany stack entries to
  // paused. The PR3 consumer guard fails on stack.status='paused' for
  // every in-flight or redelivered decision.run → no further evals
  // fire. Pub/Sub backlog NOT purged; guard makes queued events inert.
  pause: protectedProcedure
    .input(z.object({ campaignId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { pauseCampaign } = await loadCampaignActivationModule();
      const hooks = {
        auditLog: {
          writeInTx: async (
            tx: { auditLog: { create: (args: unknown) => Promise<{ id: string }> } },
            payload: {
              tenantId: string;
              actor: string;
              actionType: string;
              payload: Record<string, unknown>;
              reasoning: string;
            },
          ): Promise<{ id: string }> =>
            tx.auditLog.create({
              data: {
                tenantId: payload.tenantId,
                actor: payload.actor,
                actionType: payload.actionType,
                payload: payload.payload,
                reasoning: payload.reasoning,
              },
            }),
        },
      };
      return pauseCampaign(
        ctx.prisma,
        ctx.tenantId,
        {
          campaignId: input.campaignId,
          userId: ctx.firebaseUser?.uid ?? undefined,
        },
        hooks,
      );
    }),

  /**
   * KAN-1167 — Campaign-as-Conversation v0.1 outcome-goal entry point.
   *
   * Operator (or feasibility analyzer in PR 2+) supplies the quantified
   * business outcome target for an outcome Campaign:
   *   - goalType: revenue | units | deals | meetings | custom
   *   - goalTarget: numeric target (positive integer)
   *   - goalProductId: optional Product FK
   *   - goalDescription: operator's free-text statement
   *
   * Refuses:
   *   - Always-On Campaigns (intent-less by design — Q1 lock)
   *   - cross-tenant Campaigns (NOT_FOUND for tenant isolation)
   *   - invalid Zod inputs (non-positive goalTarget, missing required pair)
   *
   * Audit: uses the new shared writeAuditBestEffort helper from
   * packages/api/src/utils/audit-helpers.ts (KAN-1168 will migrate the 6
   * existing inline copies to this helper and close KAN-1150).
   */
  setGoal: protectedProcedure
    .input(
      z.object({
        campaignId: z.string().uuid(),
        goalType: z.enum(['revenue', 'units', 'deals', 'meetings', 'custom']),
        goalTarget: z.number().int().positive(),
        goalProductId: z.string().optional().nullable(),
        goalDescription: z.string().min(1).max(2000),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const campaign: { id: string; tenantId: string; isAlwaysOn: boolean } | null =
        await (ctx.prisma as any).campaign?.findUnique({
          where: { id: input.campaignId },
          select: { id: true, tenantId: true, isAlwaysOn: true },
        });
      if (!campaign || campaign.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }
      if (campaign.isAlwaysOn) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "KAN-1167: Cannot set a goal on the Always-On Campaign. Create a new outcome Campaign for outcome targets.",
        });
      }

      const updated = await (ctx.prisma as any).campaign?.update({
        where: { id: input.campaignId },
        data: {
          goalType: input.goalType,
          goalTarget: input.goalTarget,
          goalProductId: input.goalProductId ?? null,
          goalDescription: input.goalDescription,
        },
        select: {
          id: true,
          goalType: true,
          goalTarget: true,
          goalProductId: true,
          goalDescription: true,
        },
      });

      // KAN-1167 / KAN-1168 — audit via the new shared helper (post-commit;
      // best-effort; never fails the mutation). Sequenced AFTER the update
      // so a successful update never gets rolled back by a flaky audit
      // write.
      //
      // KAN-689 cohort — variable-specifier dynamic import keeps the helper
      // out of the apps/api rootDir static graph (TS6059 avoidance per
      // feedback_cc_prompt_cross_rootdir_imports_must_be_pattern_conformant).
      const auditHelpersSpec = "../../../packages/api/src/utils/audit-helpers.js";
      const { writeAuditBestEffort: writeAuditBestEffortShared } =
        (await import(auditHelpersSpec)) as {
          writeAuditBestEffort: (
            prisma: unknown,
            params: {
              tenantId: string;
              actor: string;
              actionType: string;
              payload: Record<string, unknown>;
              reasoning?: string;
            },
          ) => Promise<void>;
        };
      await writeAuditBestEffortShared(ctx.prisma, {
        tenantId: ctx.tenantId,
        actor: ctx.firebaseUser?.uid ?? "unknown",
        actionType: "campaign.goal_set",
        payload: {
          campaignId: input.campaignId,
          goalType: input.goalType,
          goalTarget: input.goalTarget,
          goalProductId: input.goalProductId ?? null,
          // Description retained in-payload — operator's own statement in
          // their own tenant scope; not PII per se. If audit-payload PII
          // posture tightens later, swap to hashed/truncated.
          goalDescription: input.goalDescription,
        },
      });

      return updated;
    }),

  /**
   * KAN-1166 PR 2b — analyzeFeasibility: AI honest counsel on the Campaign's
   * stated outcome goal.
   *
   * Reads Campaign (verifies tenant ownership + goalType/goalTarget set +
   * audienceConditions present). Calls the Feasibility Analyzer (pure
   * compute) → persists result to Campaign.feasibilityAnalysis +
   * .proposedPlan → emits writeAuditBestEffort with prior counsel snapshot
   * for forensic chain (Q5 override-with-logging substrate; Phase 1
   * Decision 4 Refinement 1).
   *
   * Idempotent re-run: overwrite + audit-prior. Last-write-wins on
   * concurrent triggers; both audits preserved.
   *
   * Cold-start path: analyzer returns `cold_start_counsel` (NO LLM call,
   * deterministic template). Sufficient/partial paths: LLM 'reasoning' tier.
   */
  analyzeFeasibility: protectedProcedure
    .input(z.object({ campaignId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const campaign: {
        id: string;
        tenantId: string;
        goalType: string | null;
        goalTarget: number | null;
        goalProductId: string | null;
        goalDescription: string | null;
        audienceConditions: unknown;
        segment: string | null;
        feasibilityAnalysis: unknown;
      } | null = await (ctx.prisma as any).campaign?.findUnique({
        where: { id: input.campaignId },
        select: {
          id: true,
          tenantId: true,
          goalType: true,
          goalTarget: true,
          goalProductId: true,
          goalDescription: true,
          audienceConditions: true,
          feasibilityAnalysis: true,
        },
      });
      if (!campaign || campaign.tenantId !== ctx.tenantId) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Campaign not found" });
      }
      if (
        !campaign.goalType ||
        campaign.goalTarget == null ||
        !campaign.goalDescription
      ) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message:
            "Set the Campaign's outcome goal (goalType + goalTarget + goalDescription) before requesting feasibility counsel. Use campaigns.setGoal first.",
        });
      }

      // KAN-689 cohort — variable-specifier dynamic imports for cross-rootDir
      // (TS6059 avoidance; mirrors kan-1167-foundation.test.ts:34-58 +
      // KAN-1168 audit-helper migration).
      const analyzerSpec = "../../../packages/api/src/services/feasibility-analyzer.js";
      const llmClientSpec = "../../../packages/api/src/services/llm-client.js";
      const auditHelpersSpec = "../../../packages/api/src/utils/audit-helpers.js";

      type AnalyzerModule = {
        analyzeFeasibility: (
          prisma: unknown,
          redis: unknown | null,
          llm: (input: unknown) => Promise<unknown>,
          params: {
            tenantId: string;
            goalShape: { type: string; productId?: string; segmentId?: string; description?: string };
            goalTarget: number;
            goalDescription: string;
            goalWindowDays?: number;
          },
        ) => Promise<unknown>;
        persistCampaignFeasibility: (
          prisma: unknown,
          campaignId: string,
          result: unknown,
        ) => Promise<void>;
      };
      type LlmClientModule = {
        complete: (input: unknown) => Promise<unknown>;
      };
      type AuditHelpersModule = {
        writeAuditBestEffort: (
          prisma: unknown,
          params: {
            tenantId: string;
            actor: string;
            actionType: string;
            payload: Record<string, unknown>;
            reasoning?: string;
          },
        ) => Promise<void>;
      };

      const [analyzerMod, llmMod, auditMod] = await Promise.all([
        import(analyzerSpec) as Promise<AnalyzerModule>,
        import(llmClientSpec) as Promise<LlmClientModule>,
        import(auditHelpersSpec) as Promise<AuditHelpersModule>,
      ]);

      // Build GoalShape from Campaign fields. goalType is the discriminator;
      // other fields slot per-variant per the discriminated union shape in
      // packages/shared/src/feasibility-context-types.ts.
      const goalShape =
        campaign.goalType === "custom"
          ? { type: "custom" as const, description: campaign.goalDescription }
          : campaign.goalType === "units"
            ? {
                type: "units" as const,
                productId: campaign.goalProductId ?? "",
                ...(campaign.segment ? { segmentId: campaign.segment } : {}),
              }
            : {
                type: campaign.goalType as "revenue" | "deals" | "meetings",
                ...(campaign.goalProductId ? { productId: campaign.goalProductId } : {}),
                ...(campaign.segment ? { segmentId: campaign.segment } : {}),
              };

      const result = await analyzerMod.analyzeFeasibility(
        ctx.prisma,
        null, // v0.1: no Redis cache on analyzer; FeasibilityContextService
        //       internal caching covers the heavy historical aggregates
        llmMod.complete,
        {
          tenantId: ctx.tenantId,
          goalShape,
          goalTarget: campaign.goalTarget,
          goalDescription: campaign.goalDescription,
        },
      );

      // Persist BEFORE audit so prior counsel is captured pre-overwrite in
      // the audit payload (Phase 1 Decision 4 Refinement 1 — forensic chain).
      const priorCounsel = campaign.feasibilityAnalysis;
      await analyzerMod.persistCampaignFeasibility(ctx.prisma, campaign.id, result);

      await auditMod.writeAuditBestEffort(ctx.prisma, {
        tenantId: ctx.tenantId,
        actor: ctx.firebaseUser?.uid ?? "unknown",
        actionType: "campaign.feasibility_analyzed",
        payload: {
          campaignId: campaign.id,
          newCounsel: result as Record<string, unknown>,
          priorCounsel: priorCounsel as Record<string, unknown> | null,
        },
        reasoning:
          (result as { kind: string }).kind === "cold_start_counsel"
            ? "cold-start path — deterministic template; no LLM call"
            : (result as { kind: string }).kind === "analyzer_unavailable"
              ? "LLM transient post-retry-exhaustion"
              : "LLM-synthesized counsel (Sonnet 4.6 reasoning tier)",
      });

      return result;
    }),
});

// ─────────────────────────────────────────────────────────────────────────
// KAN-1213 — Product Catalog Module router stub (Slice 1 of KAN-1212 epic).
//
// This slice ships the minimal `list` query as a substrate sanity-check —
// the route exists, is tenant-scoped via protectedProcedure, and returns the
// canonical CursorPage<Product> shape established by KAN-1183 campaigns.list.
//
// # Scope deferral (KAN-1216)
//
// Full CRUD (create / update / archive / scrape-ingest) lands in KAN-1216
// once the schema has stabilized through this slice's first deploy. Inline
// Prisma findMany matches the KAN-1189 getConversationHistory pattern
// (apps/api/src/router.ts:7461-7492) — NO service module yet because the
// shape is read-only + filterless in Slice 1. KAN-1216 hoists to a
// `loadProductsListModule()` loader when query complexity demands it
// (filters, joins, aggregates).
//
// # Tenant scoping
//
// `where: { tenantId: ctx.tenantId }` — never leak cross-tenant catalog data.
// Same posture as campaigns.list / contacts.list / companies.list (canonical
// list-shape convention).
//
// # Archived default-hide (Q-ADD-11 lock from Phase 1)
//
// `archivedAt: null` excludes soft-deleted Products by default. KAN-1216
// adds an `includeArchived: boolean` input mirroring the campaigns.list
// `includeAlwaysOn` discipline.
// ─────────────────────────────────────────────────────────────────────────
// KAN-1216b — AuditLog hook shape (mirrors campaignsRouter.commit:7772+).
interface ProductRouterAuditTx {
  auditLog: { create: (args: unknown) => Promise<{ id: string }> };
}
function buildProductHooks() {
  return {
    auditLog: {
      writeInTx: async (
        tx: ProductRouterAuditTx,
        payload: {
          tenantId: string;
          actor: string;
          actionType: string;
          payload: Record<string, unknown>;
          reasoning: string;
        },
      ): Promise<{ id: string }> =>
        tx.auditLog.create({
          data: {
            tenantId: payload.tenantId,
            actor: payload.actor,
            actionType: payload.actionType,
            payload: payload.payload,
            reasoning: payload.reasoning,
          },
        }),
    },
  };
}

const productsRouter = router({
  // KAN-1213 — list stub (substrate-only landing). Stays inline this PR
  // per KAN-1216b Phase 1 Observation B; sibling .create/.update/.archive
  // adopt the loader pattern.
  // TODO(KAN-1216): migrate `.list` to `loadProductServiceModule().listProducts`
  // for consistency with mutations. Tracked at Slice 2 close.
  list: protectedProcedure
    .input(
      z.object({
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const products = await (ctx.prisma as any).product.findMany({
        where: {
          tenantId: ctx.tenantId,
          archivedAt: null,
        },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1, // one extra for cursor detection
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      });
      const hasMore = products.length > input.limit;
      const items = hasMore ? products.slice(0, input.limit) : products;
      const nextCursor = hasMore ? items[items.length - 1].id : null;
      return { items, nextCursor, totalCount: items.length };
    }),

  // KAN-1216b — Product CRUD mutations. Service layer at
  // packages/api/src/services/product-service.ts (M4 doctrine canonical
  // anchor). Defensive Zod parse runs at service entry (E3 lock).
  create: protectedProcedure
    .input(
      z.object({
        name: z.string().min(1),
        description: z.string().nullable().optional(),
        status: z.enum(["draft", "active", "archived"]).optional(),
        price: z.number().nullable().optional(),
        currency: z.string().length(3).optional(),
        externalUrl: z.string().url().nullable().optional(),
        primaryImageUrl: z.string().url().nullable().optional(),
        customFields: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { createProduct } = await loadProductServiceModule();
      return createProduct(
        ctx.prisma,
        ctx.tenantId,
        input,
        ctx.firebaseUser?.uid ?? "system",
        buildProductHooks(),
      );
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        status: z.enum(["draft", "active", "archived"]).optional(),
        price: z.number().nullable().optional(),
        currency: z.string().length(3).optional(),
        externalUrl: z.string().url().nullable().optional(),
        primaryImageUrl: z.string().url().nullable().optional(),
        customFields: z.record(z.unknown()).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { updateProduct } = await loadProductServiceModule();
      const { id, ...rest } = input;
      return updateProduct(
        ctx.prisma,
        ctx.tenantId,
        id,
        rest,
        ctx.firebaseUser?.uid ?? "system",
        buildProductHooks(),
      );
    }),

  archive: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const { archiveProduct } = await loadProductServiceModule();
      return archiveProduct(
        ctx.prisma,
        ctx.tenantId,
        input.id,
        ctx.firebaseUser?.uid ?? "system",
        buildProductHooks(),
      );
    }),
});

// KAN-1216c — ProductVariant CRUD router. Service layer at
// packages/api/src/services/product-variant-service.ts (M1 + M2 canonical
// anchors). Reuses buildProductHooks() — same AuditLog hook shape as
// product mutations. .archive mutation deferred to KAN-1218 follow-up
// (variant-level archive not in MVP per KAN-1214 schema doctrine).
const productVariantsRouter = router({
  // List variants for a given product. Eager-loads parent for M2 price
  // inheritance resolution at response shaping.
  list: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        limit: z.number().int().min(1).max(200).default(50),
        cursor: z.string().optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      const { resolveEffectivePrice } = await loadProductVariantServiceModule();
      const variants = (await (ctx.prisma as any).productVariant.findMany({
        where: { tenantId: ctx.tenantId, productId: input.productId },
        include: { product: { select: { id: true, price: true } } },
        orderBy: { createdAt: "desc" },
        take: input.limit + 1,
        ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
      })) as Array<{
        id: string;
        price: number | null;
        product: { price: number | null };
      }>;
      const hasMore = variants.length > input.limit;
      const items = (hasMore ? variants.slice(0, input.limit) : variants).map(
        (v) => ({
          ...v,
          effectivePrice: resolveEffectivePrice(v, v.product),
        }),
      );
      const nextCursor = hasMore ? items[items.length - 1].id : null;
      return { items, nextCursor, totalCount: items.length };
    }),

  // Create with content-hash dedup (Path α — idempotent-return on collision).
  create: protectedProcedure
    .input(
      z.object({
        productId: z.string().uuid(),
        attributes: z.record(z.unknown()),
        price: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { createVariant } = await loadProductVariantServiceModule();
      return createVariant(
        ctx.prisma,
        ctx.tenantId,
        input,
        ctx.firebaseUser?.uid ?? "system",
        buildProductHooks(),
      );
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        attributes: z.record(z.unknown()).optional(),
        price: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { updateVariant } = await loadProductVariantServiceModule();
      const { id, ...rest } = input;
      return updateVariant(
        ctx.prisma,
        ctx.tenantId,
        id,
        rest,
        ctx.firebaseUser?.uid ?? "system",
        buildProductHooks(),
      );
    }),
});

const usersRouter = router({
  list: protectedProcedure
    .input(
      z.object({
        search: z.string().optional(),
        limit: z.number().int().min(1).max(200).default(50),
      }),
    )
    .query(async ({ ctx, input }) => {
      const where: Record<string, unknown> = { tenantId: ctx.tenantId };
      if (input.search) {
        where.OR = [
          { name: { contains: input.search, mode: "insensitive" as const } },
          { email: { contains: input.search, mode: "insensitive" as const } },
        ];
      }
      const items = await ctx.prisma.user.findMany({
        where,
        orderBy: [{ name: "asc" }, { email: "asc" }],
        take: input.limit,
        select: { id: true, name: true, email: true },
      });
      return { items };
    }),
});

// ─────────────────────────────────────────────
// KAN-1005 M2-4 — Circuit breaker admin router.
//
// Manual trip + reset + status for the machine-speed auto-pause. All
// mutations adminProcedure — Firebase token + ADMIN_EMAILS allowlist
// (same gate as recommendations + dangerous mutations). Status query
// is admin-only too; tenant-internal Breaker state shouldn't leak to
// non-admins.
//
// Variable-specifier dynamic imports — cross-rootDir per
// reference_variable_specifier_dynamic_import.
// ─────────────────────────────────────────────

interface CircuitBreakerLib {
  evaluateBreakerState: (
    redis: unknown,
    tenantId: string,
  ) => Promise<{
    tripped: boolean;
    scope?: string;
    isGlobal?: boolean;
    reason?: string;
    failClosed?: boolean;
  }>;
  tripBreaker: (
    redis: unknown,
    scope: string,
    target: string,
    ttlSeconds: number,
    reason: string,
  ) => Promise<void>;
  resetBreaker: (
    redis: unknown,
    scope: string,
    target: string,
  ) => Promise<boolean>;
  BREAKER_SCOPE_COST: string;
  BREAKER_SCOPE_RATE: string;
  BREAKER_SCOPE_ERROR: string;
  GLOBAL_TARGET: string;
  COOLDOWN_SECONDS: number;
  secondsUntilUtcMidnight: () => number;
}
let _circuitBreakerLib: CircuitBreakerLib | null = null;
async function loadCircuitBreakerLib(): Promise<CircuitBreakerLib> {
  if (_circuitBreakerLib) return _circuitBreakerLib;
  const spec = "./lib/circuit-breaker.js";
  _circuitBreakerLib = (await import(spec)) as CircuitBreakerLib;
  return _circuitBreakerLib;
}

interface RedisClientLib {
  getRedisClient: () => unknown;
}
let _redisClientLib: RedisClientLib | null = null;
async function loadRedisClientLib(): Promise<RedisClientLib> {
  if (_redisClientLib) return _redisClientLib;
  const spec = "./services/redis-client.js";
  _redisClientLib = (await import(spec)) as RedisClientLib;
  return _redisClientLib;
}

const BreakerScopeSchema = z.enum([
  "breaker_tripped_cost",
  "breaker_tripped_rate",
  "breaker_tripped_error",
]);

const circuitBreakerRouter = router({
  // ── Status: read current breaker state for the requesting tenant ──
  status: adminProcedure.query(async ({ ctx }) => {
    const lib = await loadCircuitBreakerLib();
    const { getRedisClient } = await loadRedisClientLib();
    const state = await lib.evaluateBreakerState(getRedisClient(), ctx.tenantId);
    return state;
  }),

  // ── Manual reset: clear a specific scope for tenant OR global ──
  reset: adminProcedure
    .input(
      z.object({
        scope: BreakerScopeSchema,
        // null/undefined target → tenant-scoped (uses ctx.tenantId).
        // 'global' literal → global breaker (admin-only by definition).
        target: z.enum(["tenant", "global"]).default("tenant"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const lib = await loadCircuitBreakerLib();
      const { getRedisClient } = await loadRedisClientLib();
      const target = input.target === "global" ? lib.GLOBAL_TARGET : ctx.tenantId;
      const wasTripped = await lib.resetBreaker(getRedisClient(), input.scope, target);
      // Audit-log every reset (best-effort).
      void ctx.prisma.auditLog
        .create({
          data: {
            tenantId: target === lib.GLOBAL_TARGET ? "__global__" : ctx.tenantId,
            actor: "circuit_breaker_admin",
            actionType: "circuit_breaker_reset",
            reasoning: `Manual reset by admin user ${ctx.firebaseUser?.email ?? "unknown"}`,
            payload: {
              scope: input.scope,
              target: input.target,
              wasTripped,
              resetByEmail: ctx.firebaseUser?.email,
              resetByUid: ctx.firebaseUser?.uid,
            },
          },
        })
        .catch((err: unknown) => {
          console.warn(
            `[circuit-breaker] audit-emit-reset-failed scope=${input.scope} target=${input.target} err=${(err as Error)?.message ?? String(err)}`,
          );
        });
      return { ok: true, scope: input.scope, target: input.target, wasTripped };
    }),

  // ── Manual trip: ops-controlled trip path (e.g., to pause a tenant
  // during an investigation or to test the breaker without simulating
  // the underlying signal). Global trip is also admin-only.
  trip: adminProcedure
    .input(
      z.object({
        scope: BreakerScopeSchema,
        target: z.enum(["tenant", "global"]).default("tenant"),
        reason: z.string().min(1).max(500),
        // TTL override; defaults per scope (cost = until UTC midnight,
        // rate/error = COOLDOWN_SECONDS).
        ttlSeconds: z.number().int().min(60).max(86400).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const lib = await loadCircuitBreakerLib();
      const { getRedisClient } = await loadRedisClientLib();
      const target = input.target === "global" ? lib.GLOBAL_TARGET : ctx.tenantId;
      const ttl =
        input.ttlSeconds ??
        (input.scope === lib.BREAKER_SCOPE_COST
          ? lib.secondsUntilUtcMidnight()
          : lib.COOLDOWN_SECONDS);
      const reasonAnnotated = `manual_admin_trip: ${input.reason} (by ${ctx.firebaseUser?.email ?? "unknown"})`;
      await lib.tripBreaker(getRedisClient(), input.scope, target, ttl, reasonAnnotated);
      void ctx.prisma.auditLog
        .create({
          data: {
            tenantId: target === lib.GLOBAL_TARGET ? "__global__" : ctx.tenantId,
            actor: "circuit_breaker_admin",
            actionType: "circuit_breaker_tripped",
            reasoning: `Manual admin trip: ${input.reason}`,
            payload: {
              scope: input.scope,
              target: input.target,
              ttlSeconds: ttl,
              trippedByEmail: ctx.firebaseUser?.email,
              trippedByUid: ctx.firebaseUser?.uid,
              source: "manual_admin",
            },
          },
        })
        .catch((err: unknown) => {
          console.warn(
            `[circuit-breaker] audit-emit-manual-trip-failed scope=${input.scope} target=${input.target} err=${(err as Error)?.message ?? String(err)}`,
          );
        });
      return { ok: true, scope: input.scope, target: input.target, ttlSeconds: ttl };
    }),
});

// ─────────────────────────────────────────────────────────────────────
// M3-1c — sub-objectives router (operator UI surface)
// ─────────────────────────────────────────────────────────────────────

interface SubObjectivesModule {
  computeGapState: (
    prisma: unknown,
    tenantId: string,
    contactId: string,
    contact: { currentStageName?: string; nextStageName?: string },
  ) => Promise<import("@growth/shared").SubObjectiveGapState>;
  transitionSubObjectiveState: (
    prisma: unknown,
    tenantId: string,
    actor: string,
    input: {
      contactId: string;
      subObjectiveKey: string;
      toState: "known" | "not_applicable";
      value?: string | number | null;
    },
  ) => Promise<{ ok: true; previousState: string }>;
}
let _subObjectivesModule: SubObjectivesModule | null = null;
async function loadSubObjectivesModule(): Promise<SubObjectivesModule> {
  if (_subObjectivesModule) return _subObjectivesModule;
  const spec = "../../../packages/api/src/services/sub-objective-gap-tracker.js";
  _subObjectivesModule = (await import(spec)) as SubObjectivesModule;
  return _subObjectivesModule;
}

const subObjectivesRouter = router({
  // Read — fetch prioritized gap-state for a contact. UI panel calls
  // this; engine path uses the same fn via the decision-run-push caller.
  // tenantId is enforced via ctx; cross-tenant contact lookups return
  // empty (computeGapState read returns no rows since contact_id doesn't
  // exist within tenant scope).
  getStateForContact: protectedProcedure
    .input(z.object({ contactId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Resolve stage name for hard-trigger detection (same shape the
      // engine-side caller uses in decision-run-push.ts).
      const contact = await ctx.prisma.contact.findFirst({
        where: { id: input.contactId, tenantId: ctx.tenantId },
        select: { currentStageId: true },
      });
      if (!contact) {
        // Cross-tenant or missing → empty state, UI renders empty panel.
        return { prioritizedGaps: [], topCandidate: undefined };
      }
      let currentStageName: string | undefined;
      if (contact.currentStageId) {
        const stage = await ctx.prisma.stage.findUnique({
          where: { id: contact.currentStageId },
          select: { name: true },
        });
        currentStageName = stage?.name ?? undefined;
      }
      const { computeGapState } = await loadSubObjectivesModule();
      return computeGapState(ctx.prisma, ctx.tenantId, input.contactId, {
        ...(currentStageName ? { currentStageName } : {}),
      });
    }),

  // Mutation — operator manual transition (the fallback path; primary
  // fill is engine generation + future extraction/enrichment slices).
  // Cross-tenant rejection enforced server-side via the service's
  // contact-tenant check.
  transitionState: protectedProcedure
    .input(
      z.object({
        contactId: z.string().uuid(),
        subObjectiveKey: z.enum(["timeline", "budget", "authority", "need", "motivation"]),
        toState: z.enum(["known", "not_applicable"]),
        value: z.union([z.string(), z.number(), z.null()]).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { transitionSubObjectiveState } = await loadSubObjectivesModule();
      // M3-1c-followup — prefer email over UID so the audit row + the
      // operator-facing "set by ..." UI render is human-readable. UID
      // fallback for non-email Firebase users; literal "unknown_actor"
      // is the last-resort defensive value.
      const actor =
        ctx.firebaseUser?.email ?? ctx.firebaseUser?.uid ?? "unknown_actor";
      return transitionSubObjectiveState(ctx.prisma, ctx.tenantId, actor, input);
    }),
});

export const appRouter = router({
  contacts: contactsRouter,
  // KAN-883 — CRM read-layer cohort 1 (PR 1 of 3). UI lands in PR 2-3.
  companies: companiesRouter,
  orders: ordersRouter,
  deals: dealsRouter,
  // KAN-936 — users.list powers AsyncSelect User picker in Deal/Company forms
  users: usersRouter,
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
  // KAN-997 — Campaign Layer Slice 1 — text-to-segment (read-only).
  campaigns: campaignsRouter,
  // KAN-1213 — Product Catalog Module substrate (Slice 1 of KAN-1212 epic).
  // List-only stub this slice; KAN-1216 expands to full CRUD.
  products: productsRouter,
  // KAN-1216c — ProductVariant CRUD with content-hash dedup (M1 Path α) +
  // price-inheritance resolution (M2). Variant-level archive deferred per
  // KAN-1214 schema doctrine.
  productVariants: productVariantsRouter,
  // KAN-1005 M2-4 — Circuit breaker admin surface (status/reset/trip).
  circuitBreaker: circuitBreakerRouter,
  // M3-1c — Sub-objective gap-state read + operator manual transition.
  subObjectives: subObjectivesRouter,
  // KAN-1086 — Tier 2 cognitive-quality aggregate metrics (super-admin only).
  cognitiveMetrics: cognitiveMetricsRouter,
  // KAN-1140 Phase 3 PR 7 — parse-fingerprint aggregation (tenant-scoped;
  // every operator sees their own tenant's parser patterns).
  parserPatterns: parserPatternsRouter,
  // KAN-1140 Phase 3 PR 9a — tenant parser customization rule substrate.
  // PR 9a ships substrate only; rules cannot fire until PR 9b's executor
  // lands in lead-normalizer.ts; no operator UI until PR 9c. Procedures
  // exist + are tenant-scoped via protectedProcedure but are unreachable
  // from the operator-facing surface in 9a.
  parseRules: parseRulesRouter,
});

export type AppRouter = typeof appRouter;
