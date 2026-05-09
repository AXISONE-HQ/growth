/**
 * KAN-855 — Account Page Cohort 2. Logo storage helpers.
 *
 * Wraps @google-cloud/storage + Sharp for the /settings/account/identity
 * logo upload flow. The bucket `growth-tenant-assets` and IAM bindings
 * (objectAdmin + serviceAccountTokenCreator self-impersonation) shipped
 * via KAN-854 (`infra/terraform/storage.tf`).
 *
 * Object layout:
 *   tenants/{tenantId}/account/logo-{timestamp}.{ext}        — original
 *   tenants/{tenantId}/account/logo-{timestamp}-{256|128|64}.{ext} — variants
 *
 * SVG exception: SVG is vector — no raster resize needed. The original
 * is uploaded once and `logoVariants` JSON points all 3 sizes at the
 * same SVG path. `generateAndUploadVariants` returns null for SVG to
 * signal this to the caller.
 *
 * Pattern note: this is the canonical V4 signed-URL flow for the repo
 * (first instance). PUT 15min / GET 1hr per spec §2 decision 2. Tenant
 * scope enforced via path prefix check before mutation: any objectName
 * not starting with `tenants/{ctx.tenantId}/account/logo-` is rejected
 * — never trust client-supplied uploadIds.
 */
import { Storage } from "@google-cloud/storage";
import sharp from "sharp";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

export const TENANT_ASSETS_BUCKET = "growth-tenant-assets";

const PUT_TTL_MS = 15 * 60 * 1000;
const GET_TTL_MS = 60 * 60 * 1000;
const SHARP_TIMEOUT_MS = 10_000;

export const VARIANT_SIZES = [256, 128, 64] as const;
export type VariantSize = (typeof VARIANT_SIZES)[number];

/** MIME → file extension whitelist. Spec §2 decision 2. */
export const ALLOWED_LOGO_MIME_TO_EXT = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/svg+xml": "svg",
  "image/webp": "webp",
} as const;
export type AllowedLogoMime = keyof typeof ALLOWED_LOGO_MIME_TO_EXT;
export type AllowedLogoExt = (typeof ALLOWED_LOGO_MIME_TO_EXT)[AllowedLogoMime];

export const MAX_LOGO_BYTES = 5 * 1024 * 1024;

// ─────────────────────────────────────────────
// Object naming
// ─────────────────────────────────────────────

function buildObjectName(
  tenantId: string,
  timestamp: number,
  size: VariantSize | null,
  ext: AllowedLogoExt,
): string {
  if (size === null) return `tenants/${tenantId}/account/logo-${timestamp}.${ext}`;
  return `tenants/${tenantId}/account/logo-${timestamp}-${size}.${ext}`;
}

/** Tenant-scope check — every mutation that accepts a client objectName
 * MUST call this before touching GCS. Anything not under
 * `tenants/{ctx.tenantId}/account/logo-` is a tenant-isolation violation. */
export function isOwnedByTenant(objectName: string, tenantId: string): boolean {
  return objectName.startsWith(`tenants/${tenantId}/account/logo-`);
}

/** Parse ext from an object name; null if it doesn't match the schema. */
export function parseExtFromObjectName(objectName: string): AllowedLogoExt | null {
  const m = objectName.match(/\.(png|jpg|svg|webp)$/i);
  if (!m) return null;
  const ext = m[1].toLowerCase();
  if (ext === "png" || ext === "jpg" || ext === "svg" || ext === "webp") return ext;
  return null;
}

/** Parse the timestamp from an object name. Used by finalizeLogo to
 * derive variant paths from the original objectName the client uploaded. */
