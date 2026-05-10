"use client";

/**
 * KAN-866 — Account Page Cohort 6: live SSE-driven scan-progress card.
 *
 * **PROMOTION CANDIDATE** — pure-presentation; no business logic. KAN-842
 * lift candidate when the canonical DS v1 surfaces consolidate.
 *
 * **Canonical SSE consumer for apps/web.** First in this codebase. The
 * pattern documented inline below is the reference for any future
 * EventSource-driven UI.
 *
 * SSE consumer pattern (reference for future apps/web SSE UIs):
 *
 *   1. Opens `EventSource(absoluteUrl)`. The URL must be absolute (not a
 *      relative `/api/...` path) when `NEXT_PUBLIC_API_URL` differs from
 *      the page origin — common in our Cloud Run + apps/web split.
 *
 *   2. Subscribes via `addEventListener(eventType, ...)` for each typed
 *      event. The backend at `apps/api/src/internal/account-detect-events-sse.ts`
 *      formats events as `event: <type>\ndata: <json>\n\n`, so the
 *      browser's EventSource fires the matching named-event listener
 *      (NOT `onmessage`). This card listens to: progress / completed / failed.
 *
 *   3. Cleans up on:
 *        - terminal event (completed / failed) — call `close()` then drop the
 *          ref so React re-renders without the stream attached
 *        - unmount — `useEffect` cleanup
 *        - jobId change — same as unmount + re-open against new id
 *
 *   4. Auth: SSE is jobId-scoped (opaque UUID, server-side tenant scope at
 *      issue time). EventSource doesn't support custom headers; cookie-
 *      based auth is V2. Pre-launch single-tenant skip is documented
 *      server-side.
 *
 *   5. Reconnect: EventSource auto-reconnects on transport errors. The
 *      backend's keepalive every 15s prevents idle disconnect through
 *      Cloud Run (60s idle kill) and proxies. We don't add app-layer
 *      retry — the browser handles it transparently for transient drops.
 */
import * as React from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { API_BASE } from "@/lib/api";

export type ScanPhase = "fetching" | "extracting" | "completed" | "failed";

interface ProgressData {
  phase: "fetching" | "extracting";
  notes?: string[];
}
interface CompletedData {
  proposalCount: number;
  durationMs: number;
}
interface FailedData {
  errorCode: string;
  errorMessage: string;
}

export interface ScanningStateCardProps {
  jobId: string;
  /** Fired once when `completed` arrives — page can invalidate proposal queries. */
  onCompleted?: (data: CompletedData) => void;
  /** Fired once when `failed` arrives. */
  onFailed?: (data: FailedData) => void;
}

const PHASE_COPY: Record<ScanPhase, string> = {
  fetching: "Reading website pages",
  extracting: "Identifying account fields",
  completed: "Scan complete",
  failed: "Scan failed",
};

export function ScanningStateCard({
  jobId,
  onCompleted,
  onFailed,
}: ScanningStateCardProps): React.ReactElement {
  const [phase, setPhase] = React.useState<ScanPhase>("fetching");
  const [completedData, setCompletedData] = React.useState<CompletedData | null>(null);
  const [failedData, setFailedData] = React.useState<FailedData | null>(null);
  const onCompletedRef = React.useRef(onCompleted);
  const onFailedRef = React.useRef(onFailed);
  React.useEffect(() => {
    onCompletedRef.current = onCompleted;
    onFailedRef.current = onFailed;
  }, [onCompleted, onFailed]);

  React.useEffect(() => {
    const url = `${API_BASE}/api/account/detect-events?jobId=${encodeURIComponent(jobId)}`;
    const es = new EventSource(url);

    const handleProgress = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as ProgressData;
        setPhase(data.phase);
      } catch {
        /* ignore malformed payload */
      }
    };
    const handleCompleted = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as CompletedData;
        setPhase("completed");
        setCompletedData(data);
        onCompletedRef.current?.(data);
      } catch {
        /* ignore malformed payload */
      } finally {
        es.close();
      }
    };
    const handleFailed = (ev: MessageEvent) => {
      try {
        const data = JSON.parse(ev.data) as FailedData;
        setPhase("failed");
        setFailedData(data);
        onFailedRef.current?.(data);
      } catch {
        /* ignore malformed payload */
      } finally {
        es.close();
      }
    };

    es.addEventListener("progress", handleProgress as EventListener);
    es.addEventListener("completed", handleCompleted as EventListener);
    es.addEventListener("failed", handleFailed as EventListener);

    return () => {
      es.removeEventListener("progress", handleProgress as EventListener);
      es.removeEventListener("completed", handleCompleted as EventListener);
      es.removeEventListener("failed", handleFailed as EventListener);
      es.close();
    };
  }, [jobId]);

  const isTerminal = phase === "completed" || phase === "failed";
  const tone = phase === "failed" ? "var(--ds-danger-text)" : "var(--ds-ink-primary)";

  return (
    <Card
      className="mt-4"
      role="status"
      aria-live="polite"
      aria-label="Website scan in progress"
    >
      <CardHeader>
        <CardTitle style={{ color: tone }}>{PHASE_COPY[phase]}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {!isTerminal && (
          <div className="flex flex-col gap-2" aria-label="Scan progress">
            <ScanStep label="Reading website pages" active={phase === "fetching"} done={phase === "extracting"} />
            <ScanStep label="Identifying account fields" active={phase === "extracting"} done={false} />
          </div>
        )}
        {phase === "completed" && completedData && (
          <p className="text-sm" style={{ color: "var(--ds-ink-secondary)" }}>
            Found {completedData.proposalCount}{" "}
            {completedData.proposalCount === 1 ? "proposal" : "proposals"} for review.
          </p>
        )}
        {phase === "failed" && failedData && (
          <p
            className="text-sm"
            style={{ color: "var(--ds-danger-text)" }}
            role="alert"
          >
            {humanizeError(failedData.errorCode)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ScanStep({
  label,
  active,
  done,
}: {
  label: string;
  active: boolean;
  done: boolean;
}): React.ReactElement {
  const color = done
    ? "var(--ds-emerald-500)"
    : active
      ? "var(--ds-violet-500)"
      : "var(--ds-ink-tertiary)";
  return (
    <div className="flex items-center gap-2">
      <span
        aria-hidden="true"
        className={["w-2 h-2 rounded-full", active ? "motion-pulse" : ""].join(" ")}
        style={{ backgroundColor: color }}
      />
      <span
        className="text-sm"
        style={{ color: done || active ? "var(--ds-ink-primary)" : "var(--ds-ink-tertiary)" }}
      >
        {label}
      </span>
    </div>
  );
}

function humanizeError(code: string): string {
  switch (code) {
    case "timeout":
      return "Scan took too long to complete. Try again.";
    case "fetch_failed":
      return "Couldn't reach that website. Check the URL and try again.";
    case "llm_error":
      return "Couldn't analyze the page contents. Try again.";
    default:
      return "Scan failed. Try again.";
  }
}
