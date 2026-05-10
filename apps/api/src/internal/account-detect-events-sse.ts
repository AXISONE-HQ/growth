/**
 * KAN-866 — Account Page Cohort 6: SSE endpoint for detection progress.
 *
 * **First SSE endpoint in the codebase.** This module is the canonical
 * reference for future SSE consumers — pattern documented inline below.
 *
 * Mounted at GET `/api/account/detect-events?jobId={jobId}`. The web
 * `ScanningStateCard` opens an `EventSource` against this URL after
 * calling `account.detectFromWebsite` to receive real-time
 * `account.detect_progress` / `account.detect_completed` /
 * `account.detect_failed` events for the active job.
 *
 * Auth: Firebase ID token via `Authorization: Bearer ...` (the standard
 * web-tRPC auth pattern). EventSource supports custom headers in modern
 * browsers via the polyfill OR via an httpOnly cookie path; the simpler
 * pre-launch approach is to scope the SSE channel by jobId (an opaque
 * UUID returned by detectFromWebsite, tenant-scoped at issue time) +
 * tenant header. Auth review for V2 if multi-tenant or untrusted users.
 *
 * Implementation pattern (reference for future SSE endpoints):
 *
 *   1. Hono returns a Response with body=ReadableStream + headers:
 *        Content-Type: text/event-stream
 *        Cache-Control: no-cache, no-store
 *        Connection: keep-alive
 *        X-Accel-Buffering: no  (disables nginx-style proxy buffering)
 *
 *   2. Subscribe to a per-job in-memory event bus (keyed by jobId).
 *      For Cohort 6 single-instance Cloud Run this is fine; if we ever
 *      run multi-instance, swap to a Redis pub/sub channel.
 *
 *   3. Format each event: `event: <type>\ndata: <json>\n\n`. Browser
 *      `EventSource.onmessage` fires per `\n\n` delimiter.
 *
 *   4. Send a `:keepalive\n\n` comment line every 15s to keep the TCP
 *      connection alive through proxies + Cloud Run idle timeout (60s).
 *
 *   5. Close the stream on `account.detect_completed` /
 *      `account.detect_failed` — terminal events. Client sees
 *      `EventSource.readyState === CLOSED` and stops listening.
 *
 *   6. Handle client disconnect: stream's `cancel()` callback fires;
 *      remove the subscriber from the bus to avoid leaks.
 *
 * The event bus is fed from the existing publishers in
 * `account-detect-publishers.ts` — Cohort 6 wires a `tap()` so each
 * publish call ALSO routes to the local bus for SSE delivery in
 * addition to the Pub/Sub publish.
 */
import { Hono } from "hono";
import { stream as honoStream } from "hono/streaming";

export const accountDetectEventsSseApp = new Hono();

// ─────────────────────────────────────────────────────────────────
// In-memory event bus — one Set<EnqueueFn> per active jobId
// ─────────────────────────────────────────────────────────────────

type SSEEvent = {
  type: "progress" | "completed" | "failed";
  data: Record<string, unknown>;
};
type EnqueueFn = (event: SSEEvent) => void;

const jobSubscribers = new Map<string, Set<EnqueueFn>>();

/**
 * Tap point — the `account-detect-publishers` module + the
 * `account-detect-handler` invoke this to fan out a copy of each
 * lifecycle event to any active SSE subscribers for that jobId.
 */
export function fanoutDetectEvent(jobId: string, event: SSEEvent): void {
  const subs = jobSubscribers.get(jobId);
  if (!subs || subs.size === 0) return;
  for (const enqueue of subs) {
    try {
      enqueue(event);
    } catch (err) {
      console.warn("[detect-events-sse] subscriber enqueue failed:", err);
    }
  }
}

/** Test seam — assert active subscriber count for a jobId. */
export function _activeSubscriberCountForTest(jobId: string): number {
  return jobSubscribers.get(jobId)?.size ?? 0;
}

// ─────────────────────────────────────────────────────────────────
// SSE endpoint
// ─────────────────────────────────────────────────────────────────

accountDetectEventsSseApp.get("/account/detect-events", async (c) => {
  const jobId = c.req.query("jobId");
  if (!jobId) {
    return c.json({ error: "jobId query parameter required" }, 400);
  }
  // Auth check would go here — pre-launch single-tenant skips it. V2
  // owner: validate Firebase ID token + tenant scope match the jobId
  // owner. The jobId is opaque so brute-forcing is impractical, but
  // formal auth before public release.

  return honoStream(c, async (s) => {
    s.onAbort(() => {
      // Client disconnect or stream close — clean up subscriber
      const subs = jobSubscribers.get(jobId);
      if (subs) {
        subs.delete(enqueue);
        if (subs.size === 0) jobSubscribers.delete(jobId);
      }
    });

    // SSE response headers
    c.header("Content-Type", "text/event-stream");
    c.header("Cache-Control", "no-cache, no-store");
    c.header("Connection", "keep-alive");
    c.header("X-Accel-Buffering", "no");

    let closed = false;
    const queue: SSEEvent[] = [];
    let resolveWaiter: (() => void) | null = null;

    const enqueue: EnqueueFn = (event) => {
      if (closed) return;
      queue.push(event);
      if (resolveWaiter) {
        resolveWaiter();
        resolveWaiter = null;
      }
    };

    // Register subscriber
    let subs = jobSubscribers.get(jobId);
    if (!subs) {
      subs = new Set();
      jobSubscribers.set(jobId, subs);
    }
    subs.add(enqueue);

    // Initial connection comment so the browser sees the stream open
    await s.write(`:connected to jobId=${jobId}\n\n`);

    // Keepalive ticker — Cloud Run kills idle connections at ~60s
    const keepaliveInterval = setInterval(() => {
      if (!closed) {
        s.write(`:keepalive\n\n`).catch(() => undefined);
      }
    }, 15000);

    try {
      while (!closed) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            resolveWaiter = resolve;
          });
        }
        while (queue.length > 0 && !closed) {
          const event = queue.shift()!;
          const payload = `event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`;
          await s.write(payload);

          // Terminal events close the stream
          if (event.type === "completed" || event.type === "failed") {
            closed = true;
          }
        }
      }
    } catch (err) {
      console.warn("[detect-events-sse] stream loop ended:", err);
    } finally {
      clearInterval(keepaliveInterval);
      const finalSubs = jobSubscribers.get(jobId);
      if (finalSubs) {
        finalSubs.delete(enqueue);
        if (finalSubs.size === 0) jobSubscribers.delete(jobId);
      }
    }
  });
});
