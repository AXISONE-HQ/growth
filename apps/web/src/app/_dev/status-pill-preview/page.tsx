// PRE-PROD DEV PAGE — DO NOT SHIP TO PRODUCTION
// Visual verification surface for KAN-829 sub-cohort 2. Renders the 5 status
// pill states + a `useQuery` proof-of-life call to /api/knowledge/tier-limits.
// The leading underscore in the route segment (_dev) makes Next.js treat
// the entire `_dev/*` tree as a private directory excluded from routing
// in production builds (per Next.js App Router private folders convention).
'use client';

import { useQuery } from '@tanstack/react-query';
import { StatusPill, type StatusPillStatus } from '@/components/ui/knowledge/status-pill';

const STATUSES: StatusPillStatus[] = ['queued', 'embedding', 'ready', 'error', 'deleted'];

interface TierLimitsResponse {
  planTier: string;
  limits: {
    maxSources: number;
    maxPdfMB: number;
    allowsPdf: boolean;
    allowsFaq: boolean;
    allowedCategories: string[];
  };
  currentSourceCount: number;
  remaining: number;
}

export default function StatusPillPreview(): JSX.Element {
  // Proof-of-life: QueryClientProvider in layout.tsx is wired correctly when
  // this useQuery doesn't throw "No QueryClient set". The endpoint hit may
  // 401 (no Firebase token in dev preview) — that's expected; we only verify
  // the query runs, not that auth succeeds.
  const tierQuery = useQuery<TierLimitsResponse>({
    queryKey: ['kan-829-dev-preview-tier-limits'],
    queryFn: async () => {
      const res = await fetch('/api/knowledge/tier-limits');
      if (!res.ok) {
        // Don't throw — we just want to prove the query ran end-to-end
        return { planTier: 'unknown', limits: { maxSources: 0, maxPdfMB: 0, allowsPdf: false, allowsFaq: false, allowedCategories: [] }, currentSourceCount: 0, remaining: 0 };
      }
      return (await res.json()) as TierLimitsResponse;
    },
  });

  return (
    <main style={{ padding: 24, fontFamily: 'Inter, sans-serif' }}>
      <h1 style={{ fontSize: 24, fontWeight: 600, marginBottom: 16 }}>
        KAN-829 sub-cohort 2 — StatusPill preview
      </h1>
      <p style={{ color: 'var(--ds-ink-secondary)', marginBottom: 24 }}>
        Visual verification of the 5 status states using DS v1 tokens. Pulse
        animation on `embedding` respects prefers-reduced-motion.
      </p>

      <section style={{ display: 'flex', flexDirection: 'column', gap: 16, marginBottom: 32 }}>
        {STATUSES.map((status) => (
          <div key={status} style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <code style={{ width: 120, fontSize: 12, color: 'var(--ds-ink-tertiary)' }}>{status}</code>
            <StatusPill status={status} />
          </div>
        ))}
      </section>

      <section style={{ borderTop: '1px solid var(--ds-border-subtle)', paddingTop: 16 }}>
        <h2 style={{ fontSize: 16, fontWeight: 500, marginBottom: 8 }}>
          QueryClientProvider proof-of-life
        </h2>
        <pre style={{ fontSize: 11, background: 'var(--ds-surface-sunken)', padding: 12, borderRadius: 4 }}>
          status: {tierQuery.status}
          {tierQuery.data ? `\nplanTier: ${tierQuery.data.planTier}` : ''}
        </pre>
      </section>
    </main>
  );
}
