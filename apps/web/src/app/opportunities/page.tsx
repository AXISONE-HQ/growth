'use client';

/**
 * KAN-886 — /opportunities Tabs host (Cohort 1 PR 3).
 *
 * Thin shell hosting two read-only views:
 *
 *   1. AI Segments — the Day-1 Wedge surface (KAN-655 + KAN-657 +
 *      KAN-649). Groups Contacts by signal pattern (dormant_reactivation,
 *      high_intent_no_touch, data_enrichment) and offers playbook
 *      launch buttons. Pure refactor — moved verbatim from the prior
 *      single-file page.tsx into `_components/ai-segments-view.tsx`
 *      with regression-protection snapshot tests.
 *
 *   2. All Deals — flat enumeration of `deals.list` from KAN-883.
 *      6-column sortable table with status filter + name search.
 *      Net-new; complements (does not replace) AI Segments.
 *
 * Tab state: internal useState. No URL persistence in V1 — sharing a
 * specific tab via URL is trivial to add later (?tab=all-deals) if
 * demand emerges; not filed as a follow-up to keep the backlog tight.
 */

import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { AiSegmentsView } from './_components/ai-segments-view';
import { AllDealsView } from './_components/all-deals-view';

type TabValue = 'ai-segments' | 'all-deals';

export default function OpportunitiesPage() {
  const [tab, setTab] = useState<TabValue>('ai-segments');

  return (
    <div>
      {/* Tab bar — kept light-themed (the surrounding chrome from app
         layout.tsx is white/gray; AI Segments inner content keeps its
         dark-themed slate-900 design for now). PR 4+ can normalize the
         color scheme if Cowork wants. */}
      <div className="bg-white border-b border-gray-200 px-6 py-3">
        <Tabs value={tab} onValueChange={(v) => setTab(v as TabValue)}>
          <TabsList>
            <TabsTrigger value="ai-segments">AI Segments</TabsTrigger>
            <TabsTrigger value="all-deals">All Deals</TabsTrigger>
          </TabsList>
          <TabsContent value="ai-segments">
            <AiSegmentsView />
          </TabsContent>
          <TabsContent value="all-deals">
            <AllDealsView />
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
