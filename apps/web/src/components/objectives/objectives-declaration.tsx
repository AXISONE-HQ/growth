'use client';

/**
 * KAN-963 (slice 2a PR B) — Objective declaration UX.
 *
 * Two-phase screen:
 *   Phase A: AI proposes a ranked shortlist → user toggles "select" on
 *            each card → drag-prioritize the selected ones → "Adopt"
 *            calls `objectives.adopt` (replace-all per entityScope).
 *   Phase B: After adopt (or page reload with existing declaration),
 *            "Pipelines growth will run" cards render the bound
 *            objectives' proposed pipelines. Ready-now cards have an
 *            (out-of-scope-for-PR-B) "Create" affordance; needs-more-data
 *            cards show the honest gap message verbatim.
 *
 * Slice 2a writes to entityScope='contact' only. Slice 5 will add tab
 * navigation for Order/Company/Deal scopes; the data model already
 * supports per-scope independently.
 *
 * Free-tier gating: at most ONE primary (priority=1) in this UX. The
 * data model allows multiple priorities — the UI enforces the 1-primary
 * rule and surfaces secondaries at priority=2+.
 */
import { useState, useMemo, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical, AlertCircle, CheckCircle2, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Card, CardContent } from '@/components/ui/card';
import {
  objectivesApi,
  type ObjectiveEntityScope,
  type ProposedPipeline,
} from '@/lib/api';

interface ObjectivesDeclarationProps {
  entityScope: ObjectiveEntityScope;
}

/**
 * Local picked-state shape: maps objectiveId → user-chosen rank.
 * Rank starts at 1 (primary). UI enforces "exactly one primary" by
 * re-numbering after every toggle/drag.
 */
type PickedMap = Map<string, number>; // objectiveId → priority

