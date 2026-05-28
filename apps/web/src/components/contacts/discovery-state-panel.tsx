/**
 * M3-1c — Discovery State panel (contact-detail).
 *
 * Renders the engine's per-contact gap-state — which sub-objectives are
 * known/partial/unknown/not_applicable + the "Asking next" intent line
 * so operators understand WHY the engine produces the suggestions in
 * the M1 queue.
 *
 * Doctrine: visually distinct chrome ("engine view") so it reads as
 * the engine's perspective on the contact, not muted metadata. Manual
 * fill via inline typed input is the FALLBACK path; engine generation
 * + future extraction/enrichment are primary.
 */
'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Sparkles, Check, HelpCircle, MinusCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  subObjectivesApi,
  type DiscoveryStateForContact,
  type DiscoveryStatePrioritizedGap,
  type SubObjectiveStateValue,
} from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';

interface DiscoveryStatePanelProps {
  contactId: string;
}

export function DiscoveryStatePanel({ contactId }: DiscoveryStatePanelProps) {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['subObjectives', 'getStateForContact', contactId],
    queryFn: () => subObjectivesApi.getStateForContact(contactId),
  });

  if (isLoading) {
    return (
      <div className="rounded-[var(--ds-radius-card)] border border-[var(--ds-border)] bg-[var(--ds-surface-sunken)] p-4">
        <DiscoveryHeader />
        <p className="mt-2 text-caption text-muted-foreground">Loading discovery state…</p>
      </div>
    );
  }
  if (isError || !data) {
    return (
      <div className="rounded-[var(--ds-radius-card)] border border-[var(--ds-border)] bg-[var(--ds-surface-sunken)] p-4">
        <DiscoveryHeader />
        <p className="mt-2 text-caption text-muted-foreground">Discovery state unavailable.</p>
      </div>
    );
  }

  return (
    <div className="rounded-[var(--ds-radius-card)] border border-[var(--ds-border)] bg-[var(--ds-surface-sunken)] p-4">
      <DiscoveryHeader />
      <p className="mt-1 text-caption text-muted-foreground" data-testid="discovery-engine-intent">
        {engineIntentLine(data)}
      </p>
      <ul className="mt-3 flex flex-col gap-2" data-testid="discovery-sub-objective-rows">
        {data.prioritizedGaps.length === 0 ? (
          <PanelEmptyState />
        ) : null}
        {data.prioritizedGaps.map((gap) => (
          <SubObjectiveRow key={gap.key} gap={gap} contactId={contactId} />
        ))}
      </ul>
    </div>
  );
}

// "Engine view" header chrome — Sparkles icon + small label to differentiate
// from data cards. Designer eyeball at Phase 4.
function DiscoveryHeader() {
  return (
    <div className="flex items-center gap-2">
      <Sparkles className="h-4 w-4 text-primary" aria-hidden />
      <h3 className="text-label font-medium text-foreground">Discovery state</h3>
      <span className="ml-auto text-caption uppercase tracking-wide text-muted-foreground">Engine view</span>
    </div>
  );
}

// Founder-confirmed copy:
//   Hard-trigger:     Asking next: <label> — required to advance to <stage>.
//   Soft-trigger:     Asking next: <label>
//   No active gap:    No active discovery target — engine continues with routine actions.
//   No gaps seeded:   Awaiting first decision-run.
function engineIntentLine(state: DiscoveryStateForContact): string {
  if (state.prioritizedGaps.length === 0) {
    // Either zero seeded yet, or all known/not_applicable. The per-row
    // empty-state below distinguishes.
    return 'Awaiting first decision-run.';
  }
  const top = state.topCandidate;
  if (!top) {
    return 'No active discovery target — engine continues with routine actions.';
  }
  // Founder-confirmed: soft-threshold below-0.6 also reads as "no active",
  // distinction collapses on the headline (per-row icons carry the detail).
  if (top.score < 0.6 && !top.hardTrigger) {
    return 'No active discovery target — engine continues with routine actions.';
  }
  const stageNote = top.hardTrigger
    ? state.prioritizedGaps.find((g) => g.key === top.key)?.requiredAtStage
    : undefined;
  if (top.hardTrigger && stageNote) {
    return `Asking next: ${top.label} — required to advance to ${stageNote}.`;
  }
  return `Asking next: ${top.label}`;
}

