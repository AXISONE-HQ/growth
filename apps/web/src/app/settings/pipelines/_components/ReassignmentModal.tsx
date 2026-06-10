"use client";

/**
 * KAN-1169 — Reassignment modal for pipeline delete.
 *
 * Drives 5 copy variants based on `pipelines.previewDelete` payload:
 *
 *   1. Loading — initial fetch in flight
 *   2. Block — `blockReason` set ('last_pipeline' | 'default_assignment')
 *   3. Empty hard-delete — dealCount === 0 + hasStageHistory === false
 *   4. Empty soft-archive — dealCount === 0 + hasStageHistory === true
 *   5. Reassign — dealCount > 0 (destination picker + initial-stage indicator)
 *
 * Option C semantic: when hasStageHistory is true, pipeline is soft-archived
 * (isActive=false) instead of hard-deleted. Deal-scoped retrospective stays
 * intact (DealStageHistory.toStageId Restrict honors the audit_log NEVER
 * deleted precedent).
 *
 * Mounted by the Settings/Pipelines list page (per-card delete) AND by the
 * detail page (header Delete button) — same modal, single source of truth.
 */

import * as React from "react";
import { Loader2, AlertCircle, Archive, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { pipelinesApi, type PipelineDeletePreview, type PipelineDeleteResult } from "@/lib/api";

export function ReassignmentModal({
  pipelineId,
  open,
  onOpenChange,
  onDeleted,
}: {
  pipelineId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (result: PipelineDeleteResult) => void;
}): React.ReactElement | null {
  const [preview, setPreview] = React.useState<PipelineDeletePreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [reassignTo, setReassignTo] = React.useState<string>("");
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  // Fetch preview on open + reset on close.
  React.useEffect(() => {
    if (!open || !pipelineId) {
      setPreview(null);
      setPreviewError(null);
      setReassignTo("");
      setSubmitError(null);
      return;
    }
    let cancelled = false;
    pipelinesApi
      .previewDelete(pipelineId)
      .then((p) => {
        if (!cancelled) {
          setPreview(p);
          // Default to first destination so the operator only needs to confirm.
          if (p.destinations.length > 0 && p.destinations[0]) {
            setReassignTo(p.destinations[0].id);
          }
        }
      })
      .catch((e) => {
        if (!cancelled) setPreviewError((e as Error)?.message ?? "Failed to load");
      });
    return () => {
      cancelled = true;
    };
  }, [open, pipelineId]);

  async function handleConfirm() {
    if (!preview) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const result = await pipelinesApi.delete({
        pipelineId: preview.source.id,
        reassignTo: preview.dealCount > 0 ? reassignTo : null,
      });
      onDeleted(result);
      onOpenChange(false);
    } catch (e) {
      setSubmitError((e as Error)?.message ?? "Delete failed");
      setSubmitting(false);
    }
  }

  if (!open || !pipelineId) return null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Delete pipeline</SheetTitle>
          <SheetDescription>Review impact before confirming.</SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {previewError ? (
            <div className="flex items-start gap-2 rounded border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{previewError}</span>
            </div>
          ) : !preview ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading impact analysis…
            </div>
          ) : preview.blockReason ? (
            <BlockedBody preview={preview} />
          ) : preview.dealCount > 0 ? (
            <ReassignBody
              preview={preview}
              reassignTo={reassignTo}
              setReassignTo={setReassignTo}
            />
          ) : preview.hasStageHistory ? (
            <EmptyArchiveBody preview={preview} />
          ) : (
            <EmptyDeleteBody preview={preview} />
          )}

          {submitError ? (
            <div className="flex items-start gap-2 rounded border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{submitError}</span>
            </div>
          ) : null}
        </div>

        <SheetFooter className="mt-6 flex-row justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          {preview && !preview.blockReason ? (
            <Button
              type="button"
              variant="destructive"
              onClick={handleConfirm}
              disabled={submitting || (preview.dealCount > 0 && !reassignTo)}
            >
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Working…
                </>
              ) : preview.hasStageHistory || preview.dealCount > 0 ? (
                <>
                  <Archive className="h-4 w-4" />
                  {preview.dealCount > 0
                    ? `Move ${preview.dealCount} deals + archive`
                    : `Archive pipeline`}
                </>
              ) : (
                <>
                  <Trash2 className="h-4 w-4" />
                  Delete pipeline
                </>
              )}
            </Button>
          ) : null}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

// ─────────────────────────────────────────────
// Body variants
// ─────────────────────────────────────────────

function BlockedBody({ preview }: { preview: PipelineDeletePreview }): React.ReactElement {
  const reason =
    preview.blockReason === 'last_pipeline'
      ? `"${preview.source.name}" is your tenant's only active pipeline. Inbound leads need somewhere to land — create another pipeline first, then delete this one.`
      : `"${preview.source.name}" is the tenant's default-assignment pipeline. Change the default-assignment in Tenant Settings first, then delete this one.`;
  return (
    <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
      <div className="font-medium">Cannot delete</div>
      <div className="mt-1">{reason}</div>
    </div>
  );
}

function EmptyDeleteBody({ preview }: { preview: PipelineDeletePreview }): React.ReactElement {
  return (
    <p className="text-sm">
      Delete pipeline <strong>{preview.source.name}</strong>? This action cannot be undone.
    </p>
  );
}

function EmptyArchiveBody({ preview }: { preview: PipelineDeletePreview }): React.ReactElement {
  return (
    <div className="space-y-2 text-sm">
      <p>
        Pipeline <strong>{preview.source.name}</strong> is empty but has stage-transition history.
      </p>
      <p className="text-muted-foreground">
        It will be archived (not deleted) so that historical deal retrospective stays intact.
        Archived pipelines won&apos;t accept new leads but remain queryable.
      </p>
    </div>
  );
}

function ReassignBody({
  preview,
  reassignTo,
  setReassignTo,
}: {
  preview: PipelineDeletePreview;
  reassignTo: string;
  setReassignTo: (id: string) => void;
}): React.ReactElement {
  const selected = preview.destinations.find((d) => d.id === reassignTo);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Pipeline <strong>{preview.source.name}</strong> has {preview.dealCount}{" "}
        {preview.dealCount === 1 ? "deal" : "deals"}
        {preview.hasStageHistory ? " and stage-transition history" : ""}. Pick where deals should
        move:
      </p>
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground" htmlFor="reassign-dest">
          Destination pipeline
        </label>
        <select
          id="reassign-dest"
          value={reassignTo}
          onChange={(e) => setReassignTo(e.target.value)}
          className="w-full rounded border px-2 py-1 text-sm"
        >
          <option value="">— select destination —</option>
          {preview.destinations.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name} {d.initialStageName ? `(initial: ${d.initialStageName})` : ''}
            </option>
          ))}
        </select>
        {selected?.initialStageName ? (
          <p className="mt-1 text-xs text-muted-foreground">
            All {preview.dealCount} {preview.dealCount === 1 ? "deal lands" : "deals land"} at{" "}
            <strong>{selected.initialStageName}</strong> (destination&apos;s initial stage). Their
            stage clock resets to now.
          </p>
        ) : null}
      </div>
      {preview.hasStageHistory ? (
        <p className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-900">
          After deals move, <strong>{preview.source.name}</strong> will be archived (not deleted)
          so that historical deal retrospective stays intact.
        </p>
      ) : null}
    </div>
  );
}
