/**
 * growth API client — lightweight fetch wrapper for tRPC HTTP endpoints.
 *
 * The backend exposes tRPC over HTTP at /trpc/*. Queries are GET requests
 * with ?input=JSON, mutations are POST requests with JSON body.
 *
 * Auth: Firebase JWT token in Authorization header + x-tenant-id header.
 */

import { auth } from './firebase';

const API_BASE =
  process.env.NEXT_PUBLIC_API_URL ||
  'https://growth-api-1086551891973.us-central1.run.app';

// Dev tenant ID — used as fallback until tenant resolution is wired
const DEV_TENANT_ID = '00000000-0000-0000-0000-000000000001';

function getTenantId(): string {
  // TODO: Replace with real tenant resolution from user profile / DB
  return DEV_TENANT_ID;
}

async function headers(): Promise<Record<string, string>> {
  const h: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-tenant-id': getTenantId(),
  };

  // Attach Firebase JWT if user is authenticated
  const user = auth.currentUser;
  if (user) {
    try {
      const token = await user.getIdToken();
      h['Authorization'] = `Bearer ${token}`;
    } catch {
      // User may have been signed out — continue without token
    }
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
  const res = await fetch(url.toString(), { headers: await headers() });
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
    headers: await headers(),
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

// Conversations API (stub - will be wired to backend)
export const conversationsApi = {
  list: async (params?: { limit?: number }): Promise<any> => {
    try {
      return await trpcQuery('conversations.list', params);
    } catch {
      return [];
    }
  },
  getById: async (id: string): Promise<any> => {
    try {
      return await trpcQuery('conversations.getById', { id });
    } catch {
      return null;
    }
  },
};


// Settings API (stub - will be wired to backend)
export const settingsApi = {
  get: async (): Promise<any> => {
    try {
      return await trpcQuery('settings.get');
    } catch {
      return null;
    }
  },
  update: async (data: any): Promise<any> => {
    try {
      return await trpcMutation('settings.update', data);
    } catch {
      return null;
    }
  },
};
/* ── Competitor Intelligence API helpers ──────────────────── */

// Types matching the Prisma models
export interface Competitor {
  id: string;
  tenantId: string;
  name: string;
  website: string;
  description: string | null;
  logoUrl: string | null;
  employeeCount: number | null;
  customerCount: number | null;
  annualRevenue: string | null;
  segment: string | null;
  status: 'active' | 'inactive' | 'archived';
  metadata: Record<string, unknown>;
  lastAnalyzedAt: string | null;
  createdAt: string;
  updatedAt: string;
  battleCards?: CompetitorBattleCard[];
  news?: CompetitorNews[];
  _count?: { news: number };
}

export interface CompetitorBattleCard {
  id: string;
  competitorId: string;
  overview: string;
  strengths: string[];
  weaknesses: string[];
  differentiators: string[];
  objections: string[];
  talkingPoints: string[];
  version: number;
  generatedAt: string;
  createdAt: string;
}

export interface CompetitorNews {
  id: string;
  competitorId: string;
  title: string;
  summary: string;
  sourceUrl: string | null;
  publishedAt: string | null;
  sentiment: 'positive' | 'negative' | 'neutral';
  relevanceScore: number;
  createdAt: string;
}

export interface CompetitorStats {
  totalCompetitors: number;
  activeCompetitors: number;
  totalNews: number;
  recentNews: CompetitorNews[];
}

export const competitorsApi = {
  // List competitors with search, filter, pagination
  list: (params?: { page?: number; limit?: number; search?: string; status?: string }) =>
    trpcQuery<{ competitors: Competitor[]; pagination: { page: number; limit: number; total: number; pages: number } }>(
      'competitors.list', params || {}
    ),

  // Get single competitor with full battle cards and news
  getById: (id: string) =>
    trpcQuery<Competitor>('competitors.getById', { id }),

  // Get battle card for a competitor
  getBattleCard: (competitorId: string) =>
    trpcQuery<CompetitorBattleCard | null>('competitors.getBattleCard', { competitorId }),

  // List news for a competitor
  listNews: (params: { competitorId: string; page?: number; limit?: number }) =>
    trpcQuery<{ news: CompetitorNews[]; pagination: { page: number; limit: number; total: number; pages: number } }>(
      'competitors.listNews', params
    ),

  // Get dashboard stats
  getStats: () =>
    trpcQuery<CompetitorStats>('competitors.getStats'),

  // Create a new competitor
  create: (data: { name: string; website: string; description?: string; segment?: string }) =>
    trpcMutation<Competitor>('competitors.create', data),

  // Update a competitor
  update: (data: { id: string; name?: string; website?: string; description?: string; status?: string; segment?: string }) =>
    trpcMutation<Competitor>('competitors.update', data),

  // Delete (archive) a competitor
  delete: (id: string) =>
    trpcMutation<Competitor>('competitors.delete', { id }),

  // Create or update battle card
  upsertBattleCard: (data: {
    competitorId: string; overview: string; strengths: string[];
    weaknesses: string[]; differentiators: string[]; objections: string[]; talkingPoints: string[];
  }) => trpcMutation<CompetitorBattleCard>('competitors.upsertBattleCard', data),

  // Add news item
  addNews: (data: {
    competitorId: string; title: string; summary: string;
    sourceUrl?: string; publishedAt?: string; sentiment?: string;
  }) => trpcMutation<CompetitorNews>('competitors.addNews', data),
};
