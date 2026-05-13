/**
 * KAN-896 — Ingestion Cohort 2.1a. GCS helpers for the
 * `growth-tenant-imports` bucket (CSV/XLSX upload originals).
 *
 * Mirrors the account-logo-storage.ts pattern verbatim (KAN-855):
 *   - Lazy singleton @google-cloud/storage Storage client
 *   - V4 signed-URL helpers (PUT 15m / GET 1h)
 *   - downloadObject + objectExists for inspection-side reads
 *   - isOwnedByTenant prefix check primitive (must be called before
 *     every mutation that accepts a client-supplied objectPath)
 *
 * Bucket + IAM (objectAdmin on the default Compute SA) shipped via
 * `infra/terraform/storage.tf` in this PR. selfTokenCreator binding
 * inherited from KAN-854 (one grant covers all buckets).
 *
 * Object layout (enforced by isOwnedByTenant):
 *   tenants/{tenantId}/imports/{importJobId}/{filename}
 *
 * Why a parallel file instead of generalizing account-logo-storage.ts:
 * surgical scope. When a 3rd bucket lands, extract a shared
 * `_gcs-client.ts` low-level (Rule of Three) — tracked in the
 * GCS-helper-extraction follow-up filed alongside this PR.
 */
import { Storage } from "@google-cloud/storage";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

export const TENANT_IMPORTS_BUCKET = "growth-tenant-imports";

const PUT_TTL_MS = 15 * 60 * 1000;
const GET_TTL_MS = 60 * 60 * 1000;

/** 20 MB cap — matches `createUploadUrl` zod input cap. Surfaced here
 *  so tests can reference the same constant. */
export const MAX_IMPORT_BYTES = 20 * 1024 * 1024;

/** MIME → file extension whitelist for inferred extension when the
 *  filename has no extension. Decision: CSV + XLSX only for this cohort.
 *  JSON file support deferred. */
export const ALLOWED_IMPORT_MIMES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
] as const;
export type AllowedImportMime = (typeof ALLOWED_IMPORT_MIMES)[number];

// ─────────────────────────────────────────────
// Object naming
// ─────────────────────────────────────────────

export function buildImportObjectPath(
  tenantId: string,
  importJobId: string,
  filename: string,
): string {
  return `tenants/${tenantId}/imports/${importJobId}/${filename}`;
}

/** Tenant-scope check — every mutation that accepts a client-supplied
 *  objectPath MUST call this first. Anything not under
 *  `tenants/{ctx.tenantId}/imports/` is a tenant-isolation violation. */
export function isOwnedByTenant(objectPath: string, tenantId: string): boolean {
  return objectPath.startsWith(`tenants/${tenantId}/imports/`);
}

// ─────────────────────────────────────────────
// Storage client (lazy singleton)
// ─────────────────────────────────────────────

let _storage: Storage | null = null;

function getStorage(): Storage {
  if (_storage) return _storage;
  _storage = new Storage();
  return _storage;
}

/** Test-only seam: vitest tests stub the singleton via vi.mock on this
 *  module, then call _setStorageForTest(mockStorage). */
export function _setStorageForTest(storage: Storage | null): void {
  _storage = storage;
}

// ─────────────────────────────────────────────
// V4 Signed URLs
// ─────────────────────────────────────────────

export interface SignedUploadResult {
  /** Browser PUTs the file body here. Expires in 15 min. */
  uploadUrl: string;
  /** Bound Content-Type — PUT request MUST send this header verbatim. */
  contentType: AllowedImportMime;
  /** ISO timestamp at which the signed URL expires. */
  expiresAt: string;
}

export async function getSignedUploadUrl(
  objectPath: string,
  mime: AllowedImportMime,
): Promise<SignedUploadResult> {
  const expiresAtMs = Date.now() + PUT_TTL_MS;
  const [uploadUrl] = await getStorage()
    .bucket(TENANT_IMPORTS_BUCKET)
    .file(objectPath)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: expiresAtMs,
      contentType: mime,
    });
  return {
    uploadUrl,
    contentType: mime,
    expiresAt: new Date(expiresAtMs).toISOString(),
  };
}

export async function getSignedReadUrl(objectPath: string): Promise<string> {
  const [url] = await getStorage()
    .bucket(TENANT_IMPORTS_BUCKET)
    .file(objectPath)
    .getSignedUrl({
      version: "v4",
      action: "read",
      expires: Date.now() + GET_TTL_MS,
    });
  return url;
}

// ─────────────────────────────────────────────
// Object I/O
// ─────────────────────────────────────────────

export async function downloadObject(objectPath: string): Promise<Buffer> {
  const [buf] = await getStorage()
    .bucket(TENANT_IMPORTS_BUCKET)
    .file(objectPath)
    .download();
  return buf;
}

export async function objectExists(objectPath: string): Promise<boolean> {
  const [exists] = await getStorage()
    .bucket(TENANT_IMPORTS_BUCKET)
    .file(objectPath)
    .exists();
  return exists;
}
