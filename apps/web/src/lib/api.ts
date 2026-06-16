/**
 * growth API client — lightweight fetch wrapper for tRPC HTTP endpoints.
 *
 * The backend exposes tRPC over HTTP at /trpc/*. Queries are GET requests
 * with ?input=JSON, mutations are POST requests with JSON body.
 *
 * Auth (KAN-702 PR B): tenantId is hardcoded to AxisOne-Growth for the
 * pre-launch single-tenant posture; Firebase ID token attached as Bearer when
 * the user is signed in. KAN-714 (Sprint 7) replaces both the hardcoded
 * tenantId and ADMIN_EMAILS env-var with TeamMember-based per-tenant role
 * authority once GoRush onboarding lands.
 */
import { auth } from './firebase';

export const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://growth-api-1086551891973.us-central1.run.app';

// Pre-launch single-tenant. Backend resolves admin via ADM_EMAILS env-var.
// KAN-714 will resolve tenant from authenticated user via TeamMember.
const AXISONE_GROWTH_TENANT_ID = '9ca85088-f65b-4bac-b098-fff742281ede';

export function getTenantId(): string {
  return AXISONE_GROWTH_TENANT_ID;
}

/**
 * Build the auth + tenant headers shared by tRPC and REST callers.
 *
 * @param opts.omitContentType — set true for FormData uploads (the browser
 *   sets `Content-Type: multipart/form-data; boundary=...` automatically;
 *   passing an explicit Content-Type breaks the boundary). Default false
 *   preserves the existing tRPC-JSON behavior.
 */
export async function buildHeaders(
  opts?: { omitContentType?: boolean },
): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    'x-tenant-id': getTenantId(),
  };
  if (!opts?.omitContentType) {
    h['Content-Type'] = 'application/json';
  }
  // Attach Firebase ID token if the user is signed in. Anonymous calls
  // (no current user) hit only public/protected endpoints; admin-gated
  // mutations require a signed-in user whose email matches ADMIN_EMAILS.
  const user = auth.currentUser;
  if (user) {
    const token = await user.getIdToken();
    h.Authorization = `Bearer ${token}`;
  }
  return h;
}

