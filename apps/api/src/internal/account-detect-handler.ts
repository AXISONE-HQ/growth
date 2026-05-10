/**
 * KAN-862 — Account Page Cohort 5: Cloud Tasks push handler for the
 * detect-from-website worker. Mounted at POST
 * /internal/account-detect-handler on growth-api (Path B per Fred's
 * pre-flight Decision 1).
 *
 * Cloud Tasks dispatches HTTP POST with OIDC bearer (signed by Cloud
 * Tasks Service Agent impersonating pubsub-invoker — see
 * infra/terraform/account-detect.tf). verifyPubsubOidc validates the
 * audience-derived URL match generically.
 *
 * Flow per spec §6 + Fred's brief item 2:
 *   1. Verify OIDC, parse body { tenantId, jobId, websiteUrl }
 *   2. Update AccountProfile.detectStatus='in_progress'
 *   3. Publish account.detect_progress {phase: 'fetching'}
 *   4. discoverAndFetchPages(websiteUrl) — homepage + up to 2 sub-pages
 *   5. Publish account.detect_progress {phase: 'extracting'}
 *   6. extractAccountFieldsFromPages(...) — Sonnet tool-use call
 *   7. For each valid proposal: insert AccountFieldDetection row (status='proposed')
 *   8. Update AccountProfile.{lastDetectAt, lastDetectSource, detectStatus='completed'}
 *   9. Publish account.detect_completed {tenantId, jobId, proposalCount}
 *
 * Failure handling:
 *   - Hard 30s timeout end-to-end → publish detect_failed errorCode='timeout'
 *   - Sonnet error → publish detect_failed errorCode='llm_error'
 *   - Page-fetch all-fail → publish detect_failed errorCode='fetch_failed'
 *   - On 3rd-attempt (Cloud Tasks max-attempts=3): also publish dead_letter
 *
 * Status transitions:
 *   in_progress → completed (success)
 *   in_progress → failed (any unrecoverable error)
 */
import { Hono } from "hono";
import { prisma } from "../prisma.js";
import { verifyPubsubOidc } from "../lib/oidc-pubsub-verify.js";
import {
  discoverAndFetchPages,
  buildCombinedTextForLLM,
} from "../services/account-detect-html-fetcher.js";
import { extractAccountFieldsFromPages } from "../services/account-detect-extractor.js";
import {
  publishDetectProgress,
  publishDetectCompleted,
  publishDetectFailed,
  publishDetectDeadLetter,
} from "../services/account-detect-publishers.js";

export const accountDetectHandlerApp = new Hono();

const HARD_TIMEOUT_MS = 30000; // 30s end-to-end
const MAX_ATTEMPTS = 3; // matches Cloud Tasks queue retry config

