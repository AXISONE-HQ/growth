/**
 * KAN-896 — Ingestion Cohort 2.1a. Import-jobs router service.
 *
 * 4 read+write procedures for the upload flow:
 *   createUploadUrl  → creates ImportJob row + V4 signed PUT URL
 *   confirmUpload    → verifies GCS object + runs inspection (sync)
 *   list             → cursor-paginated ImportJob list
 *   get              → single ImportJob with NOT_FOUND on cross-tenant
 *
 * Pure service functions; thin tRPC layer in apps/api/src/router.ts
 * mounts them via the KAN-689 cohort variable-specifier dynamic-import
 * pattern.
 *
 * Cursor pagination shape mirrors KAN-883 (companies/orders/deals);
 * convergence to a shared helper tracked in KAN-882.
 */
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import {
  buildCursorWhere,
  decodeCursor,
  encodeCursor,
} from "./_pagination.js";
import {
  buildImportObjectPath,
  getSignedUploadUrl,
  objectExists,
  downloadObject,
  type AllowedImportMime,
} from "./import-storage.js";
import { runInspection } from "./lib/import-inspector.js";

// ─────────────────────────────────────────────
// Input + output shapes (zod schemas live in the apps/api router layer;
// service-level types kept loose so tests can call without zod parsing)
// ─────────────────────────────────────────────

export interface CreateUploadUrlInput {
  filename: string;
  fileSize: number;
  fileMimeType: AllowedImportMime;
  mode: "replace_all" | "update_add";
}

export interface CreateUploadUrlResult {
  importJobId: string;
  signedUploadUrl: string;
  gcsObjectPath: string;
  expiresAt: string;
}

export interface ConfirmUploadInput {
  importJobId: string;
}

export interface ListInput {
  status?:
    | "awaiting_upload"
    | "uploaded"
    | "inspecting"
    | "inspected"
    | "failed";
  limit: number;
  cursor?: string;
}

export interface GetInput {
  id: string;
}

// ─────────────────────────────────────────────
// Procedures
// ─────────────────────────────────────────────

/**
 * Create the ImportJob row + return a V4 signed PUT URL.
 *
 * Validation:
 *  - filename: route-layer zod (1..255 chars)
 *  - fileSize: route-layer zod (1..20MB)
 *  - fileMimeType: route-layer zod (whitelist enum)
 *
 * No GCS write happens here — the URL is signed and returned; the
 * browser PUTs the body. Client must then call confirmUpload.
 */
export async function createUploadUrl(
  prisma: PrismaClient,
  tenantId: string,
  createdByUserId: string,
  input: CreateUploadUrlInput,
): Promise<CreateUploadUrlResult> {
  // 1. Create the ImportJob row first — without it we have no id to
  //    embed in the object path.
  const tempJob = await prisma.importJob.create({
    data: {
      tenantId,
      createdByUserId,
      fileName: input.filename,
      fileSize: input.fileSize,
      fileMimeType: input.fileMimeType,
      gcsObjectPath: "PENDING", // placeholder; updated below
      mode: input.mode,
      // status defaults to 'awaiting_upload' per schema
    },
  });

  // 2. Compute the canonical path now that we have the id.
  const gcsObjectPath = buildImportObjectPath(
    tenantId,
    tempJob.id,
    input.filename,
  );

  // 3. Update the row with the real path.
  await prisma.importJob.update({
    where: { id: tempJob.id },
    data: { gcsObjectPath },
  });

  // 4. Generate the V4 signed PUT URL.
  const signed = await getSignedUploadUrl(gcsObjectPath, input.fileMimeType);

  return {
    importJobId: tempJob.id,
    signedUploadUrl: signed.uploadUrl,
    gcsObjectPath,
    expiresAt: signed.expiresAt,
  };
}

/**
 * Confirm that the browser successfully PUT'd the file body to GCS, then
 * synchronously run inspection. Returns the updated ImportJob shape.
 *
 * State transitions on happy path:
 *   awaiting_upload → uploaded → inspecting → inspected
 *
 * On GCS object missing: status → failed, errorMessage set, return job.
 * On inspection error: status → failed (handled inside runInspection).
 */