/** Call a tRPC query (GET /trpc/<path>?input=<json>) */
export async function trpcQuery<T = unknown>(
  path: string,
  input?: Record<string, unknown>
): Promise<T> {
  const url = new URL(`${API_BASE}/trpc/${path}`);
  if (input) {
    url.searchParams.set('input', JSON.stringify(input));
  }
  const res = await fetch(url.toString(), { headers: await buildHeaders() });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Query failed: ${path} (${res.status})`);
  }
  const json = await res.json();
  return json.result?.data as T;
}

/** Call a tRPC mutation (POST /trpc/<path> with JSON body).
 *
 *  KAN-944 — Input parameter relaxed from `Record<string, unknown>` to
 *  `object` so typed input interfaces (ContactCreateInput, DealUpdateInput,
 *  etc.) satisfy the constraint without requiring `[key: string]: unknown`
 *  index signatures on every interface. `JSON.stringify` accepts any value;
 *  the `object` constraint just prevents primitives from being passed.
 *  Caught during Batch 1 typecheck — 8 pre-existing errors swept here. */
export async function trpcMutation<T = unknown>(
  path: string,
  input: object
): Promise<T> {
  const res = await fetch(`${API_BASE}/trpc/${path}`, {
    method: 'POST',
    headers: await buildHeaders(),
    body: JSON.stringify(input),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err?.error?.message || `Mutation failed: ${path} (${res.status})`);
  }
  const json = await res.json();
  return json.result?.data as T;
}

/* ── Knowledge Center API helpers ──────────────────────────────── */

// Types matching the Prisma models
export interface CompanyInfo {
  id: string;
  tenantId: string;
  vision: string | null;
  mission: string | null;
  websiteUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Product {
  id: string;
  tenantId: string;
  name: string;
  category: string | null;
  price: string | null;
  description: string | null;
  sku: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyRule {
  id: string;
  tenantId: string;
  category: 'warranty' | 'financing' | 'rule';
  title: string;
  content: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FAQ {
  id: string;
  tenantId: string;
  question: string;
  answer: string;
  sortOrder: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeDocument {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  sizeBytes: number;
  gcsPath: string | null;
  uploadedAt: string;
}

interface Paginated<T> {
  pagination: { page: number; limit: number; total: number; pages: number };
}

// ── Company Info ──
export const knowledgeApi = {
  // Company Info
  getCompanyInfo: () =>
    trpcQuery<CompanyInfo>('knowledge.getCompanyInfo'),

  updateCompanyInfo: (data: { vision?: string; mission?: string; websiteUrl?: string | null }) =>
    trpcMutation<CompanyInfo>('knowledge.updateCompanyInfo', data),

  // Products
  listProducts: (params?: { page?: number; limit?: number; category?: string; search?: string }) =>
    trpcQuery<{ products: Product[] } & Paginated<Product>>('knowledge.listProducts', params || {}),

  createProduct: (data: { name: string; category?: string; price?: string; description?: string; sku?: string }) =>
    trpcMutation<Product>('knowledge.createProduct', data),

  updateProduct: (data: { id: string; name?: string; category?: string; price?: string; description?: string; sku?: string }) =>
    trpcMutation<Product>('knowledge.updateProduct', data),

  deleteProduct: (id: string) =>
    trpcMutation<Product>('knowledge.deleteProduct', { id }),

  // Policies
  listPolicies: (params?: { category?: 'warranty' | 'financing' | 'rule'; page?: number; limit?: number }) =>
    trpcQuery<{ policies: PolicyRule[] } & Paginated<PolicyRule>>('knowledge.listPolicies', params || {}),

  createPolicy: (data: { category: 'warranty' | 'financing' | 'rule'; title: string; content: string; sortOrder?: number }) =>
    trpcMutation<PolicyRule>('knowledge.createPolicy', data),

  updatePolicy: (data: { id: string; category?: 'warranty' | 'financing' | 'rule'; title?: string; content?: string; sortOrder?: number }) =>
    trpcMutation<PolicyRule>('knowledge.updatePolicy', data),

  deletePolicy: (id: string) =>
    trpcMutation<PolicyRule>('knowledge.deletePolicy', { id }),

  // FAQs
  listFAQs: (params?: { page?: number; limit?: number; search?: string }) =>
    trpcQuery<{ faqs: FAQ[] } & Paginated<FAQ>>('knowledge.listFAQs', params || {}),

  createFAQ: (data: { question: string; answer: string; sortOrder?: number }) =>
    trpcMutation<FAQ>('knowledge.createFAQ', data),

  updateFAQ: (data: { id: string; question?: string; answer?: string; sortOrder?: number }) =>
    trpcMutation<FAQ>('knowledge.updateFAQ', data),

  deleteFAQ: (id: string) =>
    trpcMutation<FAQ>('knowledge.deleteFAQ', { id }),

  // Documents
  listDocuments: (params?: { page?: number; limit?: number; type?: string }) =>
    trpcQuery<{ documents: KnowledgeDocument[] } & Paginated<KnowledgeDocument>>('knowledge.listDocuments', params || {}),

  createDocument: (data: { name: string; type: string; sizeBytes?: number; gcsPath?: string }) =>
    trpcMutation<KnowledgeDocument>('knowledge.createDocument', data),

  deleteDocument: (id: string) =>
    trpcMutation<KnowledgeDocument>('knowledge.deleteDocument', { id }),
};

/* ── Settings API helpers ─────────────────────────────────── */

// Types matching backend Prisma models + router return shapes
export interface AIConfig {
  confidenceThreshold: number;
  autoApproveEnabled: boolean;
  dailyActionLimit: number;
  strategyPermissions: Record<string, boolean> | null;
  guardrailSettings: Record<string, boolean> | null;
  aiPermissions: Record<string, unknown> | null;
}

export interface CommunicationChannel {
  id: string;
  tenantId: string;
  type: 'email' | 'sms' | 'whatsapp' | 'messenger';
  provider: string;
  config: Record<string, unknown>;
  status: 'connected' | 'disconnected' | 'error';
  lastTestedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Integration {
  id: string;
  tenantId: string;
  provider: string;
  category: 'crm' | 'payments' | 'calendar' | 'commerce' | 'other';
  status: 'connected' | 'disconnected' | 'syncing' | 'error';
  config: Record<string, unknown>;
  lastSyncAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TeamMember {
  id: string;
  tenantId: string;
  email: string;
  name: string | null;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  firebaseUid: string | null;
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Invitation {
  id: string;
  tenantId: string;
  email: string;
  role: 'owner' | 'admin' | 'agent' | 'viewer';
  status: 'pending' | 'accepted' | 'expired' | 'cancelled';
  invitedBy: string;
  token: string;
  expiresAt: string;
  createdAt: string;
}

export type NotificationPrefs = Record<string, boolean>;

export interface SecuritySetting {
  id: string;
  tenantId: string;
  twoFactorEnabled: boolean;
  ssoEnabled: boolean;
  ssoProvider: string | null;
  ssoConfig: Record<string, unknown>;
  auditRetentionDays: number;
  gdprCompliant: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: string;
  tenantId: string;
  actionType: string;
  actor: string | null;
  payload: Record<string, unknown> | null;
  reasoning: string | null;
  createdAt: string;
}

export const settingsApi = {
  // ── AI Configuration ──
  getAIConfig: () =>
    trpcQuery<AIConfig>('settings.ai.get'),

  updateAIConfig: (data: {
    confidenceThreshold?: number;
    autoApproveEnabled?: boolean;
    dailyActionLimit?: number;
    strategyPermissions?: Record<string, boolean>;
    guardrailSettings?: Record<string, boolean>;
  }) => trpcMutation<AIConfig>('settings.ai.update', data),

  // ── Channels ──
  listChannels: () =>
    trpcQuery<CommunicationChannel[]>('settings.channels.list'),

  updateChannel: (data: {
    type: 'email' | 'sms' | 'whatsapp' | 'messenger';
    provider: string;
    config?: Record<string, unknown>;
    status?: 'connected' | 'disconnected' | 'error';
  }) => trpcMutation<CommunicationChannel>('settings.channels.update', data),

  testChannel: (type: 'email' | 'sms' | 'whatsapp' | 'messenger') =>
    trpcMutation<{ success: boolean; message: string }>('settings.channels.testConnection', { type }),

  // ── Integrations ──
  listIntegrations: () =>
    trpcQuery<Integration[]>('settings.integrations.list'),

  connectIntegration: (data: {
    provider: string;
    category: 'crm' | 'payments' | 'calendar' | 'commerce' | 'other';
    config?: Record<string, unknown>;
  }) => trpcMutation<Integration>('settings.integrations.connect', data),

  disconnectIntegration: (id: string) =>
    trpcMutation<Integration>('settings.integrations.disconnect', { id }),

  syncIntegration: (id: string) =>
    trpcMutation<Integration>('settings.integrations.sync', { id }),

  // ── Team & Roles ──
  listTeam: () =>
    trpcQuery<{ members: TeamMember[]; invitations: Invitation[] }>('settings.team.list'),

  inviteMember: (data: { email: string; role?: 'owner' | 'admin' | 'agent' | 'viewer' }) =>
    trpcMutation<Invitation>('settings.team.invite', data),

  updateMemberRole: (data: { id: string; role: 'owner' | 'admin' | 'agent' | 'viewer' }) =>
    trpcMutation<TeamMember>('settings.team.updateRole', data),

  removeMember: (id: string) =>
    trpcMutation<TeamMember>('settings.team.remove', { id }),

  cancelInvite: (id: string) =>
    trpcMutation<Invitation>('settings.team.cancelInvite', { id }),

  // ── Notifications ──
  getNotifications: () =>
    trpcQuery<NotificationPrefs>('settings.notifications.get'),

  updateNotification: (data: {
    type: 'escalation' | 'daily_digest' | 'weekly_report' | 'brain_update';
    enabled: boolean;
  }) => trpcMutation<NotificationPrefs>('settings.notifications.update', data),

  // ── Security ──
  getSecurity: () =>
    trpcQuery<SecuritySetting>('settings.security.get'),

  updateSecurity: (data: {
    twoFactorEnabled?: boolean;
    ssoEnabled?: boolean;
    ssoProvider?: string | null;
    ssoConfig?: Record<string, unknown>;
    auditRetentionDays?: number;
    gdprCompliant?: boolean;
  }) => trpcMutation<SecuritySetting>('settings.security.update', data),

  getAuditLog: (params?: { page?: number; limit?: number; actionType?: string }) =>
    trpcQuery<{ logs: AuditLogEntry[]; pagination: { page: number; limit: number; total: number; pages: number } }>(
      'settings.security.getAuditLog', params || {}
    ),
};

/* ── Pipelines API (KAN-702 PR B) ──────────────────────────────────
 * Backend: apps/api/src/router.ts (pipelinesRouter, stagesRouter,
 * targetsRouter, knowledgeFiltersRouter, pipelineMicroObjectivesRouter).
 * All mutations are admin-gated via ADMIN_EMAILS env-var (PR A.1/A.2).
 */

// KAN-737 — canonical pipeline/knowledge enums live in @growth/shared. The
// frontend imports them directly at use sites (no re-exports here).
import type {
  ObjectiveType,
  TargetMetric,
  TargetPeriod,
  KnowledgeCategory,
  // KAN-1166 PR 2b — Feasibility Analyzer return contract. Consumed by
  // PR 3 chat UI to render counsel + paths after operator goal-setting.
  FeasibilityCounselResult,
  // KAN-1184 — Conversational orchestrator types.
  ConversationState,
  ChatTurnResult,
  // KAN-1185 — Action Plan generator types (per-pipeline strategy/stages/
  // first-actions output for the post-confirmation UI affordance).
  ActionPlan,
  ActionPlanResult,
  // KAN-1186 — Action Plan refiner types (4-family discriminated edit union +
  // refine/revert discriminated results for the post-generation affordance).
  ActionPlanEdit,
  ActionPlanEditAxis,
  RefineActionPlanResult,
  RevertActionPlanRefinementResult,
  // KAN-1190 — Commit Action Plan types (discriminated commit result +
  // committed-plan snapshot for the ActionPlanCard commit button + success
  // state rendering).
  CommitActionPlanResult,
  CommittedPlanSnapshot,
} from "@growth/shared";
export type {
  ConversationState,
  ChatTurnResult,
  ActionPlan,
  ActionPlanResult,
  ActionPlanEdit,
  ActionPlanEditAxis,
  RefineActionPlanResult,
  RevertActionPlanRefinementResult,
  CommitActionPlanResult,
  CommittedPlanSnapshot,
} from "@growth/shared";
// KAN-826: IngestRequest + IngestStatus removed — legacy KAN-707 ingestion API
// (knowledgeIngestApi) deleted along with the dead /settings/knowledge admin
// route. Sprint 11a KAN-827 will introduce a new ingestion contract; types
// will be re-introduced from @growth/shared at that time.

export interface PipelineStage {
  id?: string;
  name: string;
  order: number;
  isInitial: boolean;
  isTerminal: boolean;
  entryActions?: unknown;
  transitionRules?: unknown;
  autoApproveMatrix?: Record<string, unknown>;
}

export interface PipelineTarget {
  id?: string;
  metric: TargetMetric;
  period: TargetPeriod;
  value: number;
  currentProgress?: number | null;
}

export interface PipelineKnowledgeFilter {
  id?: string;
  knowledgeCategory: KnowledgeCategory;
  includeRule?: Record<string, unknown> | null;
  excludeRule?: Record<string, unknown> | null;
}

export interface PipelineMicroObjectiveAssoc {
  microObjectiveId: string;
  isActive: boolean;
  name?: string;
  description?: string;
  isDefault?: boolean;
}

export interface PipelineSummary {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  order: number;
  objectiveType: ObjectiveType;
  objectiveDescription: string | null;
  stageCount: number;
  activeLeadCount: number;
  // KAN-1108 — Dashboard v2 PR 4 extensions:
  //   pipelineValue: SUM(Deal.value) where status='open' (Phase 1 Q1)
  //   avgConfidence: AVG(Decision.confidence) via Deal join, 7d window
  //                 (Phase 1 Q2 Path B.1; null if no decisions in window)
  //   microObjectives: catalog only (names + structure; per-pipeline progress
  //                    derivation deferred to KAN-1110 follow-up)
  pipelineValue: number;
  avgConfidence: number | null;
  microObjectives: Array<{
    id: string;
    name: string;
    isDefault: boolean;
    order: number;
  }>;
  targets: Array<{
    metric: TargetMetric;
    period: TargetPeriod;
    value: number;
    currentProgress: number | null;
  }>;
}

export interface PipelineDetail extends Omit<PipelineSummary, 'stageCount' | 'activeLeadCount' | 'targets' | 'pipelineValue' | 'avgConfidence' | 'microObjectives'> {
  defaultAutoApproveMatrix: unknown;
  stages: PipelineStage[];
  targets: PipelineTarget[];
  knowledgeFilters: PipelineKnowledgeFilter[];
  microObjectives: PipelineMicroObjectiveAssoc[];
}

export interface MicroObjective {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
}

// KAN-932 / KAN-938 — Pipeline + nested Stage shape for cascading form
// dropdowns. Backend returns active pipelines with stages ordered ASC.
// KAN-968 — added objectiveId so the Pipelines board can filter out the
// objectiveId=null fixture without touching it.
export interface PipelineWithStages {
  id: string;
  name: string;
  description: string | null;
  objectiveId: string | null;
  stages: Array<{
    id: string;
    name: string;
    order: number;
    isInitial: boolean;
    isTerminal: boolean;
    outcomeType: "open" | "terminal_won" | "terminal_lost";
  }>;
}

export const pipelinesApi = {
  list: () => trpcQuery<PipelineSummary[]>('pipelines.list'),

  // KAN-932 — nested stages for cascading picker UX (Deal form first user).
  // KAN-1206 — Optional `campaignId` filter for the post-commit Campaign
  // destination view. When omitted, returns all active tenant Pipelines
  // (back-compat with KAN-932 callers).
  listWithStages: (input?: { campaignId?: string }) =>
    trpcQuery<PipelineWithStages[]>('pipelines.listWithStages', input),

  getById: (id: string) => trpcQuery<PipelineDetail>('pipelines.getById', { id }),

  create: (data: {
    name: string;
    description?: string | null;
    objectiveType: ObjectiveType;
    objectiveDescription?: string | null;
    order?: number;
    stages: PipelineStage[];
  }) => trpcMutation<PipelineDetail>('pipelines.create', data),

  update: (data: {
    id: string;
    name?: string;
    description?: string | null;
    objectiveType?: ObjectiveType;
    objectiveDescription?: string | null;
    order?: number;
  }) => trpcMutation<PipelineDetail>('pipelines.update', data),

  toggleActive: (id: string, isActive: boolean) =>
    trpcMutation<PipelineDetail>('pipelines.toggleActive', { id, isActive }),

  // KAN-1169 — Pre-delete inspection. Drives the ReassignmentModal copy
  // (block path / empty hard-delete / empty soft-archive / reassign).
  previewDelete: (pipelineId: string) =>
    trpcQuery<PipelineDeletePreview>('pipelines.previewDelete', { pipelineId }),

  // KAN-1169 — Signature changed from `(id: string)` to
  // `({ pipelineId, reassignTo? })`. Server returns the chosen outcome path
  // (deleted_empty / archived_empty / archived_with_reassign) so the UI can
  // surface the right toast.
  delete: (input: { pipelineId: string; reassignTo?: string | null }) =>
    trpcMutation<PipelineDeleteResult>('pipelines.delete', input),
};

// KAN-1169 — Preview payload shape; consumed by ReassignmentModal.
export interface PipelineDeletePreview {
  source: { id: string; name: string };
  blockReason: 'last_pipeline' | 'default_assignment' | null;
  dealCount: number;
  hasStageHistory: boolean;
  destinations: Array<{
    id: string;
    name: string;
    initialStageId: string | null;
    initialStageName: string | null;
  }>;
}

export interface PipelineDeleteResult {
  id: string;
  outcome:
    | 'pipeline.deleted_empty'
    | 'pipeline.archived_empty'
    | 'pipeline.archived_with_reassign';
  dealCount: number;
  softArchived: boolean;
}

export const stagesApi = {
  reorder: (pipelineId: string, stageIdsInOrder: string[]) =>
    trpcMutation<{ pipelineId: string; stages: Array<{ id: string; order: number }> }>(
      'stages.reorder',
      { pipelineId, stageIdsInOrder },
    ),
  update: (data: {
    id: string;
    name?: string;
    isInitial?: boolean;
    isTerminal?: boolean;
    entryActions?: unknown;
    transitionRules?: unknown;
    autoApproveMatrix?: unknown;
  }) => trpcMutation<PipelineStage>('stages.update', data),
  delete: (id: string) => trpcMutation<{ id: string }>('stages.delete', { id }),
};

export const targetsApi = {
  upsert: (data: { pipelineId: string; metric: TargetMetric; period: TargetPeriod; value: number }) =>
    trpcMutation<PipelineTarget>('targets.upsert', data),
};

export const knowledgeFiltersApi = {
  upsert: (data: {
    pipelineId: string;
    knowledgeCategory: KnowledgeCategory;
    includeRule?: Record<string, unknown>;
    excludeRule?: Record<string, unknown>;
  }) => trpcMutation<PipelineKnowledgeFilter>('knowledgeFilters.upsert', data),
  delete: (pipelineId: string, knowledgeCategory: KnowledgeCategory) =>
    trpcMutation<{ pipelineId: string; knowledgeCategory: KnowledgeCategory }>(
      'knowledgeFilters.delete',
      { pipelineId, knowledgeCategory },
    ),
};

export const pipelineMicroObjectivesApi = {
  listAvailable: () =>
    trpcQuery<MicroObjective[]>('pipelineMicroObjectives.listAvailable'),
  // Replace-all semantics — caller passes the full set of active IDs.
  setForPipeline: (pipelineId: string, microObjectiveIds: string[]) =>
    trpcMutation<{ pipelineId: string; microObjectiveIds: string[] }>(
      'pipelineMicroObjectives.setForPipeline',
      { pipelineId, microObjectiveIds },
    ),
};

// KAN-963 (slice 2a PR B) — Objective declaration UX API client.
// Mirrors the slice-1+2a backend contract:
//   list({entityScope}) → catalog rows visible to the tenant
//   propose({entityScope}) → ranked ProposedPipeline[] with sufficiency
//   adopt({entityScope, selections}) → replace-all per (tenant, entityScope)

export type ObjectiveEntityScope = 'contact' | 'order' | 'company' | 'deal';

export interface ObjectiveCatalogItem {
  id: string;
  tenantId: string;
  name: string;
  type: string;
  entityScope: ObjectiveEntityScope | null;
  source: 'blueprint_generic' | 'blueprint_industry' | 'ai_proposed_from_data' | 'human_authored' | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ObjectivePipelineSegment =
  | 'new_leads'
  | 'winback'
  | 'closed_lost_recovery'
  | 'cancelled_orders_recovery'
  | 'inactive_customers_reengagement'
  | 'other';

export interface ObjectiveProposedStage {
  name: string;
  order: number;
  isInitial: boolean;
  isTerminal: boolean;
  outcomeType: 'open' | 'terminal_won' | 'terminal_lost';
}

export interface ProposedPipeline {
  objectiveId: string;
  objectiveType: string;
  objectiveName: string;
  segment: ObjectivePipelineSegment;
  dataSufficiency: 'ready' | 'needs_more_data';
  evidence: { count: number; description: string; threshold: number };
  needed: string | null;
  reason: string;
  proposedName: string;
  proposedStages: ObjectiveProposedStage[];
  suggestedPriority: number;
}

export interface ObjectiveDeclaration {
  id: string;
  tenantId: string;
  objectiveId: string;
  entityScope: ObjectiveEntityScope;
  priority: number;
  status: string;
  adoptedAt: string;
  objective: { id: string; type: string; name: string; entityScope: ObjectiveEntityScope };
}

export interface PipelineCreatedFromProposal {
  id: string;
  name: string;
  objectiveId: string | null;
  segment: ObjectivePipelineSegment | null;
  isActive: boolean;
  stages: Array<{ id: string; name: string; order: number; isInitial: boolean; isTerminal: boolean }>;
}

export const objectivesApi = {
  list: (entityScope?: ObjectiveEntityScope) =>
    trpcQuery<{
      objectives: ObjectiveCatalogItem[];
      pagination: { page: number; limit: number; total: number; pages: number };
    }>('objectives.list', entityScope ? { entityScope, page: 1, limit: 100 } : { page: 1, limit: 100 }),
  propose: (entityScope: ObjectiveEntityScope) =>
    trpcQuery<{ proposals: ProposedPipeline[] }>('objectives.propose', { entityScope }),
  adopt: (entityScope: ObjectiveEntityScope, selections: Array<{ objectiveId: string; priority: number }>) =>
    trpcMutation<{
      replaced: number;
      written: number;
      declaration: ObjectiveDeclaration[];
    }>('objectives.adopt', { entityScope, selections }),
  // KAN-964 (slice 2a PR C) — accept a Ready proposed pipeline → persists
  // a real Pipeline bound to the objective at the requested segment.
  // Idempotent on (tenantId, objectiveId, segment) — re-clicking "Create"
  // returns the existing pipeline.
  createPipelineFromProposal: (input: {
    objectiveId: string;
    segment: ObjectivePipelineSegment;
    proposedName: string;
    proposedStages: ObjectiveProposedStage[];
  }) =>
    trpcMutation<{ created: boolean; pipeline: PipelineCreatedFromProposal }>(
      'objectives.createPipelineFromProposal',
      input,
    ),
};

// KAN-826: legacy Knowledge Ingestion API (KAN-707 PR A) types REMOVED.
// `KnowledgeSourceListItem`, `KnowledgeChunkPreview`, `KnowledgeSourceDetail`
// were tied to the dropped KAN-786 schema (chunkIndex/totalChunks/
// embeddingModel etc). KAN-829 will introduce a new admin UI consuming the
// Sprint 11a `knowledge_source` / `knowledge_chunk` schema; types will be
// reshaped at that time.

/* ── Lead Inbox API (KAN-741) ──────────────────────────
 * Per-tenant inbox address management + DKIM strict-mode toggle + recent
 * inbox events query.
 */

export interface InboxAddressInfo {
  slug: string | null;
  address: string | null;
  dkimStrict: boolean;
  domain: string;
}

export interface LeadInboxEventRow {
  id: string;
  inboxAddress: string;
  fromAddress: string;
  subject: string | null;
  status: 'received' | 'rejected_spam' | 'rejected_unverified' | 'rejected_unknown_slug' | 'accepted';
  rejectionReason: string | null;
  spfPass: boolean;
  dkimPass: boolean;
  attachmentCount: number;
  createdContactId: string | null;
  createdAt: string;
  /**
   * KAN-1140 PR 11 — true = first email from this sender (Contact created
   * within 5s of this event); false = reply (Contact predates the inbound
   * by > 5s); null = non-accepted status OR Contact lookup miss. Computed
   * server-side via Contact.createdAt vs LeadInboxEvent.createdAt.
   */
  isNewLead: boolean | null;
}

/* ── Tenant API Keys (KAN-742) ──────────────────────────
 * Lead API key management. Plaintext returned ONCE on create — UI MUST
 * gate the modal dismissal on user acknowledgment + copy-to-clipboard.
 * Server NEVER returns plaintext after creation.
 */

export interface TenantApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export interface TenantApiKeyCreated extends Omit<TenantApiKeySummary, 'lastUsedAt' | 'revokedAt' | 'revokedBy'> {
  /** Plaintext key — shown ONCE in this response. Server never returns it again. */
  plaintext: string;
}

export const tenantApiKeysApi = {
  list: () => trpcQuery<TenantApiKeySummary[]>('tenantApiKeys.list'),
  create: (name: string) => trpcMutation<TenantApiKeyCreated>('tenantApiKeys.create', { name }),
  revoke: (id: string) => trpcMutation<{ id: string; revokedAt: string }>('tenantApiKeys.revoke', { id }),
};

export const inboxApi = {
  getMyInboxAddress: () => trpcQuery<InboxAddressInfo>('inbox.getMyInboxAddress'),
  regenerateSlug: () =>
    trpcMutation<{ slug: string; address: string; domain: string }>('inbox.regenerateSlug', {}),
  setDkimStrict: (strict: boolean) =>
    trpcMutation<{ strict: boolean }>('inbox.setDkimStrict', { strict }),
  listRecentEvents: (input?: { limit?: number; offset?: number; statusFilter?: string }) =>
    trpcQuery<LeadInboxEventRow[]>('inbox.listRecentEvents', input ?? {}),
};

// KAN-826: `knowledgeIngestApi` REMOVED. Legacy KAN-707 admin endpoints in
// router.ts deleted as part of the same PR (Option B dead admin UI cleanup).
// KAN-827 will introduce a new ingestion API surface.

/* ── Recommendations API (KAN-754) ──────────────────────────────────
 * Backend: apps/api/src/router.ts → recommendationsRouter, delegates to
 * packages/api/src/services/recommendations.ts.
 *
 * URL/API name asymmetry intentional: URL stays /escalations (existing IA);
 * tRPC namespace is `recommendations` (the abstraction layer per ticket
 * framing). KAN-756 reconciles if we ever rename the URL.
 *
 * Post-KAN-750 every Escalation row carries decisionId (when scope had a
 * Decision) + context JSONB. UI must handle decisionId=null gracefully —
 * guardrail-block + lead-assignment paths write null.
 */

export interface RecommendationListItem {
  id: string;
  contactId: string;
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    // KAN-1102 — `companyName` projection added so dashboard panels can
    // render "FirstName LastName — Company" without a separate Contact
    // fetch. Backend extension at packages/api/src/services/recommendations.ts.
    companyName: string | null;
  };
  decisionId: string | null;
  severity: string;
  status: string;
  triggerType: string;
  triggerReason: string | null;
  aiSuggestion: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

export interface RecommendationDetail {
  id: string;
  contactId: string;
  contact: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    lifecycleStage: string;
  };
  decisionId: string | null;
  // null when decisionId is null (guardrail-block / lead-assignment paths)
  decision: {
    id: string;
    strategySelected: string;
    actionType: string;
    confidence: number;
    reasoning: string | null;
    metadata: Record<string, unknown>;
    createdAt: string;
  } | null;
  severity: string;
  status: string;
  triggerType: string;
  triggerReason: string | null;
  aiSuggestion: string | null;
  context: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
  // KAN-1037-PR5 — M3-2.5c Trigger context for engine_proposed_action
  // escalations. Server-side derived in `getRecommendationDetail` from
  // the contact's most recent `email_received` engagement. Null for
  // non-engine-proposed escalation types (most queue rows pre-PR4.5).
  triggerInbound: TriggerInbound | null;
  // KAN-1037-PR5 — Originating Decision the engine evaluated, per
  // PR4.5 Phase 1 finding #1. Distinct from `decisionId` above (which
  // is PR4.5's `recentDecision` lookup at create time). Both rendered
  // in the UI for full audit-chain navigation.
  triggerDecisionId: string | null;
}

export interface TriggerInbound {
  id: string;
  bodyPreview: string;
  fromAddress: string;
  subject: string;
  occurredAt: string;
  signalClass: string;
}

export interface SuggestedAction {
  actionType: string;
  channel: string | null;
  payload: Record<string, unknown>;
}

/* ── Observability API (KAN-745 PR B) ──────────────────────────────────
 * Backend: apps/api/src/router.ts → observabilityRouter, delegates to
 * packages/api/src/services/observability/llm-cost-rollup.ts.
 *
 * Admin-only. Surfaces per-tenant LLM cost rollups partitioned by
 * callerTagPrefix (agentic / agentic-tool / message-composer /
 * lead-assignment / recommendation / other). pricingVersion is flattened
 * (SUM across versions) at query time — UI doesn't expose it.
 */

export interface ObservabilityRollupRow {
  hourBucket: string; // ISO timestamp
  callerTagPrefix: string;
  callCount: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
}

export interface ObservabilityCurrentHourSummary {
  hourBucket: string;
  perPrefix: Array<{ callerTagPrefix: string; callCount: number; totalCostUsd: number }>;
  agenticUsd: number;
  nonAgenticUsd: number;
  shadowRatio: number | null;
  breachThreshold: boolean;
}

export const observabilityApi = {
  list: (input: { fromHour: string; toHour: string }) =>
    trpcQuery<ObservabilityRollupRow[]>('observability.list', input),
  currentHour: () =>
    trpcQuery<ObservabilityCurrentHourSummary>('observability.currentHour'),
};

/* ── Audit Log API (KAN-718 Day 10) ──────────────────────────────────
 * Backend: apps/api/src/router.ts → auditLogRouter, delegates to
 * packages/api/src/services/audit-log-router.ts.
 *
 * Default filter excludes brain.blueprint_* infrastructure events. KAN-758
 * (Sprint 5+ Low) adds an admin toggle to show all events.
 */

export interface AuditLogEntry {
  id: string;
  actor: string;
  actionType: string;
  payload: Record<string, unknown>;
  reasoning: string | null;
  createdAt: string;
}

export const auditLogApi = {
  list: (input?: {
    includeInfrastructure?: boolean;
    actionTypePrefix?: string;
    limit?: number;
    offset?: number;
  }) =>
    trpcQuery<{
      items: AuditLogEntry[];
      total: number;
      limit: number;
      offset: number;
      includeInfrastructure: boolean;
    }>('auditLog.list', input ?? {}),
  getById: (id: string) =>
    trpcQuery<AuditLogEntry>('auditLog.getById', { id }),
};

/* ── Dashboard API (KAN-1103) ───────────────────────────────────────
 * Backend: apps/api/src/router.ts:2191 → dashboardRouter.getStats.
 * Aggregate tenant-scoped operator KPIs (contacts, objectives, actions,
 * avg response time, escalation rate).
 *
 * `avgResponseTimeMinutes` field renamed from pre-KAN-1103 `avgResponseTime`
 * — explicit unit suffix prevents future drift. Computed from `email_received
 *  → next email_send same contact` engagement timestamp deltas, rolling 7d
 * window (vs `actionsToday` which uses calendar-today semantics; see
 * router.ts comment for the per-field window rationale).
 * ─────────────────────────────────────────────────────────────────────── */
export interface DashboardStats {
  contacts: number;
  objectivesCompleted: number;
  actionsToday: number;
  avgResponseTimeMinutes: number;
  escalationRate: number;
  totalEscalations: number;
}

/* ── Focus Contact (KAN-1108) ──────────────────────────────────────
 * Backend: apps/api/src/router.ts → dashboardRouter.getFocusContact.
 * Selection priority (Phase 1 Q13 lock):
 *   (i)  highest-severity OPEN Escalation (excluding sampled) → contactId
 *   (ii) fallback: most-recent Decision → contactId
 *   (iii) fallback: null (empty panel)
 *
 * `focusReason` discriminates between the two non-null paths so the UI can
 * frame the focus differently ("In focus due to escalation" vs "In focus due
 * to recent engine activity").
 *
 * Sub-objective gap state is fetched via a SEPARATE chained call from the
 * client (subObjectivesApi.getStateForContact by contactId) — keeps endpoints
 * orthogonal.
 * ─────────────────────────────────────────────────────────────────────── */
export interface FocusContact {
  contactId: string;
  contact: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    companyName: string | null;
    currentStageName: string | null;
  };
  currentObjective: {
    strategy: string;
    actionType: string;
    /** 0-1 float; multiply by 100 for UI percentage. */
    confidence: number;
  } | null;
  focusReason: 'escalation' | 'recent_decision' | null;
}

/* ── Brain Layers (KAN-1108b / KAN-1113) ────────────────────────────
 * Backend: apps/api/src/router.ts → dashboardRouter.getBrainLayers.
 * Last fixture in Dashboard v2 epic. Surfaces 4 cognitive layers
 * (Blueprint / Company Truth / Behavioral / Outcome) from canonical
 * BrainSnapshot schema + Tenant.blueprintId + Blueprint.isActive.
 *
 * Phase 1 + 1.5 HYBRID empty-state (Item 5): blueprintId IS NULL →
 * blueprint.isActive=null + overallScore=null → UI fires empty-state
 * branch entirely. isActive=false → score capped at 25 (Doctrine 5).
 * isActive=true → simple average of 4 layer percentages.
 *
 * Phase 1.5 PROD baseline 2026-06-06: AxisOne tenant has no Blueprint,
 * no BrainSnapshot — empty-state branch is the day-1 PROD render.
 * UI auto-evolves as engine writes BrainSnapshots over time.
 * ─────────────────────────────────────────────────────────────────────── */
export interface BrainLayers {
  blueprint: {
    /** null when no Blueprint assigned (empty-state branch trigger). */
    isActive: boolean | null;
    vertical: string | null;
  };
  companyTruth: { populated: number; total: number; pct: number };
  behavioralLearning: { pct: number };
  outcomeLearning: { pct: number };
  /** null when empty-state; 0-100 otherwise. */
  overallScore: number | null;
  gaps: Array<{ id: string; message: string; severity: 'info' | 'warning' }>;
}

export const dashboardApi = {
  getStats: () => trpcQuery<DashboardStats>('dashboard.getStats', undefined),
  getFocusContact: () => trpcQuery<FocusContact | null>('dashboard.getFocusContact', undefined),
  getBrainLayers: () => trpcQuery<BrainLayers>('dashboard.getBrainLayers', undefined),
};

/* ── Decisions API (KAN-1107) ───────────────────────────────────────
 * Backend: apps/api/src/router.ts → decisionsRouter.feed.
 * Chronological UNION of recent Decisions + OPEN Escalations for the
 * Dashboard Decision Feed panel. Phase 1 Finding B reframe: Decision.source
 * doesn't exist; Escalation rows mixed in via `kind` discriminator surface
 * the "AI vs H" semantic without schema column. Phase 1 Finding C reframe:
 * Decision.channel doesn't exist; hybrid resolution (Action[0].channel +
 * actionType-derived proxy) on server, icon mapping in
 * action-icon-projection.ts.
 * ─────────────────────────────────────────────────────────────────────── */
export interface DecisionFeedItem {
  id: string;
  kind: 'decision' | 'escalation';
  contactId: string;
  contact: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    companyName: string | null;
  };
  /** ISO timestamp from server (Date serialized over JSON). */
  createdAt: string;
  reasoning: string | null;
  // Decision-side
  strategy?: string;
  actionType?: string;
  channel?: string | null;
  /** 0-1 float; multiply by 100 for UI percentage. */
  confidence?: number;
  // Escalation-side
  severity?: string;
  triggerType?: string;
}

export const decisionsApi = {
  feed: (input?: { limit?: number }) =>
    trpcQuery<{ items: DecisionFeedItem[]; total: number }>(
      'decisions.feed',
      input ?? {},
    ),
};

/* ── Actions API (KAN-1107) ─────────────────────────────────────────
 * Backend: apps/api/src/router.ts → actionsRouter.list. Action records
 * carry channel + status from CommunicationAgent dispatch path. Contact
 * JOIN added KAN-1107 for Agent Actions panel.
 *
 * Empirical vocab audit 2026-06-06: Action table is empty in PROD (engine
 * pre-launch; 13.6k decisions, 0 dispatches). Status vocab cribbed from
 * communication-agent.d.ts: pending | sent | delivered | failed | bounced
 * | blocked | rejected. Defensive mapping in action-icon-projection.ts
 * handles unknown values gracefully.
 * ─────────────────────────────────────────────────────────────────────── */
export interface ActionStreamItem {
  id: string;
  contactId: string;
  contact: {
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    companyName: string | null;
  };
  agentType: string;
  channel: string | null;
  status: string;
  payload: Record<string, unknown>;
  /** ISO timestamp from server. */
  createdAt: string;
}

export const actionsApi = {
  list: (input?: { limit?: number; decisionId?: string }) =>
    trpcQuery<{ actions: ActionStreamItem[]; pagination: { page: number; limit: number; total: number; pages: number } }>(
      'actions.list',
      input ?? {},
    ),
};

/* ── Contacts API (KAN-718 Day 10) ──────────────────────────────────
 * Backend: apps/api/src/router.ts → contactsRouter, delegates to
 * packages/api/src/services/contacts-router.ts.
 *
 * Schema: name → firstName + lastName split; status → lifecycleStage.
 * UI must render `${firstName ?? ''} ${lastName ?? ''}`.trim() with null-safety.
 */

export interface ContactListItem {
  id: string;
  email: string | null;
  phone: string | null;
  firstName: string | null;
  lastName: string | null;
  segment: string | null;
  lifecycleStage: string;
  source: string | null;
  dataQualityScore: number;
  // KAN-883 — read-layer extension fields. Backend now returns these on
  // every contacts.list / contacts.get response. Client types catch up
  // here (KAN-884) so /customers, /companies, /orders pages can rely on
  // them without `as any` casts.
  companyId: string | null;
  companyName: string | null;
  addressLine1: string | null;
  // KAN-887 — addressLine2 + postalCode were missed by KAN-883's LIST_SELECT.
  // Surfaced now so detail pages render the full mailing block.
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  country: string | null;
  company: { id: string; name: string } | null;
  createdAt: string;
  updatedAt: string;
}

// KAN-887 — Contact detail (one-roundtrip include of all relations the
// /customers/[id] page renders). Bounded takes: 10-20 per relation.
export interface ContactDetail extends ContactListItem {
  externalIds: Record<string, unknown>;
  customFields: Record<string, unknown>;
  deletedAt: string | null;
  company: { id: string; name: string; domain: string | null } | null;
  customer: {
    mrr: number;
    ltv: number;
    healthScore: number;
    status: string;
    since: string;
    plan: string | null;
  } | null;
  deals: Array<{
    id: string;
    name: string;
    status: string;
    value: string;
    currency: string;
    expectedCloseDate: string | null;
  }>;
  engagements: Array<{
    id: string;
    engagementType: string;
    signalClass: string;
    channel: string | null;
    occurredAt: string;
    metadata: Record<string, unknown>;
  }>;
  outcomes: Array<{
    id: string;
    result: string;
    reasonCategory: string | null;
    recordedAt: string;
    objectiveId: string;
  }>;
  decisions: Array<{
    id: string;
    actionType: string;
    strategySelected: string;
    confidence: number;
    createdAt: string;
  }>;
  escalations: Array<{
    id: string;
    triggerType: string;
    triggerReason: string | null;
    status: string;
    severity: string;
    createdAt: string;
  }>;
  // KAN-cohort-3.5 — reverse "Linked orders" relation (capped take:20).
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    grandTotal: string;
    currency: string;
    placedAt: string;
  }>;
  // KAN-cohort-3.5 — truthful count of orders for the section header,
  // even when `orders` is truncated to the cap.
  _count: { orders: number };
  // KAN-1037-PR5 — M3-2.5c Last reply panel. Server-side derived in
  // `getContactById` from the most recent `email_received` engagement +
  // parallel audit-log lookups for engine response context. Null when
  // the contact has no inbound reply on file.
  latestReply: LatestReply | null;
}

/**
 * KAN-1037-PR5 — Last reply derivation status. Narrow enum per the
 * spec confirmation:
 *   - `escalated`: engine emitted `escalate_to_human` (PR4.5 path).
 *   - `no_action`: engine evaluated, didn't escalate (placeholder for
 *     `send_follow_up` / `advance_stage` / `wait_for_response` /
 *     `close_deal_lost` / `no_action` — KAN-1049 widens).
 *   - `filtered_autoresponder`: PR2 filter caught at webhook
 *     (placeholder — KAN-1049 wires LeadInboxEvent → AuditLog).
 *   - `evaluating`: reply landed but engine hasn't evaluated yet
 *     (cooldown / in-flight window) — implicit fallback.
 */
export type LatestReplyEngineStatus =
  | 'escalated'
  | 'no_action'
  | 'filtered_autoresponder'
  | 'evaluating';

export interface LatestReply {
  id: string;
  bodyPreview: string;
  fromAddress: string;
  subject: string;
  occurredAt: string;
  signalClass: string;
  correlatedDecisionId: string | null;
  engineResponseStatus: LatestReplyEngineStatus;
  engineResponseAt: string | null;
  engineResponseEscalationId: string | null;
  engineReasoning: string | null;
}

// KAN-934 — Cohort 3.1 Contact CRUD form payload. Mirrors the extended
// contacts.create/update Zod schemas in apps/api/src/router.ts.
export interface ContactCreateInput {
  email: string;
  phone?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  segment?: string | null;
  lifecycleStage?: string | null;
  source?: string | null;
  companyId?: string | null;
  addressLine1?: string | null;
  addressLine2?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
}

export interface ContactUpdateInput extends Partial<ContactCreateInput> {
  id: string;
}

export const contactsApi = {
  // KAN-980 — KAN-882 cursor convergence. Return shape now matches the other
  // three list endpoints (deals/companies/orders): `{ items, nextCursor,
  // totalCount }`. Old `{ items, total, limit, offset }` retired.
  list: (input?: {
    search?: string;
    lifecycleStage?: string;
    source?: string;
    companyId?: string;
    limit?: number;
    cursor?: string;
  }) =>
    trpcQuery<CursorPage<ContactListItem>>(
      'contacts.list',
      input ?? { limit: 50 },
    ),
  getById: (id: string) =>
    trpcQuery<ContactDetail>('contacts.getById', { id }),
  // KAN-934 — Cohort 3.1 CRUD mutations.
  create: (input: ContactCreateInput) =>
    trpcMutation<ContactDetail>('contacts.create', input),
  update: (input: ContactUpdateInput) =>
    trpcMutation<ContactDetail>('contacts.update', input),
};

// ─────────────────────────────────────────────────────────────────────────
// KAN-884 — Companies + Orders + Deals read-layer clients.
//
// Backend: apps/api/src/router.ts → companiesRouter / ordersRouter /
//   dealsRouter, delegating to packages/api/src/services/{...}-router.ts
//   (all read-only, all cursor-paginated, all tenant-scoped).
//
// Cursor pagination: server returns `{ items, nextCursor, totalCount }`.
// `nextCursor` is an opaque base64 token — client treats as a black box.
// Pass it back as `cursor: <token>` to fetch the next page. `null` =
// last page.
// ─────────────────────────────────────────────────────────────────────────

export interface CompanyListItem {
  id: string;
  name: string;
  legalName: string | null;
  domain: string | null;
  website: string | null;
  industry: string | null;
  sizeRange: string | null;
  lifecycleStage: string;
  billingCity: string | null;
  billingRegion: string | null;
  billingCountry: string | null;
  taxId: string | null;
  taxIdType: string | null;
  isTaxExempt: boolean;
  ownerId: string | null;
  tags: string[];
  _count: { contacts: number; deals: number; orders: number };
  createdAt: string;
  updatedAt: string;
}

export interface CompanyDetail extends CompanyListItem {
  website: string | null;
  phone: string | null;
  email: string | null;
  description: string | null;
  annualRevenue: string | null;
  billingAddressLine1: string | null;
  billingAddressLine2: string | null;
  billingPostalCode: string | null;
  mailingAddressLine1: string | null;
  mailingAddressLine2: string | null;
  mailingCity: string | null;
  mailingRegion: string | null;
  mailingPostalCode: string | null;
  mailingCountry: string | null;
  businessRegistrationNumber: string | null;
  incorporationJurisdiction: string | null;
  taxExemptionCertificate: string | null;
  linkedinUrl: string | null;
  externalIds: Record<string, unknown>;
  customFields: Record<string, unknown>;
  aiContext: Record<string, unknown>;
  deletedAt: string | null;
  // Hydrated relations (from companies.get include — first 20 each)
  contacts: Array<{
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    lifecycleStage: string;
  }>;
  deals: Array<{
    id: string;
    name: string;
    status: string;
    value: string;
    currency: string;
  }>;
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    grandTotal: string;
    currency: string;
    placedAt: string;
  }>;
  // KAN-936 — owner hydration via the new @relation; null when ownerId
  // is unset.
  owner: { id: string; name: string | null; email: string } | null;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
  totalCount: number;
}