export function parseTimestampFromObjectName(objectName: string): number | null {
  const m = objectName.match(/\/logo-(\d+)(?:-(?:256|128|64))?\.[a-z]+$/i);
  if (!m) return null;
  const ts = Number(m[1]);
  return Number.isFinite(ts) ? ts : null;
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

/** Override the storage client — test-only seam. Production never calls
 * this; vitest tests stub the singleton via vi.mock on this module. */
export function _setStorageForTest(storage: Storage | null): void {
  _storage = storage;
}

// ─────────────────────────────────────────────
// V4 Signed URLs
// ─────────────────────────────────────────────

export interface SignedUploadResult {
  /** Browser PUTs the file body here. Expires in 15 min. */
  uploadUrl: string;
  /** GCS object name — also doubles as the uploadId returned to the
   * client. Finalize re-derives variant paths from this. */
  objectName: string;
  /** Opaque from the client's perspective; equals objectName. */
  uploadId: string;
  /** Required PUT Content-Type — the signed URL is bound to this. */
  contentType: AllowedLogoMime;
}

export async function getSignedUploadUrl(
  tenantId: string,
  mime: AllowedLogoMime,
): Promise<SignedUploadResult> {
  const ext = ALLOWED_LOGO_MIME_TO_EXT[mime];
  const timestamp = Date.now();
  const objectName = buildObjectName(tenantId, timestamp, null, ext);
  const [uploadUrl] = await getStorage()
    .bucket(TENANT_ASSETS_BUCKET)
    .file(objectName)
    .getSignedUrl({
      version: "v4",
      action: "write",
      expires: Date.now() + PUT_TTL_MS,
      contentType: mime,
    });
  return { uploadUrl, objectName, uploadId: objectName, contentType: mime };
}

export async function getSignedReadUrl(objectName: string): Promise<string> {
  const [url] = await getStorage()
    .bucket(TENANT_ASSETS_BUCKET)
    .file(objectName)
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

export async function downloadObject(objectName: string): Promise<Buffer> {
  const [buf] = await getStorage()
    .bucket(TENANT_ASSETS_BUCKET)
    .file(objectName)
    .download();
  return buf;
}

export async function uploadBuffer(
  objectName: string,
  buffer: Buffer,
  contentType: string,
): Promise<void> {
  await getStorage()
    .bucket(TENANT_ASSETS_BUCKET)
    .file(objectName)
    .save(buffer, { contentType, metadata: { contentType } });
}

export async function deleteObject(objectName: string): Promise<void> {
  await getStorage()
    .bucket(TENANT_ASSETS_BUCKET)
    .file(objectName)
    .delete({ ignoreNotFound: true });
}

export async function objectExists(objectName: string): Promise<boolean> {
  const [exists] = await getStorage()
    .bucket(TENANT_ASSETS_BUCKET)
    .file(objectName)
    .exists();
  return exists;
}

// ─────────────────────────────────────────────
// Sharp variant generation (raster only)
// ─────────────────────────────────────────────

export interface VariantObjectNames {
  size256: string;
  size128: string;
  size64: string;
}

function mimeFromExt(ext: AllowedLogoExt): string {
  switch (ext) {
    case "png":
      return "image/png";
    case "jpg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "svg":
      return "image/svg+xml";
  }
}

/** Generate 256/128/64 variants from a raster original and upload each
 * to GCS. Returns the variant object names. Hard 10s timeout via
 * Promise.race — on timeout (or any Sharp failure) the caller
 * preserves the original logo and stores `logoVariants=null` per spec.
 *
 * SVG callers MUST short-circuit before calling this (return null
 * upstream). Sharp can rasterize SVG but the spec is explicit: SVG is
 * vector, point all 3 sizes at the original.
 *
 * `fit: "contain"` with transparent background preserves aspect ratio;
 * landscape/portrait logos render correctly inside the square box
 * without cropping. */
export async function generateAndUploadVariants(
  tenantId: string,
  originalBuffer: Buffer,
  ext: AllowedLogoExt,
  timestamp: number,
): Promise<VariantObjectNames> {
  if (ext === "svg") {
    throw new Error(
      "generateAndUploadVariants called with SVG ext — caller must short-circuit (vector exception)",
    );
  }

  const variantNames: VariantObjectNames = {
    size256: buildObjectName(tenantId, timestamp, 256, ext),
    size128: buildObjectName(tenantId, timestamp, 128, ext),
    size64: buildObjectName(tenantId, timestamp, 64, ext),
  };

  const work = (async () => {
    const transparent = { r: 0, g: 0, b: 0, alpha: 0 };
    const [b256, b128, b64] = await Promise.all([
      sharp(originalBuffer)
        .resize(256, 256, { fit: "contain", background: transparent })
        .toBuffer(),
      sharp(originalBuffer)
        .resize(128, 128, { fit: "contain", background: transparent })
        .toBuffer(),
      sharp(originalBuffer)
        .resize(64, 64, { fit: "contain", background: transparent })
        .toBuffer(),
    ]);
    const contentType = mimeFromExt(ext);
    await Promise.all([
      uploadBuffer(variantNames.size256, b256, contentType),
      uploadBuffer(variantNames.size128, b128, contentType),
      uploadBuffer(variantNames.size64, b64, contentType),
    ]);
    return variantNames;
  })();

  return Promise.race([
    work,
    new Promise<VariantObjectNames>((_, reject) =>
      setTimeout(
        () => reject(new Error("Sharp variant generation exceeded 10s timeout")),
        SHARP_TIMEOUT_MS,
      ),
    ),
  ]);
}

// ─────────────────────────────────────────────
// Read-side enrichment
// ─────────────────────────────────────────────

export interface EnrichedLogoUrls {
  /** Signed GET URL for the original (1hr TTL); null when no logo set. */
  logoUrl: string | null;
  /** Signed GET URLs for 256/128/64 (1hr TTL); null when no variants
   * generated (Sharp failure recovery state) or no logo set. */
  logoVariants: { 256: string; 128: string; 64: string } | null;
}

/** Translate stored object names to signed read URLs. Called from
 * account.get and every mutation that returns the AccountProfile shape
 * — every page render gets fresh 1hr URLs.
 *
 * `storedLogoUrl` is the GCS object name (not a URL). `storedLogoVariants`
 * is the JSON we wrote to AccountProfile.logoVariants — either
 * { "256": objName, "128": objName, "64": objName } for raster, OR
 * { "256": svgPath, "128": svgPath, "64": svgPath } for SVG (all three
 * point at the same path), OR null if Sharp failed. */
export async function enrichLogoUrls(
  storedLogoUrl: string | null,
  storedLogoVariants: { "256"?: string; "128"?: string; "64"?: string } | null,
): Promise<EnrichedLogoUrls> {
  if (!storedLogoUrl) {
    return { logoUrl: null, logoVariants: null };
  }
  const logoUrl = await getSignedReadUrl(storedLogoUrl);

  if (!storedLogoVariants) {
    return { logoUrl, logoVariants: null };
  }

  const [v256, v128, v64] = await Promise.all([
    storedLogoVariants["256"] ? getSignedReadUrl(storedLogoVariants["256"]) : Promise.resolve(null),
    storedLogoVariants["128"] ? getSignedReadUrl(storedLogoVariants["128"]) : Promise.resolve(null),
    storedLogoVariants["64"] ? getSignedReadUrl(storedLogoVariants["64"]) : Promise.resolve(null),
  ]);
  if (!v256 || !v128 || !v64) {
    return { logoUrl, logoVariants: null };
  }
  return { logoUrl, logoVariants: { 256: v256, 128: v128, 64: v64 } };
}