export function ObjectivesDeclaration({ entityScope }: ObjectivesDeclarationProps) {
  const queryClient = useQueryClient();

  const { data: proposeData, isLoading: proposeLoading, error: proposeError } = useQuery({
    queryKey: ['objectives', 'propose', entityScope],
    queryFn: () => objectivesApi.propose(entityScope),
    // No automatic refetch on focus — propose is a deterministic compute,
    // not a live signal. The user re-runs it explicitly by reloading.
    refetchOnWindowFocus: false,
  });

  const proposals = useMemo(
    () => (proposeData?.proposals ?? []) as ProposedPipeline[],
    [proposeData],
  );

  // Local pick state. Initialized from proposer's suggestedPriority on
  // first load + every time proposals change (e.g., after a successful
  // propose refetch).
  const [picked, setPicked] = useState<PickedMap>(new Map());

  useEffect(() => {
    // Initialize selection state ONCE per propose-load. Don't clobber
    // user's local drag-rearrangement after a query refetch on tab
    // refocus (refetchOnWindowFocus is off anyway).
    if (picked.size === 0 && proposals.length > 0) {
      // Auto-select only the top-ranked ready proposal as primary by
      // default. User opts in for secondaries.
      const top = proposals.find((p) => p.dataSufficiency === 'ready');
      if (top) {
        setPicked(new Map([[top.objectiveId, 1]]));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposals.length]);

  const adoptMutation = useMutation({
    mutationFn: (selections: Array<{ objectiveId: string; priority: number }>) =>
      objectivesApi.adopt(entityScope, selections),
    onSuccess: () => {
      // Invalidate downstream queries that depend on the declaration
      // (Phase B "Pipelines growth will run" + future declaration-list
      // surfaces).
      queryClient.invalidateQueries({ queryKey: ['objectives'] });
    },
  });

  // ── Derived: sorted picked list for the drag-prioritize section ──
  const sortedPicked = useMemo(() => {
    return Array.from(picked.entries())
      .sort((a, b) => a[1] - b[1])
      .map(([objectiveId, priority]) => ({
        objectiveId,
        priority,
        proposal: proposals.find((p) => p.objectiveId === objectiveId)!,
      }))
      .filter((entry) => entry.proposal); // defensive — drop stale ids on refetch
  }, [picked, proposals]);

  const togglePick = (objectiveId: string) => {
    const next = new Map(picked);
    if (next.has(objectiveId)) {
      next.delete(objectiveId);
    } else {
      // Append at the end (lowest priority). Re-number to be 1..N.
      next.set(objectiveId, next.size + 1);
    }
    // Re-number 1..N to keep priorities dense after toggles.
    const renumbered = new Map<string, number>();
    const sorted = Array.from(next.entries()).sort((a, b) => a[1] - b[1]);
    sorted.forEach(([id], idx) => renumbered.set(id, idx + 1));
    setPicked(renumbered);
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const oldIdx = sortedPicked.findIndex((s) => s.objectiveId === active.id);
    const newIdx = sortedPicked.findIndex((s) => s.objectiveId === over.id);
    if (oldIdx < 0 || newIdx < 0) return;
    const reordered = arrayMove(sortedPicked, oldIdx, newIdx);
    const next = new Map<string, number>();
    reordered.forEach((s, idx) => next.set(s.objectiveId, idx + 1));
    setPicked(next);
  };

  const handleAdopt = () => {
    const selections = Array.from(picked.entries()).map(([objectiveId, priority]) => ({
      objectiveId,
      priority,
    }));
    adoptMutation.mutate(selections);
  };

  // ── Loading / error states ──
  if (proposeLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-gray-600 py-12">
        <Loader2 className="w-4 h-4 animate-spin" />
        Analyzing your data to propose objectives…
      </div>
    );
  }

  if (proposeError) {
    return (
      <Card className="border-red-200 bg-red-50">
        <CardContent className="pt-6 text-sm text-red-800">
          Couldn&apos;t load proposals: {(proposeError as Error).message}
        </CardContent>
      </Card>
    );
  }

  if (proposals.length === 0) {
    return (
      <Card>
        <CardContent className="pt-6 text-sm text-gray-700">
          No objective catalog seeded for this tenant yet. Reach out to ops if you need the
          generic catalog initialized.
        </CardContent>
      </Card>
    );
  }

  const adoptDisabled = adoptMutation.isPending || picked.size === 0;

  return (
    <div className="space-y-8 pb-24" data-testid="objectives-declaration">
      {/* Phase A — Propose + pick */}
      <section>
        <h2 className="text-lg font-medium mb-3">Suggested objectives</h2>
        <p className="text-sm text-gray-600 mb-4">
          Based on your data + business profile. Toggle any to add to your declaration.
        </p>
        <div className="space-y-2">
          {proposals.map((proposal) => {
            const isPicked = picked.has(proposal.objectiveId);
            return (
              <Card
                key={proposal.objectiveId}
                className={isPicked ? 'border-indigo-300 bg-indigo-50/40' : undefined}
              >
                <CardContent className="pt-4 pb-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <h3 className="font-medium">{proposal.objectiveName}</h3>
                        <SufficiencyBadge sufficiency={proposal.dataSufficiency} />
                      </div>
                      <p className="text-sm text-gray-700 mt-1">{proposal.reason}</p>
                      <p className="text-xs text-gray-500 mt-2" data-testid="evidence">
                        Based on: {proposal.evidence.description} — found{' '}
                        <span className="font-medium">{proposal.evidence.count}</span> (need ≥{' '}
                        {proposal.evidence.threshold} to operate).
                      </p>
                      {proposal.needed ? (
                        <p className="text-xs text-amber-700 mt-1" data-testid="needed-msg">
                          {proposal.needed}
                        </p>
                      ) : null}
                    </div>
                    <Switch
                      checked={isPicked}
                      onCheckedChange={() => togglePick(proposal.objectiveId)}
                      aria-label={`Select objective ${proposal.objectiveName}`}
                    />
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Phase A.5 — Drag-prioritize the selected */}
      {sortedPicked.length > 0 ? (
        <section>
          <h2 className="text-lg font-medium mb-1">Your prioritized declaration</h2>
          <p className="text-sm text-gray-600 mb-4">
            Drag to reorder. The top of the list (priority 1) is your primary objective — new
            leads route through its pipeline. Items below are secondary.
          </p>
          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext
              items={sortedPicked.map((s) => s.objectiveId)}
              strategy={verticalListSortingStrategy}
            >
              <ol className="space-y-2">
                {sortedPicked.map((entry) => (
                  <SortableRow key={entry.objectiveId} entry={entry} />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        </section>
      ) : null}

      {/* Phase B — Pipelines growth will run */}
      {sortedPicked.length > 0 ? (
        <section>
          <h2 className="text-lg font-medium mb-1">Pipelines growth will run</h2>
          <p className="text-sm text-gray-600 mb-4">
            What the engine plans to operate for each declared objective.
          </p>
          <div className="space-y-2">
            {sortedPicked.map((entry) => (
              <ProposedPipelineCard key={entry.objectiveId} proposal={entry.proposal} />
            ))}
          </div>
        </section>
      ) : null}

      {/* Sticky-bottom Adopt bar */}
      <div className="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 px-6 py-4 z-10">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="text-sm text-gray-600">
            {picked.size === 0
              ? 'Select at least one objective to declare.'
              : `${picked.size} objective${picked.size === 1 ? '' : 's'} selected — ${
                  sortedPicked[0]?.proposal?.objectiveName ?? 'top pick'
                } as primary.`}
          </div>
          <Button
            onClick={handleAdopt}
            disabled={adoptDisabled}
            data-testid="adopt-button"
          >
            {adoptMutation.isPending ? 'Adopting…' : 'Adopt declaration'}
          </Button>
        </div>
      </div>

      {adoptMutation.isSuccess ? (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="pt-4 pb-4 text-sm text-green-800 flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" />
            Declaration saved. New leads will route through your primary objective&apos;s pipeline
            once it&apos;s created.
          </CardContent>
        </Card>
      ) : null}
      {adoptMutation.isError ? (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="pt-4 pb-4 text-sm text-red-800 flex items-center gap-2">
            <AlertCircle className="w-4 h-4" />
            Couldn&apos;t save: {(adoptMutation.error as Error).message}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Sortable row for the drag-prioritize section.
// ─────────────────────────────────────────────────────────────────────

interface SortableEntry {
  objectiveId: string;
  priority: number;
  proposal: ProposedPipeline;
}

function SortableRow({ entry }: { entry: SortableEntry }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: entry.objectiveId,
  });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };
  return (
    <li
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-3 bg-white border rounded-lg p-3"
    >
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-gray-400 hover:text-gray-600"
        aria-label="Drag to reorder"
      >
        <GripVertical className="w-4 h-4" />
      </button>
      <span className="text-sm font-medium text-gray-500 w-12">
        {entry.priority === 1 ? 'Primary' : `#${entry.priority}`}
      </span>
      <span className="flex-1 text-sm font-medium">{entry.proposal.objectiveName}</span>
      <SufficiencyBadge sufficiency={entry.proposal.dataSufficiency} />
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────
// "Pipelines growth will run" cards (Phase B).
// ─────────────────────────────────────────────────────────────────────

function ProposedPipelineCard({ proposal }: { proposal: ProposedPipeline }) {
  const ready = proposal.dataSufficiency === 'ready';
  return (
    <Card className={ready ? 'border-green-200' : 'border-amber-200 bg-amber-50/30'}>
      <CardContent className="pt-4 pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="font-medium">{proposal.proposedName}</h3>
              <SufficiencyBadge sufficiency={proposal.dataSufficiency} />
            </div>
            <p className="text-sm text-gray-700 mt-1">{proposal.reason}</p>
            {proposal.needed ? (
              <p className="text-xs text-amber-700 mt-2">{proposal.needed}</p>
            ) : (
              <p className="text-xs text-gray-500 mt-2">
                Stages: {proposal.proposedStages.map((s) => s.name).join(' → ')}
              </p>
            )}
          </div>
          {/* Out-of-scope-for-PR-B: actual "Create pipeline" handoff. The button
              is a placeholder showing the future state — disabled until the
              pipeline-create flow accepts proposer output (slice 3 wiring). */}
          <Button variant="outline" size="sm" disabled title="Pipeline creation lands in slice 3">
            {ready ? 'Create' : 'Pending data'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function SufficiencyBadge({ sufficiency }: { sufficiency: 'ready' | 'needs_more_data' }) {
  if (sufficiency === 'ready') {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-green-700 bg-green-100 px-2 py-0.5 rounded-full">
        <CheckCircle2 className="w-3 h-3" />
        Ready
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-100 px-2 py-0.5 rounded-full">
      <AlertCircle className="w-3 h-3" />
      Needs more data
    </span>
  );
}