// KAN-936 — User list item shape for AsyncSelect User picker.
export interface UserListItem {
  id: string;
  name: string | null;
  email: string;
}

export const usersApi = {
  list: (input?: { search?: string; limit?: number }) =>
    trpcQuery<{ items: UserListItem[] }>('users.list', input ?? { limit: 50 }),
};

// KAN-937 — Sub-cohort 3.2 Company CRUD form payload. Mirrors the
// companies.create/update Zod schemas in apps/api/src/router.ts.
// 30 form-eligible fields across 5 cards.
export interface CompanyCreateInput {
  // Card 1 — Core Info (required: name)
  name: string;
  legalName?: string | null;
  domain?: string | null;
  website?: string | null;
  industry?: string | null;
  sizeRange?: string | null;
  annualRevenue?: string | null;
  description?: string | null;
  lifecycleStage?: string;
  // Card 2 — Contact Info
  phone?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  // Card 3 — Billing Address
  billingAddressLine1?: string | null;
  billingAddressLine2?: string | null;
  billingCity?: string | null;
  billingRegion?: string | null;
  billingPostalCode?: string | null;
  billingCountry?: string | null;
  // Card 4 — Mailing Address
  mailingAddressLine1?: string | null;
  mailingAddressLine2?: string | null;
  mailingCity?: string | null;
  mailingRegion?: string | null;
  mailingPostalCode?: string | null;
  mailingCountry?: string | null;
  // Card 5 — Tax & Compliance
  taxId?: string | null;
  taxIdType?: string | null;
  businessRegistrationNumber?: string | null;
  incorporationJurisdiction?: string | null;
  isTaxExempt?: boolean;
  taxExemptionCertificate?: string | null;
  // KAN-936 — optional FK to User
  ownerId?: string | null;
}