function PanelEmptyState() {
  return (
    <li className="text-caption text-muted-foreground">
      The engine will start tracking discovery state as conversations progress.
    </li>
  );
}

function SubObjectiveRow({
  gap,
  contactId,
}: {
  gap: DiscoveryStatePrioritizedGap;
  contactId: string;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="flex items-start gap-3" data-testid={`discovery-row-${gap.key}`}>
      <StateIcon state={gap.state} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-body text-foreground">{gap.label}</span>
          {gap.state === 'partial' && gap.valueIfPartial ? (
            <span className="text-caption text-muted-foreground italic">"{gap.valueIfPartial}"</span>
          ) : null}
        </div>
        {editing ? (
          <EditRow gap={gap} contactId={contactId} onClose={() => setEditing(false)} />
        ) : (
          <RowControls
            gap={gap}
            onEdit={() => setEditing(true)}
          />
        )}
      </div>
    </li>
  );
}

function StateIcon({ state }: { state: SubObjectiveStateValue }) {
  if (state === 'known') return <Check className="mt-1 h-4 w-4 text-emerald-600" aria-label="known" />;
  if (state === 'partial') return <HelpCircle className="mt-1 h-4 w-4 text-amber-600" aria-label="partial" />;
  if (state === 'not_applicable') return <MinusCircle className="mt-1 h-4 w-4 text-muted-foreground" aria-label="not applicable" />;
  return <HelpCircle className="mt-1 h-4 w-4 text-muted-foreground" aria-label="unknown" />;
}

function RowControls({ gap, onEdit }: { gap: DiscoveryStatePrioritizedGap; onEdit: () => void }) {
  if (gap.state === 'known' || gap.state === 'not_applicable') {
    return (
      <button
        type="button"
        onClick={onEdit}
        className="text-caption text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
      >
        update
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onEdit}
      className="text-caption text-primary hover:underline"
    >
      mark known
    </button>
  );
}

function EditRow({
  gap,
  contactId,
  onClose,
}: {
  gap: DiscoveryStatePrioritizedGap;
  contactId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState<string>('');
  const transitionMutation = useMutation({
    mutationFn: subObjectivesApi.transitionState,
    onSuccess: () => {
      toast.success('Discovery state updated.');
      void qc.invalidateQueries({ queryKey: ['subObjectives', 'getStateForContact', contactId] });
      onClose();
    },
    onError: (err: Error) => {
      toast.error(err.message ?? 'Update failed.');
    },
  });

  const submit = (toState: 'known' | 'not_applicable') => {
    transitionMutation.mutate({
      contactId,
      subObjectiveKey: gap.key as 'timeline' | 'budget' | 'authority' | 'need' | 'motivation',
      toState,
      value: toState === 'known' ? value : null,
    });
  };

  return (
    <div className="mt-1 flex flex-col gap-2" data-testid={`discovery-edit-${gap.key}`}>
      <div className="flex items-center gap-2">
        {gap.valueType === 'enum' ? (
          <Select value={value} onValueChange={setValue}>
            <SelectTrigger className="h-8 max-w-[220px]">
              <SelectValue placeholder="Select…" />
            </SelectTrigger>
            <SelectContent>
              {/* MVP: free-form text inputs since the default Generic-B2B set
                  doesn't ship per-key enum options. Future Blueprint loader
                  ships option lists per sub-objective. */}
              <SelectItem value="yes">Yes</SelectItem>
              <SelectItem value="no">No</SelectItem>
              <SelectItem value="unknown">Unsure</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Input
            type={gap.valueType === 'date' ? 'date' : gap.valueType === 'numeric' ? 'number' : 'text'}
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={gap.label}
            className="h-8 max-w-[260px]"
            data-testid={`discovery-edit-input-${gap.key}`}
          />
        )}
        <Button
          size="sm"
          onClick={() => submit('known')}
          disabled={transitionMutation.isPending || !value}
          data-testid={`discovery-edit-save-${gap.key}`}
        >
          Save
        </Button>
        <button
          type="button"
          onClick={onClose}
          className="text-caption text-muted-foreground hover:text-foreground"
        >
          cancel
        </button>
      </div>
      <button
        type="button"
        onClick={() => submit('not_applicable')}
        disabled={transitionMutation.isPending}
        className="self-start text-caption text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
        data-testid={`discovery-edit-na-${gap.key}`}
      >
        or mark not applicable
      </button>
    </div>
  );
}