interface TaskBody {
  tenantId: string;
  jobId: string;
  websiteUrl: string;
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function isValidTaskBody(b: unknown): b is TaskBody {
  if (typeof b !== "object" || b === null) return false;
  const o = b as Record<string, unknown>;
  return (
    typeof o.tenantId === "string" &&
    typeof o.jobId === "string" &&
    typeof o.websiteUrl === "string"
  );
}

accountDetectHandlerApp.post("/internal/account-detect-handler", async (c) => {
  // OIDC verification — same audience-derivation pattern that
  // verifyPubsubOidc uses for Pub/Sub push (KAN-732). Cloud Tasks
  // OIDC tokens are issued by the Cloud Tasks Service Agent
  // impersonating pubsub-invoker (per Terraform IAM bindings).
  if (!(await verifyPubsubOidc(c))) {
    return c.text("unauthorized", 401);
  }

  // Parse body
  const rawText = await c.req.text();
  const parsed = safeJsonParse(rawText);
  if (!isValidTaskBody(parsed)) {
    return c.json({ error: "invalid_task_body" }, 400);
  }
  const { tenantId, jobId, websiteUrl } = parsed;

  // Cloud Tasks supplies attempt-count in the X-CloudTasks-TaskRetryCount
  // header (0-indexed). MAX_ATTEMPTS=3 means values 0/1/2 are valid;
  // 3+ would mean the queue config is misaligned with our handler.
  const retryCountHeader = c.req.header("x-cloudtasks-taskretrycount") ?? "0";
  const attempt = Number.parseInt(retryCountHeader, 10) + 1;

  const startedAt = Date.now();

  // Mark in_progress at the top so the UI can poll detectStatus and
  // see the worker grabbed the task. Best-effort — if this update
  // fails (DB outage) we still try the scan; the row state lags but
  // the task itself is the source of truth via the lifecycle events.
  try {
    await (prisma as any).accountProfile?.updateMany?.({
      where: { tenantId },
      data: { detectStatus: "in_progress" },
    });
  } catch (err) {
    console.warn("[account-detect-handler] detectStatus update failed:", err);
  }

  await publishDetectProgress({ tenantId, jobId, phase: "fetching" });

  // Wrap the scan body in a Promise.race against the 30s hard timeout.
  // On timeout we publish detect_failed; Cloud Tasks will retry up to
  // MAX_ATTEMPTS based on its queue config.
  let timeoutHandle: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error("HARD_TIMEOUT")),
      HARD_TIMEOUT_MS,
    );
  });

  try {
    const proposalCount = await Promise.race([
      runDetectScan({ tenantId, jobId, websiteUrl }),
      timeoutPromise,
    ]);
    if (timeoutHandle) clearTimeout(timeoutHandle);

    await publishDetectCompleted({
      tenantId,
      jobId,
      proposalCount,
      durationMs: Date.now() - startedAt,
    });
    return c.json({ ok: true, proposalCount });
  } catch (err) {
    if (timeoutHandle) clearTimeout(timeoutHandle);
    const message = err instanceof Error ? err.message : String(err);
    const errorCode =
      message === "HARD_TIMEOUT"
        ? "timeout"
        : message.startsWith("FETCH_FAILED")
          ? "fetch_failed"
          : message.startsWith("LLM_ERROR")
            ? "llm_error"
            : "unknown";

    // Update DB row state — failed
    try {
      await (prisma as any).accountProfile?.updateMany?.({
        where: { tenantId },
        data: { detectStatus: "failed" },
      });
    } catch {
      /* swallow — already in failure path */
    }

    await publishDetectFailed({
      tenantId,
      jobId,
      errorCode,
      errorMessage: message,
      attempt,
    });

    // Final-attempt failure → publish dead-letter for Cohort 6 audit
    // subscriber. Cloud Tasks doesn't have native dead-lettering, so
    // we explicitly publish on the dlq topic from the handler itself.
    if (attempt >= MAX_ATTEMPTS) {
      await publishDetectDeadLetter({
        tenantId,
        jobId,
        websiteUrl,
        finalErrorCode: errorCode,
        finalErrorMessage: message,
      });
    }

    // Return 200 so Cloud Tasks doesn't retry on a NON-retryable error.
    // For retryable errors (fetch_failed, llm_error) we'd want a 5xx,
    // but per Fred's brief the queue's max-attempts=3 + backoff covers
    // retry semantics — returning 5xx + relying on Tasks retry would
    // double-publish detect_failed. Cleaner: handler owns retry decisions
    // by returning 5xx ONLY for transient errors; permanent errors get 200.
    const isRetryable = errorCode === "llm_error" || errorCode === "fetch_failed";
    if (isRetryable && attempt < MAX_ATTEMPTS) {
      return c.json({ error: errorCode, message }, 500);
    }
    return c.json({ error: errorCode, message }, 200);
  }
});

/**
 * Inner scan loop — separated from the timeout/error wrapper so the
 * handler stays narrow + the test surface is the scan steps not the
 * HTTP plumbing.
 */
async function runDetectScan(input: {
  tenantId: string;
  jobId: string;
  websiteUrl: string;
}): Promise<number> {
  const { tenantId, jobId, websiteUrl } = input;

  // 1. Page discovery + fetch
  const discovery = await discoverAndFetchPages(websiteUrl);
  if (discovery.pages.length === 0) {
    throw new Error(`FETCH_FAILED: no pages reachable from ${websiteUrl}`);
  }

  // 2. Build the combined LLM input
  const combined = buildCombinedTextForLLM(discovery.pages);

  await publishDetectProgress({
    tenantId,
    jobId,
    phase: "extracting",
    notes: discovery.notes,
  });

  // 3. Sonnet extraction
  let extraction;
  try {
    extraction = await extractAccountFieldsFromPages({
      tenantId,
      combinedPageText: combined,
    });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    throw new Error(`LLM_ERROR: ${m}`);
  }

  // 4. Find AccountProfile.id for FK + tenant scope
  const profile = (await (prisma as any).accountProfile?.findUnique({
    where: { tenantId },
    select: { id: true },
  })) as { id: string } | null;
  if (!profile) {
    throw new Error(`FETCH_FAILED: AccountProfile not provisioned for tenant ${tenantId}`);
  }

  // 5. Insert AccountFieldDetection rows for valid proposals
  for (const p of extraction.validProposals) {
    try {
      await (prisma as any).accountFieldDetection?.create({
        data: {
          accountProfileId: profile.id,
          fieldPath: p.fieldName,
          proposedValue: p.proposedValue,
          confidence: p.confidence,
          sourceUrl: p.sourceUrl,
          sourceSnippet: p.sourceSnippet,
          status: "proposed",
        },
      });
    } catch (err) {
      // Per-row insert error doesn't abort the scan — log + continue.
      console.error("[account-detect-handler] proposal insert failed:", err);
    }
  }

  // 6. Update AccountProfile detect-state columns
  try {
    await (prisma as any).accountProfile?.updateMany?.({
      where: { tenantId },
      data: {
        lastDetectAt: new Date(),
        lastDetectSource: websiteUrl,
        detectStatus: "completed",
      },
    });
  } catch (err) {
    console.warn("[account-detect-handler] AccountProfile final update failed:", err);
  }

  return extraction.validProposals.length;
}