export interface CompanyUpdateInput extends Partial<CompanyCreateInput> {
  id: string;
}

export const companiesApi = {
  list: (input?: {
    search?: string;
    lifecycleStage?: string;
    ownerId?: string;
    limit?: number;
    cursor?: string;
  }) =>
    trpcQuery<CursorPage<CompanyListItem>>('companies.list', input ?? { limit: 50 }),
  get: (id: string) =>
    trpcQuery<CompanyDetail>('companies.get', { id }),
  // KAN-937 — Sub-cohort 3.2 CRUD mutations.
  create: (input: CompanyCreateInput) =>
    trpcMutation<CompanyDetail>('companies.create', input),
  update: (input: CompanyUpdateInput) =>
    trpcMutation<CompanyDetail>('companies.update', input),
};

export interface OrderListItem {
  id: string;
  orderNumber: string;
  status: string;
  totalAmount: string;
  grandTotal: string;
  currency: string;
  placedAt: string;
  paidAt: string | null;
  paymentMethod: string | null;
  paymentProvider: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
  contact: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  company: { id: string; name: string } | null;
  deal: { id: string; name: string } | null;
}

export interface OrderDetail extends Omit<OrderListItem, "company" | "deal"> {
  contactId: string;
  companyId: string | null;
  dealId: string | null;
  taxAmount: string;
  discountAmount: string;
  lineItems: unknown;
  refundedAt: string | null;
  cancelledAt: string | null;
  providerOrderId: string | null;
  providerData: unknown;
  attributionFirstSource: string | null;
  attributionLastSource: string | null;
  customerNotes: string | null;
  internalNotes: string | null;
  externalIds: Record<string, unknown>;
  customFields: Record<string, unknown>;
  aiContext: Record<string, unknown>;
  correlationId: string | null;
  contact: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    companyId: string | null;
    companyName: string | null;
  };
  company: CompanyDetail | null;
  deal: {
    id: string;
    name: string;
    status: string;
    value: string;
    currency: string;
  } | null;
}