export async function confirmUpload(
  prisma: PrismaClient,
  tenantId: string,
  input: ConfirmUploadInput,
) {
  // 1. Load + verify tenant scope + status.
  const job = await prisma.importJob.findFirst({
    where: { id: input.importJobId, tenantId },
  });
  if (!job) {
    throw new TRPCError({ code: "NOT_FOUND", message: "ImportJob not found" });
  }
  if (job.status !== "awaiting_upload") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot confirm upload for ImportJob in status '${job.status}' (expected 'awaiting_upload')`,
    });
  }

  // 2. Verify the GCS object exists. If missing, mark failed.
  const exists = await objectExists(job.gcsObjectPath);
  if (!exists) {
    return prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        errorMessage: "GCS object not found at expected path",
        errorAt: new Date(),
      },
    });
  }

  // 3. Transition awaiting_upload → uploaded → inspecting in two steps
  //    so the timestamps reflect reality.
  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status: "uploaded",
      uploadConfirmedAt: new Date(),
    },
  });
  await prisma.importJob.update({
    where: { id: job.id },
    data: {
      status: "inspecting",
      inspectionStartedAt: new Date(),
    },
  });

  // 4. Run inspection. Updates the row in-place (writes detectedFileType
  //    + headers + sampleRows + status). Never rethrows — failure path
  //    writes status='failed' + errorMessage.
  await runInspection(prisma, downloadObject, {
    importJobId: job.id,
    tenantId,
  });

  // 5. Return the post-inspection row.
  const updated = await prisma.importJob.findFirst({
    where: { id: job.id, tenantId },
  });
  return updated!;
}

/**
 * Confirm-upload variant that allows the caller to inject a download
 * function. Used by tests to avoid mocking @google-cloud/storage at the
 * module level. Production calls `confirmUpload` above which delegates
 * here with the real downloadObject.
 */
export async function confirmUploadWithDownload(
  prisma: PrismaClient,
  tenantId: string,
  input: ConfirmUploadInput,
  download: (objectPath: string) => Promise<Buffer>,
  exists: (objectPath: string) => Promise<boolean>,
) {
  const job = await prisma.importJob.findFirst({
    where: { id: input.importJobId, tenantId },
  });
  if (!job) {
    throw new TRPCError({ code: "NOT_FOUND", message: "ImportJob not found" });
  }
  if (job.status !== "awaiting_upload") {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot confirm upload for ImportJob in status '${job.status}' (expected 'awaiting_upload')`,
    });
  }

  const gcsExists = await exists(job.gcsObjectPath);
  if (!gcsExists) {
    return prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: "failed",
        errorMessage: "GCS object not found at expected path",
        errorAt: new Date(),
      },
    });
  }

  await prisma.importJob.update({
    where: { id: job.id },
    data: { status: "uploaded", uploadConfirmedAt: new Date() },
  });
  await prisma.importJob.update({
    where: { id: job.id },
    data: { status: "inspecting", inspectionStartedAt: new Date() },
  });

  await runInspection(prisma, download, {
    importJobId: job.id,
    tenantId,
  });

  const updated = await prisma.importJob.findFirst({
    where: { id: job.id, tenantId },
  });
  return updated!;
}

const LIST_SELECT = {
  id: true,
  fileName: true,
  fileSize: true,
  fileMimeType: true,
  mode: true,
  status: true,
  detectedFileType: true,
  detectedRowCount: true,
  detectedColumnCount: true,
  errorMessage: true,
  createdAt: true,
  updatedAt: true,
  uploadConfirmedAt: true,
  inspectionCompletedAt: true,
  createdByUserId: true,
} as const;

export async function listImportJobs(
  prisma: PrismaClient,
  tenantId: string,
  input: ListInput,
) {
  const cursor = decodeCursor(input.cursor);

  const where: Record<string, unknown> = { tenantId };
  if (input.status) where.status = input.status;

  if (cursor) {
    where.AND = [buildCursorWhere(cursor)];
  }

  const totalCountWhere: Record<string, unknown> = { tenantId };
  if (input.status) totalCountWhere.status = input.status;

  const [rowsPlusOne, totalCount] = await Promise.all([
    prisma.importJob.findMany({
      where,
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: input.limit + 1,
      select: LIST_SELECT,
    }),
    prisma.importJob.count({ where: totalCountWhere }),
  ]);

  const hasNext = rowsPlusOne.length > input.limit;
  const items = hasNext ? rowsPlusOne.slice(0, input.limit) : rowsPlusOne;
  const last = items[items.length - 1];
  const nextCursor =
    hasNext && last
      ? encodeCursor({ id: last.id, createdAt: last.createdAt })
      : null;

  return { items, nextCursor, totalCount };
}

export async function getImportJobById(
  prisma: PrismaClient,
  tenantId: string,
  input: GetInput,
) {
  const job = await prisma.importJob.findFirst({
    where: { id: input.id, tenantId },
  });
  if (!job) {
    throw new TRPCError({ code: "NOT_FOUND", message: "ImportJob not found" });
  }
  return job;
}
