/**
 * growth API client — lightweight fetch wrapper for tRPC HTTP endpoints.
 *
 * The backend exposes tRPC over HTTP at /trpc/*. Queries are GET requests
 * with ?input=JSON, mutations are POST requests with JSON body.
 *
 * Auth: x-tenant-id header (dev stub for now — will switch to Firebase JWT).
 */

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://growth-api-1086551891973.us-central1.run.app';

// Dev tenant ID — replace with Firebase Auth context in production
const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000001';

function getTenantId(): string {
  // TODO: Replace with Firebase Auth → tenant resolution
  return DEV_TENANT_ID;
}

function headers(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'x-tenant-id': getTenantId(),
  };
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
  const res = await fetch(url.toString(), { headers: headers() });
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
    headers: headers(),
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
  type: 'email' | 'sms' | 'whatsapp';
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
    type: 'email' | 'sms' | 'whatsapp';
    provider: string;
    config?: Record<string, unknown>;
    status?: 'connected' | 'disconnected' | 'error';
  }) => trpcMutation<CommunicationChannel>('settings.channels.update', data),

  testChannel: (type: 'email' | 'sms' | 'whatsapp') =>
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