// KAN-945 — Sub-cohort 3.4 Order CRUD form payload. Mirrors the
// orders.create/update Zod schemas in apps/api/src/router.ts.
// 22 form-eligible fields across 5 cards.
export interface OrderCreateInput {
  // Card 1 — Core Order (required: orderNumber, contactId)
  orderNumber: string;
  status?: string;
  source?: string;
  // Card 2 — Money
  totalAmount?: string;
  taxAmount?: string;
  discountAmount?: string;
  grandTotal?: string;
  currency?: string;
  // Card 3 — Payment & Timeline (yyyy-mm-dd strings)
  paymentMethod?: string | null;
  paymentProvider?: string | null;
  providerOrderId?: string | null;
  placedAt?: string | null;
  paidAt?: string | null;
  refundedAt?: string | null;
  cancelledAt?: string | null;
  // Card 4 — Relationships (REQUIRED contactId, optional company/deal)
  contactId: string;
  companyId?: string | null;
  dealId?: string | null;
  // Card 5 — Attribution & Notes
  attributionFirstSource?: string | null;
  attributionLastSource?: string | null;
  customerNotes?: string | null;
  internalNotes?: string | null;
}

// Update surface: orderNumber is NOT editable on edit (Q8 read-only).
// All other fields optional. Time-preservation (Q6.1) relies on the form
// OMITTING unchanged date fields entirely (not sending the same value).
export interface OrderUpdateInput
  extends Partial<Omit<OrderCreateInput, "orderNumber" | "contactId">> {
  id: string;
  contactId?: string;
}

export const ordersApi = {
  list: (input?: {
    search?: string;
    status?: string;
    contactId?: string;
    companyId?: string;
    dealId?: string;
    limit?: number;
    cursor?: string;
  }) =>
    trpcQuery<CursorPage<OrderListItem>>('orders.list', input ?? { limit: 50 }),
  get: (id: string) =>
    trpcQuery<OrderDetail>('orders.get', { id }),
  // KAN-945 — Sub-cohort 3.4 CRUD mutations.
  create: (input: OrderCreateInput) =>
    trpcMutation<OrderDetail>('orders.create', input),
  update: (input: OrderUpdateInput) =>
    trpcMutation<OrderDetail>('orders.update', input),
};

export interface DealListItem {
  id: string;
  name: string;
  status: string;
  probability: number | null;
  expectedCloseDate: string | null;
  closedAt: string | null;
  lostReason: string | null;
  ownerId: string | null;
  assignedAgentId: string | null;
  companyId: string | null;
  value: string;
  currency: string;
  currentStageId: string;
  contactId: string;
  pipelineId: string;
  createdAt: string;
  updatedAt: string;
  contact: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
  };
  company: { id: string; name: string } | null;
}

// KAN-888 — Deal detail (one roundtrip incl. pipeline + currentStage +
// stageHistory + manually-hydrated owner). Surfaces every Deal scalar plus
// the relations the /opportunities/[id] page renders.
export interface DealStageTransition {
  id: string;
  fromStageId: string | null;
  toStageId: string;
  fromStage: { name: string } | null;
  toStage: { name: string };
  transitionedAt: string;
  triggeredBy: string; // 'normalizer' | 'agent' | 'human' | 'system' | 'rule'
  decisionId: string | null;
  decision: {
    id: string;
    actionType: string;
    strategySelected: string;
  } | null;
  metadata: Record<string, unknown>;
}

export interface DealDetail extends Omit<DealListItem, 'contact' | 'company'> {
  lostReasonDetail: string | null;
  wonProductSummary: string | null;
  products: unknown;
  microObjectiveProgress: Record<string, unknown>;
  aiContext: Record<string, unknown>;
  metadata: Record<string, unknown>;
  customFields: Record<string, unknown>;
  externalIds: Record<string, unknown>;
  correlationId: string | null;
  enteredStageAt: string;
  contact: {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    lifecycleStage: string;
    companyId: string | null;
    companyName: string | null;
  };
  company: {
    id: string;
    name: string;
    domain: string | null;
    industry: string | null;
  } | null;
  currentStage: {
    id: string;
    name: string;
    outcomeType: string;
  };
  pipeline: { id: string; name: string };
  stageHistory: DealStageTransition[];
  owner: {
    id: string;
    name: string | null;
    email: string;
  } | null;
  // KAN-cohort-3.5 — reverse "Linked orders" relation (capped take:20).
  orders: Array<{
    id: string;
    orderNumber: string;
    status: string;
    grandTotal: string;
    currency: string;
    placedAt: string;
  }>;
  _count: { orders: number };
}

// KAN-938 — Sub-cohort 3.3 Deal CRUD form payload. Mirrors the
// deals.create/update Zod schemas in apps/api/src/router.ts.
// 13 form-eligible fields across 4 cards.
export interface DealCreateInput {
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
  // KAN-936 — optional User FK (formalized via @relation in this PR)
  ownerId?: string | null;
}

export interface DealUpdateInput
  extends Partial<Omit<DealCreateInput, "pipelineId" | "currentStageId" | "contactId">> {
  id: string;
  pipelineId?: string;
  currentStageId?: string;
  contactId?: string;
}

// KAN-968 — Pipelines kanban board card shape (consumes KAN-967 endpoint).
export interface BoardDealCard {
  id: string;
  name: string;
  value: string; // Decimal serialized
  currency: string;
  currentStageId: string;
  enteredStageAt: string; // ISO date
  contact: { firstName: string | null; lastName: string | null };
  company: { name: string } | null;
  status: string;
  probability: number | null;
  latestDecision: {
    actionType: string;
    confidence: number; // 0..1
  } | null;
}

export interface BoardStageGroup {
  stageId: string;
  deals: BoardDealCard[];
  truncatedCount: number;
}

export interface BoardPipelineResult {
  stages: BoardStageGroup[];
}

export const dealsApi = {
  list: (input?: {
    search?: string;
    status?: string;
    companyId?: string;
    contactId?: string;
    ownerId?: string;
    limit?: number;
    cursor?: string;
  }) =>
    trpcQuery<CursorPage<DealListItem>>('deals.list', input ?? { limit: 50 }),
  get: (id: string) =>
    trpcQuery<DealDetail>('deals.get', { id }),
  // KAN-967 — grouped read for the Pipelines kanban board.
  listByPipeline: (pipelineId: string) =>
    trpcQuery<BoardPipelineResult>('deals.listByPipeline', { pipelineId }),
  // KAN-938 — Sub-cohort 3.3 CRUD mutations.
  create: (input: DealCreateInput) =>
    trpcMutation<DealDetail>('deals.create', input),
  update: (input: DealUpdateInput) =>
    trpcMutation<DealDetail>('deals.update', input),
};

export const recommendationsApi = {
  list: (input?: {
    status?: 'open' | 'claimed' | 'resolved' | 'dismissed';
    severity?: 'low' | 'medium' | 'high' | 'critical';
    limit?: number;
    offset?: number;
  }) =>
    trpcQuery<{ items: RecommendationListItem[]; total: number; limit: number; offset: number }>(
      'recommendations.list',
      input ?? {},
    ),
  getDetail: (id: string) =>
    trpcQuery<RecommendationDetail>('recommendations.getDetail', { id }),
  accept: (id: string, modifiedAction?: SuggestedAction) =>
    trpcMutation<{ id: string; status: string; publishedEventId: string | null }>(
      'recommendations.accept',
      modifiedAction ? { id, modifiedAction } : { id },
    ),
  modify: (id: string, suggestedAction: string) =>
    trpcMutation<{ id: string; status: string; aiSuggestion: string | null }>(
      'recommendations.modify',
      { id, suggestedAction },
    ),
  dismiss: (id: string, reason: string) =>
    trpcMutation<{ id: string; status: string }>(
      'recommendations.dismiss',
      { id, reason },
    ),
  // KAN-1140 Phase 3 PR 6 — operator-corrected metadata path for
  // parse_confidence_review escalations. At least one of the corrected
  // fields must be supplied; the backend validates + synthetic-republishes.
  reclassify: (
    id: string,
    corrections: {
      correctedFormat?: string;
      correctedLanguage?: string;
      correctedVendor?: string;
    },
  ) =>
    trpcMutation<{
      id: string;
      status: string;
      syntheticEventId: string;
      pubsubMessageId: string;
    }>('recommendations.reclassify', { id, ...corrections }),
};

/* ── Parser Patterns API (KAN-1140 Phase 3 PR 7) ────────────────────
 * Per-tenant parse-fingerprint aggregation surface. Settings sub-tab
 * at /settings/parse-fingerprints consumes these. protectedProcedure-
 * gated at the backend (Q-ADD-4 lock: operator-grade, NOT super-admin).
 */
/** KAN-1140 Phase 3 PR 8 — capability announcement status. */
export type ParseFingerprintSupportStatus =
  | 'pending'
  | 'suggested'
  | 'supported'
  | 'unsupported';

export interface ParseFingerprintListItem {
  id: string;
  format: string;
  language: string | null;
  vendor: string | null;
  formatConfidence: string;
  languageConfidence: string | null;
  occurrenceCount: number;
  escalationCount: number;
  reclassifyCount: number;
  /** KAN-1140 PR 8 — capability announcement state. */
  supportStatus: ParseFingerprintSupportStatus;
  suggestedAt: string | null;
  supportedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
}

export interface ParseFingerprintSample {
  id: string;
  resendEmailId: string | null;
  bodyPreview: string;
  senderDomain: string;
  customFields: Record<string, unknown>;
  capturedAt: string;
}

export interface ParseFingerprintDetail extends ParseFingerprintListItem {
  structureHash: string | null;
  senderDomainHash: string;
  labelTokenHash: string | null;
  samples: ParseFingerprintSample[];
  // supportStatus + suggestedAt + supportedAt inherit from
  // ParseFingerprintListItem; no additional fields here.
}

export const parserPatternsApi = {
  list: (input?: {
    sortBy?: 'lastSeenAt' | 'occurrenceCount' | 'escalationCount';
    limit?: number;
    offset?: number;
    formatFilter?: string;
    languageFilter?: string;
    vendorFilter?: string;
    showOnlyWithEscalations?: boolean;
    // KAN-1140 PR 8 — capability announcement status filter
    statusFilter?: ParseFingerprintSupportStatus;
  }) =>
    trpcQuery<{
      items: ParseFingerprintListItem[];
      total: number;
      limit: number;
      offset: number;
    }>('parserPatterns.list', input ?? {}),
  getDetail: (fingerprintId: string) =>
    trpcQuery<ParseFingerprintDetail | null>('parserPatterns.getDetail', { fingerprintId }),
  // KAN-1140 PR 8 — capability announcement mutations.
  markSupported: (fingerprintId: string) =>
    trpcMutation<{
      id: string;
      supportStatus: 'supported';
      previousStatus: ParseFingerprintSupportStatus;
    }>('parserPatterns.markSupported', { fingerprintId }),
  markUnsupported: (fingerprintId: string) =>
    trpcMutation<{
      id: string;
      supportStatus: 'unsupported';
      previousStatus: ParseFingerprintSupportStatus;
    }>('parserPatterns.markUnsupported', { fingerprintId }),
  unmark: (fingerprintId: string) =>
    trpcMutation<{
      id: string;
      supportStatus: 'pending';
      previousStatus: ParseFingerprintSupportStatus;
    }>('parserPatterns.unmark', { fingerprintId }),
};

