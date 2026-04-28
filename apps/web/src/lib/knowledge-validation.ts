/**
 * KAN-708 — knowledge ingestion validation helpers.
 *
 * Mirrors apps/knowledge-worker/src/services/knowledge-validation.ts. Both
 * copies stay in sync via the shared zod backend schema (IngestRequestSchema
 * in apps/api/src/services/knowledge-ingest-types.ts) — any change here MUST
 * propagate to the worker copy. KAN-719 (shared types) will consolidate.
 *
 * Tests for the canonical version live with the worker. The frontend copy
 * is identical; we don't run a separate test suite for it.
 */

export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

export const ALLOWED_DOC_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".markdown"] as const;

export interface UrlCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkUrl(input: string): UrlCheckResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, reason: "URL is required" };
  if (!trimmed.startsWith("https://")) return { ok: false, reason: "URL must start with https://" };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: "URL is not parseable" };
  }
  if (!u.hostname) return { ok: false, reason: "URL must have a hostname" };
  return { ok: true };
}

export interface FileCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkUploadedFile(opts: { name: string; size: number }): FileCheckResult {
  if (!opts.name || opts.name.trim().length === 0) {
    return { ok: false, reason: "File name is required" };
  }
  const lower = opts.name.toLowerCase();
  if (!ALLOWED_DOC_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    return {
      ok: false,
      reason: `Unsupported file type (allowed: ${ALLOWED_DOC_EXTENSIONS.join(", ")})`,
    };
  }
  if (opts.size <= 0) {
    return { ok: false, reason: "File is empty" };
  }
  if (opts.size > MAX_UPLOAD_BYTES) {
    return {
      ok: false,
      reason: `File exceeds size cap (${(opts.size / 1024 / 1024).toFixed(1)}MB > 50MB)`,
    };
  }
  return { ok: true };
}

export interface QaPairCheckResult {
  ok: boolean;
  reason?: string;
}

export function checkQaPair(opts: { question: string; answer: string }): QaPairCheckResult {
  const q = opts.question.trim();
  const a = opts.answer.trim();
  if (q.length === 0) return { ok: false, reason: "Question is required" };
  if (q.length > 2000) return { ok: false, reason: "Question must be 2000 characters or fewer" };
  if (a.length === 0) return { ok: false, reason: "Answer is required" };
  if (a.length > 10000) return { ok: false, reason: "Answer must be 10000 characters or fewer" };
  return { ok: true };
}

export function isInProgress(status: string): boolean {
  return status === "pending" || status === "processing";
}
