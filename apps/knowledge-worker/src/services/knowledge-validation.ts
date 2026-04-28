/**
 * KAN-708 — pure validation helpers for the knowledge ingestion UI.
 *
 * Lives in apps/knowledge-worker (the self-contained workspace) so the
 * connectors vitest bridge can pull these tests without crossing the
 * apps/web boundary. The frontend imports the SAME constants via the
 * existing api.ts mirror pattern (KAN-719 will eventually consolidate).
 *
 * Format checks only. No backend round-trips. No PII (the file content
 * itself isn't passed to these helpers; they validate metadata).
 */

/** 50MB cap per KAN-707 PR B's document path. */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Whitelisted document extensions (matches inferContentType in document.ts). */
export const ALLOWED_DOC_EXTENSIONS = [".pdf", ".docx", ".txt", ".md", ".markdown"] as const;

export interface UrlCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * URL must be HTTPS, parseable, and have a non-empty hostname.
 * Matches the IngestRequestSchema.url validator on the backend.
 */
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

/**
 * File metadata check. Caller passes name + size; we don't read the file
 * content (the backend's document.ts does the parse).
 */
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

/** Q&A length bounds match the backend zod IngestRequestSchema.qa_pair. */
export function checkQaPair(opts: { question: string; answer: string }): QaPairCheckResult {
  const q = opts.question.trim();
  const a = opts.answer.trim();
  if (q.length === 0) return { ok: false, reason: "Question is required" };
  if (q.length > 2000) return { ok: false, reason: "Question must be 2000 characters or fewer" };
  if (a.length === 0) return { ok: false, reason: "Answer is required" };
  if (a.length > 10000) return { ok: false, reason: "Answer must be 10000 characters or fewer" };
  return { ok: true };
}

/**
 * UI-friendly mapping for the 4 KnowledgeSourceStatus values that show
 * progress + the terminal `failed`/`stale` states. Used by the status badge
 * to decide variant + icon.
 */
export type StatusVariant = "info" | "neutral" | "success" | "destructive" | "warning";

export const STATUS_VARIANT: Record<string, StatusVariant> = {
  pending: "info",
  processing: "info",
  indexed: "success",
  failed: "destructive",
  stale: "warning",
};

export function isInProgress(status: string): boolean {
  return status === "pending" || status === "processing";
}