/* ── KAN-1140 PR 9c — Parse Rules API ────────────────────────────────
 * Operator-facing API for tenant-configurable parsing rules.
 *
 * PR 9a shipped server-side substrate (schema + service + tRPC); PR 9b
 * shipped the runtime executor; KAN-1158 empirically verified the budget
 * mechanism. PR 9c is the FIRST client-side wiring of `parseRules`.
 *
 * # Wire types
 *
 * `ParseRuleStatus`     — pending | active | disabled (PR 9a schema vocab)
 * `ParseRuleScope`      — null/null/null = global; non-null fields constrain
 *                         the cascade scope per Q-ADD-4 lock
 * `ParseRuleRow`        — list/detail row shape
 * `ParseRuleDetail`     — includes previousVersion (Q7 hybrid versioning)
 * `ParseRuleTestResult` — executor output + metrics
 *
 * # Q-ADD-CLIENT-WIRING (PR 9c)
 *
 * Full wrapper layer added from scratch — PR 9a + 9b shipped server-only
 * by design (operator surface gated behind UI).
 */
export type ParseRuleStatus = 'pending' | 'active' | 'disabled';

export interface ParseRuleScope {
  fingerprintId: string | null;
  format: string | null;
  vendor: string | null;
}

export interface ParseRuleExtractorJsonPath {
  type: 'jsonPath';
  path: string;
  transforms?: string[];
}

export interface ParseRuleExtractorRegex {
  type: 'regex';
  pattern: string;
  captureGroup: number;
  transforms?: string[];
}

export type ParseRuleExtractor = ParseRuleExtractorJsonPath | ParseRuleExtractorRegex;

export interface ParseRuleFieldExtractor {
  field: 'firstName' | 'lastName' | 'companyName' | 'phone' | 'intentSummary';
  extractor: ParseRuleExtractor;
}

export interface ParseRuleBody {
  extractors: ParseRuleFieldExtractor[];
}

