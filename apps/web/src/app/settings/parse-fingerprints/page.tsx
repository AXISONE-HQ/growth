'use client';

/**
 * KAN-1140 Phase 3 PR 7 — Parser Patterns dashboard.
 *
 * Per-tenant parse-fingerprint aggregation surface. Operators triage
 * recurring inbound patterns: which formats / languages / vendors
 * recur, which keep failing parse confidence (high escalation_count),
 * which the operator has already corrected (high reclassify_count).
 *
 * Authority gate (Q-ADD-4 lock): protectedProcedure at the backend
 * (NOT adminProcedure). Every operator within a tenant can see THEIR
 * tenant's parser patterns — operational visibility, not cross-tenant
 * forensics. Mirrors auditLog / brain.getSnapshot tenant-scoped gating.
 *
 * Distinct from /settings/cognitive-metrics which IS adminProcedure /
 * super-admin because that surface cross-aggregates tenants.
 */
import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/AuthContext';
import { ParserPatternsDashboard } from './_components/dashboard';

export default function ParserPatternsPage(): React.ReactElement {
  const router = useRouter();
  const { user, loading } = useAuth();

  React.useEffect(() => {
    // protectedProcedure gate is at the backend; this is just a
    // signed-in check (any tenant operator passes). Unauthenticated
    // users get redirected to home so the empty page doesn't render.
    if (!loading && !user) {
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

  if (!user) {
    return <main className="p-6" />;
  }

  return (
    <main className="p-6">
      <ParserPatternsDashboard />
    </main>
  );
}
