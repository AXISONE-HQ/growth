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

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://growth-api-1086551891973.us-central1.run.app';

// Pre-launch single-tenant. Backend resolves admin via ADM_EMAILS env-var.
// KAN-714 will resolve tenant from authenticated user via TeamMember.
const AXISONE_GROWTH_TENANT_ID = '9ca85088-f65b-4bac-b098-fff742281ede';

function getTenantId(): string {
  return AXISONE_GROWTH_TENANT_ID;
}

async function buildHeaders(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tenant-id': getTenantId(),
  };
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

/** Call a tRPC mutation (POST /trpc/<path> with JSON body) */
export async function trpcMutation<T = unknown>(
  path: string,
  input: Record<string, unknown>
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
  IngestRequest,
  IngestStatus,
} from "@growth/shared";

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
  targets: Array<{
    metric: TargetMetric;
    period: TargetPeriod;
    value: number;
    currentProgress: number | null;
  }>;
}

export interface PipelineDetail extends Omit<PipelineSummary, 'stageCount' | 'activeLeadCount' | 'targets'> {
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

export const pipelinesApi = {
  list: () => trpcQuery<PipelineSummary[]>('pipelines.list'),

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

  delete: (id: string) => trpcMutation<{ id: string }>('pipelines.delete', { id }),
};

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

/* ── Knowledge Ingestion API (KAN-707 PR A) ────────────────────────
 * Canonical contract types in @growth/shared (KAN-737). Consumer files import
 * IngestionPath / IngestRequest / IngestStatus directly from @growth/shared.
 */

export interface KnowledgeSourceListItem {
  id: string;
  type: 'url' | 'document' | 'qa_pair' | 'structured_field';
  status: 'pending' | 'processing' | 'indexed' | 'failed' | 'stale';
  sourceUrl: string | null;
  originalFileName: string | null;
  contentHash: string;
  lastIndexedAt: string | null;
  errorMessage: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeChunkPreview {
  id: string;
  chunkIndex: number;
  totalChunks: number;
  content: string;
  tokenCount: number;
  embeddingModel: string;
  createdAt: string;
}

export interface KnowledgeSourceDetail extends KnowledgeSourceListItem {
  uploadedFileRef: string | null;
  totalChunks: number;
  chunks: KnowledgeChunkPreview[];
  recentIngestions: Array<{
    ingestionId: string;
    status: string;
    startedAt: string | null;
    completedAt: string | null;
    createdAt: string;
  }>;
}

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

export const knowledgeIngestApi = {
  request: (input: IngestRequest) =>
    trpcMutation<{ ingestionId: string; sourceId: string; status: 'pending' }>(
      'knowledgeIngest.request',
      input as Record<string, unknown>,
    ),
  status: (ingestionId: string) =>
    trpcQuery<IngestStatus>('knowledgeIngest.status', { ingestionId }),
  listSources: (filter?: { type?: string; status?: string }) =>
    trpcQuery<KnowledgeSourceListItem[]>('knowledgeIngest.listSources', filter ?? {}),
  getSourceById: (sourceId: string, opts?: { chunkLimit?: number; chunkOffset?: number }) =>
    trpcQuery<KnowledgeSourceDetail>('knowledgeIngest.getSourceById', {
      sourceId,
      chunkLimit: opts?.chunkLimit ?? 20,
      chunkOffset: opts?.chunkOffset ?? 0,
    }),
  deleteSource: (sourceId: string) =>
    trpcMutation<{ sourceId: string }>('knowledgeIngest.deleteSource', { sourceId }),
};
