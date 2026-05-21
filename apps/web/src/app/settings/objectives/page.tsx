/**
 * KAN-963 (slice 2a PR B) — /settings/objectives page entry.
 *
 * The user-facing declaration UX. AI proposes a ranked shortlist →
 * human picks + drag-prioritizes → adopts. The page also shows the
 * "Pipelines growth will run" downstream view (ready-now creatable
 * cards + needs-more-data honest gap cards).
 *
 * Reuses the page-shell + Card + Switch + Sticky-bottom-bar patterns
 * established by /settings/account/* (KAN-855) and the pipeline wizard
 * (Micro-objectives step + stages drag-reorder). No new design-system
 * primitives.
 */
import { ObjectivesDeclaration } from '@/components/objectives/objectives-declaration';

export default function ObjectivesSettingsPage() {
  return (
    <div className="max-w-4xl mx-auto p-6">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Objectives</h1>
        <p className="text-sm text-gray-600 mt-1">
          Declare what your business is pursuing — the AI proposes a prioritized list of objectives
          based on your data and the pipelines that operate them. You pick and rank; the engine
          routes new leads to your primary objective&apos;s pipeline.
        </p>
      </header>
      <ObjectivesDeclaration entityScope="contact" />
    </div>
  );
}