export interface ParseRuleRow {
  id: string;
  tenantId: string;
  fingerprintId: string | null;
  format: string | null;
  vendor: string | null;
  label: string;
  status: ParseRuleStatus;
  body: ParseRuleBody;
  createdBy: string;
  updatedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ParseRulePreviousVersion {
  body: ParseRuleBody;
  label: string;
  status: ParseRuleStatus;
  archivedAt: string;
  archivedBy: string;
}

export interface ParseRuleDetail extends ParseRuleRow {
  previousVersion: ParseRulePreviousVersion | null;
}

export interface ParseRuleTestResult {
  output: Partial<Record<ParseRuleFieldExtractor['field'], string>>;
  metrics: {
    rulesEvaluated: number;
    fieldsWritten: number;
    rulesThrown: number;
    rulesTimedOut: number;
    pipelineBudgetExceeded: boolean;
    totalDurationMs: number;
  };
}

export const parseRulesApi = {
  list: (input?: {
    fingerprintId?: string;
    format?: string;
    vendor?: string;
    statusFilter?: ParseRuleStatus;
    limit?: number;
    offset?: number;
  }) => trpcQuery<{ rows: ParseRuleRow[] }>('parseRules.list', input ?? {}),
  getDetail: (ruleId: string) =>
    trpcQuery<ParseRuleDetail>('parseRules.getDetail', { ruleId }),
  create: (input: {
    label: string;
    body: ParseRuleBody;
    fingerprintId?: string;
    format?: string;
    vendor?: string;
  }) => trpcMutation<{ id: string }>('parseRules.create', input),
  update: (input: {
    ruleId: string;
    label?: string;
    body?: ParseRuleBody;
    status?: ParseRuleStatus;
  }) => trpcMutation<{ id: string }>('parseRules.update', input),
  delete: (ruleId: string) =>
    trpcMutation<{ id: string }>('parseRules.delete', { ruleId }),
  restorePreviousVersion: (ruleId: string) =>
    trpcMutation<{ id: string }>('parseRules.restorePreviousVersion', { ruleId }),
  activate: (ruleId: string) =>
    trpcMutation<{ id: string; status: ParseRuleStatus }>('parseRules.activate', { ruleId }),
  deactivate: (ruleId: string) =>
    trpcMutation<{ id: string; status: ParseRuleStatus }>('parseRules.deactivate', { ruleId }),
  testAgainstSample: (input: {
    ruleBody: ParseRuleBody;
    sampleSource: 'stored' | 'paste' | 'recent';
    sampleId?: string;
    rawBody?: string;
    rawStructured?: Record<string, unknown>;
    fromAddress?: string;
  }) => trpcMutation<ParseRuleTestResult>('parseRules.testAgainstSample', input),
};

/**
 * KAN-1140 PR 9c — Lead Inbox event body on-demand fetch.
 * Used by parse-rules SampleTestPanel "recent inbound" picker. Body is
 * NOT included in `inboxApi.listRecentEvents` for security (bodyPreview
 * sensitive); surfaced only when operator explicitly picks one event.
 */
export const inboxBodyApi = {
  getEventBody: (id: string) =>
    trpcQuery<{
      id: string;
      bodyPreview: string | null;
      fromAddress: string;
      subject: string | null;
    }>('inbox.getEventBody', { id }),
};

/* ── Import Jobs API (KAN-896 — Cohort 2.1a) ──────────────────────────
 * Backend: apps/api/src/router.ts → importJobsRouter, delegates to
 * packages/api/src/services/import-jobs-router.ts.
 *
 * Upload flow (consumed by PR 2 / Cohort 2.1b UI):
 *   1. createUploadUrl({ filename, fileSize, fileMimeType, mode })
 *      → { importJobId, signedUploadUrl, gcsObjectPath, expiresAt }
 *   2. Browser PUT file body to signedUploadUrl with Content-Type header
 *   3. confirmUpload({ importJobId })
 *      → ImportJobDetail with detectedHeaders + sampleRows populated
 */

export type ImportMode = 'replace_all' | 'update_add';
export type ImportStatus =
  | 'awaiting_upload'
  | 'uploaded'
  | 'inspecting'
  | 'inspected'
  | 'failed';
export type ImportFileType = 'csv' | 'xlsx' | 'unknown';

// KAN-904 — Cohort 2.2. AI-detected entity type (mirrors Prisma enum).
export type DetectedEntityType =
  | 'contacts'
  | 'companies'
  | 'deals'
  | 'orders'
  | 'mixed'
  | 'unknown';

// KAN-905 — Cohort 2.4. Field mapping shapes.
export type TargetFieldKind = 'canonical' | 'lookup';

export interface TargetField {
  name: string;
  label: string;
  description: string;
  kind: TargetFieldKind;
}

export interface FieldMappingEntry {
  sourceColumn: string;
  /** Schema column name in the entity's universe, or the literal 'skip'. */
  targetField: string;
  /** 0-100 integer. null for 'skip' rows. */
  confidence: number | null;
}

// KAN-907 — Cohort 2.3. Row-classification result aggregates.
export interface RowClassificationCounts {
  total: number;
  byEntity: {
    contacts: number;
    companies: number;
    deals: number;
    orders: number;
    skipped: number;
    unknown: number;
  };
  bySource: {
    heuristic: number;
    llm: number;
  };
  /** Count of rows flagged review_recommended (heuristic <85 or LLM <70). */
  lowConfidenceFlags: number;
}

// KAN-911 — Cohort 2.6. Duplicate-detection shapes (rule-based +
// Levenshtein, no LLM). Mirrors the service-side types in
// packages/api/src/services/import-dedup.ts so the UI can render
// candidate cards + signal chips without a second source of truth.
export type DedupEntityType = 'contacts' | 'companies' | 'deals' | 'orders';
export type DedupSuggestedAction = 'update' | 'needs_review' | 'insert' | 'skip';
/** Canonical signal names rendered as chips on the resolution UI. */
export type DedupSignalName =
  | 'email_exact'
  | 'phone_exact'
  | 'domain_exact'
  | 'provider_order_id_exact'
  | 'order_number_exact'
  | 'name_fuzzy'
  | 'legal_name_fuzzy'
  | 'close_date_window'
  | 'contact_email_exact'
  | 'placed_at_window';

export interface DedupMatchCandidate {
  existingEntityId: string;
  /** 0-100 confidence. 100 = exact signal; ≤94 = fuzzy. */
  score: number;
  matchedFields: DedupSignalName[];
}

export interface DedupMatchDecision {
  candidates: DedupMatchCandidate[];
  suggestedAction: DedupSuggestedAction;
  /** Top candidate's score, or 0 if no candidates. */
  confidence: number;
  suggestedReason: string;
  /** Set when the operator overrides the suggestion via the resolution UI. */
  userChoice?: {
    action: DedupSuggestedAction;
    chosenCandidateId?: string;
    overriddenAt: string;
  };
}

interface DedupPerEntityCount {
  total: number;
  exactMatches: number;
  fuzzyMatches: number;
  needsReview: number;
  insertOnly: number;
}

export interface DedupCounts {
  byEntity: {
    contacts: DedupPerEntityCount;
    companies: DedupPerEntityCount;
    deals: DedupPerEntityCount;
    orders: DedupPerEntityCount;
  };
  candidatesScanned: {
    contacts: number;
    companies: number;
    deals: number;
    orders: number;
  };
}

export interface DedupStagingRow {
  id: string;
  sourceRowIndex: number;
  sourceRowData: Record<string, unknown> | null;
  matchDecision: DedupMatchDecision | null;
}

// KAN-913 — Cohort 2.7. Commit shape (no LLM; per-row $transaction
// + AuditLog + Pub/Sub fanout).
export type ImportCommitStatus =
  | 'pending'
  | 'running'
  | 'succeeded'
  | 'partial'
  | 'failed';

export type CommitErrorReason =
  | 'contact_not_found'
  | 'pipeline_not_found'
  | 'stage_not_found'
  | 'order_number_duplicate'
  | 'company_name_required'
  | 'needs_review_unresolved'
  | 'update_target_missing'
  | 'unknown';

export interface CommitErrorEntry {
  stagingRowId: string;
  entityType: 'contact' | 'company' | 'deal' | 'order';
  sourceRowIndex: number;
  reason: CommitErrorReason;
  unresolvedKey?: string;
  errorMessage: string;
}

export interface ImportJobListItem {
  id: string;
  fileName: string;
  fileSize: number;
  fileMimeType: string;
  mode: ImportMode;
  status: ImportStatus;
  detectedFileType: ImportFileType | null;
  detectedRowCount: number | null;
  detectedColumnCount: number | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
  uploadConfirmedAt: string | null;
  inspectionCompletedAt: string | null;
  createdByUserId: string;
}

export interface ImportJobDetail extends ImportJobListItem {
  gcsObjectPath: string;
  /** Array<string> — populated when status='inspected'. */
  detectedHeaders: string[] | null;
  /** Array<Record<string, unknown>> — first 5 data rows; populated when status='inspected'. */
  sampleRows: Array<Record<string, unknown>> | null;
  errorAt: string | null;
  inspectionStartedAt: string | null;
  tenantId: string;
  // KAN-904 — Cohort 2.2 AI entity detection fields.
  detectedEntityType: DetectedEntityType | null;
  detectionConfidence: number | null;
  detectionReasoning: string | null;
  detectionStartedAt: string | null;
  detectionCompletedAt: string | null;
  detectionError: string | null;
  detectionErrorAt: string | null;
  detectionInputTokens: number | null;
  detectionOutputTokens: number | null;
  detectionLlmModel: string | null;
  // KAN-905 — Cohort 2.4 AI field mapping fields.
  fieldMappings: FieldMappingEntry[] | null;
  fieldMappingConfidence: number | null;
  fieldMappingReasoning: string | null;
  fieldMappingStartedAt: string | null;
  fieldMappingCompletedAt: string | null;
  fieldMappingError: string | null;
  fieldMappingErrorAt: string | null;
  fieldMappingInputTokens: number | null;
  fieldMappingOutputTokens: number | null;
  fieldMappingLlmModel: string | null;
  fieldMappingConfirmedAt: string | null;
  // KAN-922 — per-import match configuration.
  dedupMatchField: string | null;
  externalSourceTag: string | null;
  customerLinkField: string | null;
  dealLinkField: string | null;
  // KAN-907 — Cohort 2.3 row-classification fields.
  rowClassificationCounts: RowClassificationCounts | null;
  rowClassificationStartedAt: string | null;
  rowClassificationCompletedAt: string | null;
  rowClassificationError: string | null;
  rowClassificationErrorAt: string | null;
  rowClassificationInputTokens: number | null;
  rowClassificationOutputTokens: number | null;
  rowClassificationLlmModel: string | null;
  rowClassificationConfirmedAt: string | null;
  // KAN-911 — Cohort 2.6 duplicate-detection fields.
  dedupStartedAt: string | null;
  dedupCompletedAt: string | null;
  dedupError: string | null;
  dedupErrorAt: string | null;
  dedupCounts: DedupCounts | null;
  dedupCandidatesCount: number | null;
  dedupConfirmedAt: string | null;
  // KAN-913 — Cohort 2.7 commit fields.
  commitStatus: ImportCommitStatus;
  commitStartedAt: string | null;
  commitCompletedAt: string | null;
  committedRowCount: number;
  failedRowCount: number;
  commitErrors: CommitErrorEntry[];
}

export interface CreateUploadUrlResult {
  importJobId: string;
  signedUploadUrl: string;
  gcsObjectPath: string;
  expiresAt: string;
}

export const importJobsApi = {
  createUploadUrl: (input: {
    filename: string;
    fileSize: number;
    fileMimeType:
      | 'text/csv'
      | 'application/vnd.ms-excel'
      | 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    mode: ImportMode;
  }) => trpcMutation<CreateUploadUrlResult>('importJobs.createUploadUrl', input),
  confirmUpload: (importJobId: string) =>
    trpcMutation<ImportJobDetail>('importJobs.confirmUpload', { importJobId }),
  list: (input?: { status?: ImportStatus; limit?: number; cursor?: string }) =>
    trpcQuery<CursorPage<ImportJobListItem>>(
      'importJobs.list',
      input ?? { limit: 50 },
    ),
  get: (id: string) => trpcQuery<ImportJobDetail>('importJobs.get', { id }),
  // KAN-904 — AI entity detection. Mutation: blocks until Haiku
  // responds (typical 1-3s) and returns the updated ImportJob.
  runDetection: (importJobId: string) =>
    trpcMutation<ImportJobDetail>('importJobs.runDetection', { importJobId }),
  // KAN-905 — AI field mapping. Suggests column→target mappings via
  // Haiku. Blocks ~2-4s. Returns the updated ImportJob with
  // fieldMappings populated.
  runMapping: (importJobId: string) =>
    trpcMutation<ImportJobDetail>('importJobs.runMapping', { importJobId }),
  // KAN-905 — operator-confirmed mappings. Throws on collision or
  // unknown source/target.
  saveMappings: (input: {
    importJobId: string;
    mappings: FieldMappingEntry[];
    // KAN-922 — per-import match configuration. All nullable.
    dedupMatchField?: string | null;
    externalSourceTag?: string | null;
    customerLinkField?: string | null;
    dealLinkField?: string | null;
  }) => trpcMutation<ImportJobDetail>('importJobs.saveMappings', input),
  // KAN-905 — field-universe dropdown options for the mapping UI.
  getFieldUniverse: (entityType: string) =>
    trpcQuery<TargetField[]>('importJobs.getFieldUniverse', { entityType }),
  // KAN-907 — row-level classification. Hybrid heuristic + LLM batch
  // pipeline. Synchronous; typical latency 5-30s for mixed files.
  runRowClassification: (importJobId: string) =>
    trpcMutation<ImportJobDetail>('importJobs.runRowClassification', {
      importJobId,
    }),
  // KAN-907 — operator confirmation of classification results.
  // Idempotent (re-confirming just updates the timestamp).
  confirmRowClassification: (importJobId: string) =>
    trpcMutation<ImportJobDetail>('importJobs.confirmRowClassification', {
      importJobId,
    }),
  // KAN-911 — Cohort 2.6 duplicate detection. Rule-based +
  // Levenshtein, no LLM. Synchronous; typical latency 2-5s with
  // first-letter bucket pre-filter (decision E).
  runDuplicateDetection: (importJobId: string) =>
    trpcMutation<ImportJobDetail>('importJobs.runDuplicateDetection', {
      importJobId,
    }),
  // KAN-911 — UI list query for the duplicates resolution table.
  // Returns staging rows for one entity type, optionally filtered
  // by suggested+overridden action.
  getStagingForReview: (input: {
    importJobId: string;
    entityType: DedupEntityType;
    filterAction?: DedupSuggestedAction;
  }) =>
    trpcQuery<{ rows: DedupStagingRow[]; count: number }>(
      'importJobs.getStagingForReview',
      input,
    ),
  // KAN-911 — operator per-row override. Sets MatchDecision.userChoice
  // on the staging row. chosenCandidateId required when newAction is
  // 'update'.
  overrideStagingDecision: (input: {
    stagingId: string;
    entityType: DedupEntityType;
    newAction: DedupSuggestedAction;
    chosenCandidateId?: string;
  }) =>
    trpcMutation<{ ok: true }>(
      'importJobs.overrideStagingDecision',
      input,
    ),
  // KAN-911 — final gate before commit. Refuses if any needs_review
  // row lacks an override. Sets dedupConfirmedAt.
  confirmDuplicateResolution: (importJobId: string) =>
    trpcMutation<ImportJobDetail>('importJobs.confirmDuplicateResolution', {
      importJobId,
    }),
  // KAN-913 — Cohort 2.7 commit. Iterates staging rows + applies
  // canonical INSERT/UPDATE per matchDecision. Synchronous; ~30-60s
  // for 10K rows in V1 (async Cloud Run job is a follow-up).
  runCommit: (importJobId: string) =>
    trpcMutation<ImportJobDetail>('importJobs.runCommit', { importJobId }),
  // KAN-913 — on-demand CSV of commitErrors. Wired to a Blob download
  // in the UI. No GCS write at commit time.
  downloadCommitErrors: (importJobId: string) =>
    trpcQuery<{ csvContent: string; rowCount: number }>(
      'importJobs.downloadCommitErrors',
      { importJobId },
    ),
};

// ─────────────────────────────────────────────
// KAN-997 — Campaign Layer Slice 1 — text-to-segment (read-only).
//
// Slice 1 surface is intentionally minimal: a single mutation
// (textToSegment) that takes NL and returns a discriminated union of
// { segment | thin | ambiguous }. The Slice 1 demo page consumes only
// this. Direct count() exposed for Slice 2 manual filter builder +
// future API consumers.
// ─────────────────────────────────────────────

export type CampaignTextToSegmentResult =
  | {
      kind: 'segment';
      conditions: unknown;
      count: number;
      message: string;
    }
  | {
      kind: 'thin';
      conditions: unknown;
      count: number;
      message: string;
    }
  | {
      kind: 'ambiguous';
      clarifyingQuestion: string;
    };

// KAN-1000 Slice 2 — full campaign proposal (read-only).

export type CampaignFirstAction = {
  day: number;
  channel: 'email' | 'sms' | 'whatsapp';
  intent: string;
  description: string;
};

export type CampaignProposalShape = {
  name: string;
  windowStartUtc: string | null;
  windowEndUtc: string | null;
  audience: {
    conditions: unknown;
    count: number;
    historicalValueUsd: number;
  };
  objective: { id: string; name: string; type: string };
  strategy: 'direct' | 're_engage' | 'trust_build' | 'guided';
  proposedStages: Array<{ name: string; order: number; description: string }>;
  firstActions: CampaignFirstAction[];
};

// KAN-1184 — CampaignProposeResult retired (campaigns.propose tRPC + client
// wrapper deleted). Substrate types CampaignProposalShape /
// CampaignFirstAction stay as internal references (referenced by
// audience-router.ts proposeCampaign function which orchestrator may call
// per Q-ADD D Finding E internal-helper retention).

// KAN-1166 PR 3 — Campaign detail shape consumed by /campaigns/[id] chat UI.
// Mirrors the campaigns.get tRPC select set. feasibilityAnalysis is the
// FeasibilityCounselResult written by analyzeFeasibility; null until first run.
export interface CampaignDetail {
  id: string;
  tenantId: string;
  name: string;
  status: 'draft' | 'committed' | 'active' | 'paused' | 'archived' | 'completed';
  objectiveId: string;
  strategy: 'direct' | 're_engage' | 'trust_build' | 'guided' | null;
  audienceConditions: unknown;
  audienceMode: 'static' | 'dynamic';
  audienceSnapshotCount: number | null;
  windowStart: string | null;
  windowEnd: string | null;
  goalType: CampaignGoalType | null;
  goalTarget: number | null;
  goalProductId: string | null;
  goalDescription: string | null;
  feasibilityAnalysis: FeasibilityCounselResult | null;
  proposedPlan: unknown | null;
  committedPlan: unknown | null;
  conversationThreadId: string | null;
  activatedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// KAN-1183 — Compact list-item shape projected server-side from Campaign.
// Q-ADD A3 lock: feasibilityAnalysisKind + achievability are derived from
// the full FeasibilityCounselResult JSON on Campaign.feasibilityAnalysis
// to keep list-page payload bytes-cheap. Full structured counsel stays on
// /campaigns/[id] (campaigns.get → CampaignDetail).
export interface CampaignListItem {
  id: string;
  name: string;
  status:
    | 'draft'
    | 'committed'
    | 'active'
    | 'paused'
    | 'completed'
    | 'archived';
  goalType: CampaignGoalType | null;
  goalTarget: number | null;
  goalDescription: string | null;
  feasibilityAnalysisKind:
    | 'cold_start_counsel'
    | 'feasibility_counsel'
    | 'analyzer_unavailable'
    | null;
  achievability: 'feasible' | 'stretch' | 'unrealistic' | null;
  activatedAt: string | null;
  updatedAt: string;
}

export const campaignsApi = {
  /**
   * KAN-1183 — Filterable Campaign list for the operator-facing /campaigns
   * page. Server hides Always-On Campaigns by default (Q-ADD F);
   * `includeAlwaysOn: true` surfaces them for debugging only. Cursor
   * pagination via the canonical CursorPage<T> shape.
   */
  list: (input: {
    search?: string;
    status?: string;
    limit?: number;
    cursor?: string;
    includeAlwaysOn?: boolean;
  }) =>
    trpcQuery<CursorPage<CampaignListItem>>('campaigns.list', input),

  /**
   * KAN-1166 PR 3 — Campaign read for the chat UI. Tenant-scoped on the
   * server (where: { id, tenantId }); 404 on cross-tenant probe.
   */
  get: (campaignId: string) =>
    trpcQuery<CampaignDetail>('campaigns.get', { campaignId }),

  /**
   * NL → audience_conditions + count, single round-trip. LLM is
   * tier='reasoning' (claude-sonnet-4-6) with callerTag
   * 'campaign:text-to-segment' (cost rolls up on /settings/observability
   * under the 'campaign' prefix chip).
   */
  textToSegment: (nl: string) =>
    trpcMutation<CampaignTextToSegmentResult>('campaigns.textToSegment', { nl }),

  /**
   * Direct count for a pre-built AudienceConditions tree. Slice 1 UI
   * doesn't call this; reserved for Slice 2 manual filter builder + the
   * /campaigns preview edits (when the user changes the date window,
   * the preview re-counts via this directly without re-running the LLM).
   */
  count: (conditions: unknown) =>
    trpcQuery<{ count: number; isThin: boolean; historicalValueUsd: number }>(
      'campaigns.count',
      { conditions },
    ),

  /**
   * KAN-1189 — Conversation history retrieval for /campaigns/new?campaignId=
   * restoration. Cursor-paginated; default 100/page (H5 lock).
   *
   * Returns turns ordered by `createdAt ASC`. Tenant-scoped server-side
   * via the protectedProcedure context. The hook layer (useCampaignBuilder)
   * applies `replayConversationState` (from @growth/shared) to derive
   * the operator's chip-group state from these turns.
   */
  getConversationHistory: (input: {
    campaignId: string;
    cursor?: string;
    limit?: number;
  }) =>
    trpcQuery<{
      items: Array<{
        id: string;
        turnType: string;
        content: string;
        proposalSnapshot: unknown | null;
        dataRequest: unknown | null;
        dataIngestionEvent: unknown | null;
        createdAt: string;
      }>;
      nextCursor: string | null;
      totalCount: number;
    }>('campaigns.getConversationHistory', input),

  /**
   * KAN-1184 — Conversational orchestrator turn. Multi-turn dialogue
   * extracts the 4 dimensions (Product / Objectives / Timeline / Audience)
   * in canonical order; orchestrator persists each turn to
   * CampaignConversationTurn. On first turn `campaignId` is omitted; the
   * server creates a Draft Campaign + returns its id.
   *
   * (Replaces the KAN-1000 Slice 2 `propose` one-shot which retired with
   * KAN-1184 — operators no longer get a one-shot full proposal; the
   * orchestrator surfaces dimensions iteratively with concrete-number
   * counts on the audience step.)
   */
  chat: (input: {
    campaignId?: string;
    message: string;
    state: ConversationState;
  }) => trpcMutation<ChatTurnResult>('campaigns.chat', input),

  /**
   * KAN-1185 — Action Plan generator.
   *
   * Operator-initiated (Q-ADD-NEW-2 lock): UI surfaces this affordance
   * once chat returns `all_dimensions_confirmed`. NOT auto-chained from the
   * orchestrator turn — multi-pipeline LLM round-trips can take 5-30s and
   * blocking chat UX would defeat the edit-after-confirm affordance.
   *
   * Layer separation (Q-ADD-NEW-1 lock): generator owns Campaign.proposedPlan;
   * feasibility-analyzer owns Campaign.feasibilityAnalysis. The shipped
   * persistCampaignFeasibility was modified in this same PR to stop writing
   * proposedPlan (clean ownership).
   *
   * Returns `ActionPlanResult` discriminated union — fail-safe (never throws):
   *   - 'action_plan'              — plan generated + persisted
   *   - 'analyzer_unavailable'     — DB/LLM transient
   *   - 'insufficient_dimensions'  — chat hasn't filled all 4 dimensions yet
   */
  generateActionPlan: (input: {
    campaignId: string;
  }) =>
    trpcMutation<ActionPlanResult>('campaigns.generateActionPlan', input),

  /**
   * KAN-1186 — Action Plan refiner.
   *
   * Operator-initiated NL refinement. LLM classifies into ONE of 4 edit-axis
   * families (stage / first_actions / audience / dimension) and dispatches.
   * Reasoning-tier ONLY (NEW-A — no cheap-tier fast-path).
   *
   * Pass `expectedUpdatedAt` (ISO string of Campaign.updatedAt at request time)
   * for optimistic concurrency (NEW-B); mismatched token returns
   * `concurrent_edit_conflict` with the current plan to re-apply on top of.
   *
   * Returns `RefineActionPlanResult` discriminated union — fail-safe (never throws):
   *   - 'action_plan_refined'        — refinement applied + persisted
   *   - 'bounds_violation'           — stage edit violates STRATEGY_STAGE_BOUNDS
   *   - 'no_plan_to_refine'          — Campaign.proposedPlan IS NULL
   *   - 'concurrent_edit_conflict'   — Campaign.updatedAt drifted
   *   - 'analyzer_unavailable'       — DB/LLM transient
   */
  refineActionPlan: (input: {
    campaignId: string;
    refinementMessage: string;
    expectedUpdatedAt?: string;
  }) =>
    trpcMutation<RefineActionPlanResult>('campaigns.refineActionPlan', input),

  /**
   * KAN-1186 — Revert last Action Plan refinement (E8 lock).
   *
   * Materializes the most recent refinement's `before` snapshot from audit_log
   * back into Campaign.proposedPlan. Emits a separate audit row
   * (campaign.action_plan_refinement_reverted) — never destroys forensic history.
   */
  revertLastActionPlanRefinement: (input: {
    campaignId: string;
  }) =>
    trpcMutation<RevertActionPlanRefinementResult>('campaigns.revertLastActionPlanRefinement', input),

  /**
   * KAN-1190 — Commit multi-Pipeline Action Plan.
   *
   * Sibling to the legacy `commit` mutation below — input shape diverges
   * fundamentally (no proposal payload; reads Campaign.proposedPlan). Materializes
   * N Pipelines + N×M Stages in a single transaction; flips Campaign.status
   * draft → committed (J4 — NOT active; preserves INERT-post-commit doctrine).
   *
   * Pass `expectedUpdatedAt` (ISO string of Campaign.updatedAt at commit-button-
   * press time) for optimistic concurrency (J11); mismatched token returns
   * `concurrent_edit_conflict` with the current plan to re-confirm.
   *
   * Returns `CommitActionPlanResult` discriminated union — fail-safe (never throws):
   *   - 'committed'                  — N pipelines materialized + status flipped
   *   - 'already_committed'          — idempotent re-commit (J8); same IDs
   *   - 'bounds_violation'           — STRATEGY_STAGE_BOUNDS re-check failed (J3)
   *   - 'concurrent_edit_conflict'   — Campaign.updatedAt drifted (J11)
   *   - 'analyzer_unavailable'       — DB/tx transient
   */
  commitActionPlan: (input: {
    campaignId: string;
    expectedUpdatedAt?: string;
  }) =>
    trpcMutation<CommitActionPlanResult>('campaigns.commitActionPlan', input),

  /**
   * KAN-1001 Slice 3a — commit a validated proposal into Campaign +
   * Pipeline + Stages + initial CampaignMembership snapshot. INERT:
   * no Decision Engine handoff, no sends. `idempotencyKey` is a
   * client-generated UUID that guards against double-submit; the same
   * key + name within a 5-minute window returns the existing IDs
   * without re-writing.
   */
  commit: (input: {
    proposal: CampaignProposalShape;
    edits?: {
      name?: string;
      windowStartUtc?: string | null;
      windowEndUtc?: string | null;
    };
    idempotencyKey: string;
  }) =>
    trpcMutation<CampaignCommitResult>('campaigns.commit', input),

  /** KAN-1001 Slice 3a — archive a committed campaign (hides it +
   *  prevents further admits). Audit-logged. */
  archive: (campaignId: string) =>
    trpcMutation<{ campaignId: string; status: 'archived'; archivedAt: string }>(
      'campaigns.archive',
      { campaignId },
    ),

  /** KAN-1010 SAE PR5 — activate a committed campaign. Flips status →
   *  active, upserts ContactObjectiveStack entries, drip-publishes
   *  decision.run per member. Under autoApproveEnabled=false: every
   *  evaluation lands as an Escalation in the /escalations queue;
   *  zero unsupervised sends.
   *
   *  Preconditions: campaign.status='committed' AND audienceEvaluatedAt
   *  IS NOT NULL. Else returns kind='rejected' with a named reason.
   *  Idempotent on active. */
  activate: (campaignId: string) =>
    trpcMutation<CampaignActivateResult>('campaigns.activate', { campaignId }),

  /** KAN-1010 SAE PR5 — pause an active campaign. The stop lever:
   *  flips status → paused + stack rows → paused so the PR3 consumer
   *  guard rejects any in-flight or redelivered decision.run. */
  pause: (campaignId: string) =>
    trpcMutation<CampaignPauseResult>('campaigns.pause', { campaignId }),

  /**
   * KAN-1167 — Campaign-as-Conversation v0.1 outcome-goal entry.
   *
   * Operator sets the quantified business outcome target for an outcome
   * Campaign. Rejected on Always-On Campaigns (they're intent-less). Server
   * validates goalType + goalTarget required-together and writes an audit
   * row via the shared writeAuditBestEffort helper (KAN-1168 closeout
   * pattern).
   */
  setGoal: (input: CampaignGoalInput) =>
    trpcMutation<CampaignGoalResult>('campaigns.setGoal', input),

  /**
   * KAN-1166 PR 2b — request AI honest counsel on the Campaign's outcome goal.
   *
   * Preconditions: Campaign.goalType + goalTarget + goalDescription set via
   * campaigns.setGoal first. Audience conditions present (campaigns.commit'd).
   * Throws BAD_REQUEST when goal isn't set.
   *
   * Returns discriminated FeasibilityCounselResult:
   *   - 'cold_start_counsel'  — dataReadiness=insufficient; deterministic
   *                              substrate-acquisition counsel (NO LLM call)
   *   - 'feasibility_counsel' — dataReadiness=partial|sufficient; LLM-synthesized
   *                              counsel with achievability verdict + 3 paths
   *   - 'analyzer_unavailable' — LLM transient post-retry; graceful degradation
   *
   * Idempotent re-run — overwrites Campaign.feasibilityAnalysis +
   * Campaign.proposedPlan + emits audit log with prior counsel snapshot.
   */
  analyzeFeasibility: (campaignId: string) =>
    trpcMutation<FeasibilityCounselResult>('campaigns.analyzeFeasibility', { campaignId }),
};

// KAN-1167 — Campaign-as-Conversation v0.1 outcome-goal types.
export type CampaignGoalType = 'revenue' | 'units' | 'deals' | 'meetings' | 'custom';

export interface CampaignGoalInput {
  campaignId: string;
  goalType: CampaignGoalType;
  goalTarget: number;
  goalProductId?: string | null;
  goalDescription: string;
}

export interface CampaignGoalResult {
  id: string;
  goalType: CampaignGoalType;
  goalTarget: number;
  goalProductId: string | null;
  goalDescription: string;
}

export type CampaignActivateResult =
  | {
      kind: 'activated';
      campaignId: string;
      memberCount: number;
      stackEntriesCreated: number;
      stackEntriesReactivated: number;
      dripPublishesPerSecond: number;
    }
  | {
      kind: 'already_active';
      campaignId: string;
      memberCount: number;
    }
  | {
      kind: 'rejected';
      campaignId: string;
      reason:
        | 'campaign_not_found'
        | 'audience_not_evaluated'
        | 'status_draft'
        | 'status_paused'
        | 'status_completed'
        | 'status_archived';
      currentStatus?: string;
    };

export type CampaignPauseResult =
  | {
      kind: 'paused';
      campaignId: string;
      stackEntriesPaused: number;
    }
  | {
      kind: 'already_inactive';
      campaignId: string;
      currentStatus: string;
    }
  | {
      kind: 'rejected';
      campaignId: string;
      reason: 'campaign_not_found' | 'status_draft' | 'status_committed';
      currentStatus?: string;
    };

export type CampaignCommitResult = {
  alreadyExisted: boolean;
  campaignId: string;
  pipelineId: string;
  stageIds: string[];
  audienceCount: number;
  membershipStatus: 'materialized_sync' | 'deferred_async';
  membershipSnapshotCountSync: number;
};

// M3-1c — Sub-objective gap-state read + manual transition surface.
// Mirrors the SubObjectiveGapState shape from @growth/shared (the API
// returns the same shape the engine threads internally).
export type SubObjectiveStateValue = 'unknown' | 'partial' | 'known' | 'not_applicable';
export type SubObjectiveValueTypeValue = 'text' | 'date' | 'numeric' | 'enum';
export interface DiscoveryStatePrioritizedGap {
  key: string;
  label: string;
  valueType: SubObjectiveValueTypeValue;
  state: SubObjectiveStateValue;
  valueIfPartial?: string;
  priorityWeight: number;
  requiredAtStage?: string;
  recencyDaysSinceLastEval: number;
  score: number;
  hardTrigger: boolean;
}
// M3-1c-followup — resolved (known + not_applicable) rows. Engine ignores;
// the panel renders these in a collapsed "Known (n)" section below the
// active intent list so operators see what the engine has learned.
export interface DiscoveryStateResolvedGap {
  key: string;
  label: string;
  valueType: SubObjectiveValueTypeValue;
  state: 'known' | 'not_applicable';
  /** Single-string rendering for the row body; null on not_applicable. */
  value: string | null;
  source: 'decision_initialize' | 'manual' | 'extraction' | 'enrichment';
  /** Email > UID > "system:gap-tracker" depending on writer. */
  setBy: string | null;
  /** ISO timestamp for client-side relative-time rendering. */
  setAt: string;
}
export interface DiscoveryStateForContact {
  prioritizedGaps: DiscoveryStatePrioritizedGap[];
  topCandidate?: { key: string; label: string; score: number; hardTrigger: boolean };
  resolvedGaps: DiscoveryStateResolvedGap[];
}

export const subObjectivesApi = {
  getStateForContact: (contactId: string) =>
    trpcQuery<DiscoveryStateForContact>('subObjectives.getStateForContact', { contactId }),
  transitionState: (input: {
    contactId: string;
    subObjectiveKey: 'timeline' | 'budget' | 'authority' | 'need' | 'motivation';
    toState: 'known' | 'not_applicable';
    value?: string | number | null;
  }) => trpcMutation<{ ok: true; previousState: SubObjectiveStateValue }>('subObjectives.transitionState', input),
};
