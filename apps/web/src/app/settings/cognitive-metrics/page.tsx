'use client';

/**
 * KAN-1087 (Tier 2 PR II) — Cognitive-metrics dashboard route.
 *
 * KAN-1100 (2026-06-05) — relocated from /internal/cognitive-metrics to
 * /settings/cognitive-metrics; surfaced as an admin-only moverLink in the
 * Settings hub (apps/web/src/app/settings/page.tsx). Three-layer admin
 * defense preserved + extended: server adminProcedure + page-level
 * useEffect redirect (this file) + nav-level conditional render. The
 * /internal/ namespace was removed (the directory was empty after the move).
 *
 * Internal observability page at /settings/cognitive-metrics. Surfaces the
 * Tier 1 audit payload aggregated by PR I (KAN-1086) for super-admin
 * forensic review of cognitive-engine quality.
 *
 * Admin gate (Phase 1 Anchor 2 reframe — three-layer post-KAN-1100):
 *   - Server side: adminProcedure on cognitiveMetrics.getMetrics tRPC
 *     procedure (apps/api/src/trpc.ts:116) authoritatively gates data via
 *     ADMIN_EMAILS allowlist. Non-admin tokens get FORBIDDEN.
 *   - Page side (this file): useEffect redirects non-admin to / so they
 *     don't see a broken page with FORBIDDEN errors. UX polish over the
 *     authoritative server gate.
 *   - Nav side (KAN-1100): Settings hub's moverLinks filter hides the
 *     link entirely from non-admins so they don't see what they can't
 *     access. See `apps/web/src/app/settings/page.tsx` moverLinks +
 *     `.filter((m) => !m.adminOnly || user?.role === 'admin')` idiom.
 *
 * apps/web has no server-side session adapter wired (Firebase auth via
 * AuthContext is client-only). The three-layer pattern is codebase-correct;
 * epic Phase 1's "server-component admin guard" framing was a Next.js-
 * convention default that didn't match codebase reality.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { CognitiveMetricsDashboard } from './_components/dashboard';

export default function CognitiveMetricsPage(): React.ReactElement {
  const router = useRouter();
  const { user, loading } = useAuth();

  React.useEffect(() => {
    if (!loading && (!user || user.role !== 'admin')) {
      router.replace('/');
    }
  }, [user, loading, router]);

  if (loading) {
    return (
      <main className="p-6">
        <div className="text-sm" style={{ color: 'var(--ds-ink-secondary)' }}>
          Loading…
        </div>
      </main>
    );
  }

  if (!user || user.role !== 'admin') {
    return <main className="p-6" />;
  }

  return (
    <main className="p-6">
      <CognitiveMetricsDashboard />
    </main>
  );
}
