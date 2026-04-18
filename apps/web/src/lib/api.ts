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
  'https://growth-web-1086551891973.us-central1.run.app';

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

/* ── Conversations API helpers ──────────────────────────────── */

export interface Conversation {
  id: string;
  tenantId: string;
  contactId: string;
  channel: string;
  status: string;
  aiHandled: boolean;
  createdAt: string;
  updatedAt: string;
  messages?: ConversationMessage[];
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderType: 'human' | 'ai' | 'system';
  content: string;
  channel: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export const conversationsApi = {
  list: (params?: { contactId?: string; channel?: string; status?: string; limit?: number; offset?: number }) =>
    trpcQuery<{ conversations: Conversation[]; total: number }>('conversations.list', params || {}),

  getById: (id: string) =>
    trpcQuery<Conversation>('conversations.getById', { id }),

  create: (data: { contactId: string; channel: string; status?: string }) =>
    trpcMutation<Conversation>('conversations.create', data),

  addMessage: (data: { conversationId: string; senderId: string; senderType: 'human' | 'ai' | 'system'; content: string; metadata?: Record<string, unknown> }) =>
    trpcMutation<ConversationMessage>('conversations.addMessage', data),

  updateStatus: (data: { id: string; status: string; aiHandled?: boolean }) =>
    trpcMutation<Conversation>('conversations.updateStatus', data),
};

/* ── Settings API helpers ──────────────────────────────── */

export interface TenantSetting {
  id: string;
  tenantId: string;
  category: string;
  key: string;
  value: unknown;
  createdAt: string;
  updatedAt: string;
}

export const settingsApi = {
  listByCategory: (category: string) =>
    trpcQuery<TenantSetting[]>('settings.listByCategory', { category }),

  get: (category: string, key: string) =>
    trpcQuery<TenantSetting | null>('settings.get', { category, key }),

  upsert: (data: { category: string; key: string; value: unknown }) =>
    trpcMutation<TenantSetting>('settings.upsert', data),

  delete: (category: string, key: string) =>
    trpcMutation<TenantSetting>('settings.delete', { category, key }),
};
