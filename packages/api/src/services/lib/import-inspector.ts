/**
 * KAN-896 — Ingestion Cohort 2.1a. Inspection runner.
 *
 * Orchestrates: load ImportJob → verify status='uploaded' → download
 * GCS object → detect type → parse → write detected metadata back to
 * ImportJob row → transition status to 'inspected' (or 'failed').
 *
 * Synchronous in V1: invoked inline from `confirmUpload` so the UI gets
 * the inspection result on a single roundtrip. Future PR 4 (Cohort 2.2)
 * adds entity detection as a separate phase; that may justify async-ing
 * the runner (Pub/Sub trigger), but not yet.
 *
 * Multi-tenant safety: the route layer already verified tenant ownership
 * of the ImportJob before invoking this. Defensive check here too —
 * `findFirst({ where: { id, tenantId } })` — so a future caller that
 * forgets the route-layer check still gets isolation.
 */
import { TRPCError } from "@trpc/server";
import type { PrismaClient } from "@prisma/client";
import {
  detectFileType,
  parseCsvHeadersAndSample,
  parseXlsxHeadersAndSample,
} from "./file-parsers.js";

/**
 * GCS download seam — injected from the caller so tests can stub
 * download without mocking @google-cloud/storage at the module level.
 * Production wiring passes `downloadObject` from import-storage.ts.
 */
export type DownloadFn = (objectPath: string) => Promise<Buffer>;

export interface RunInspectionInput {
  importJobId: string;
  tenantId: string;
}

/**
 * Inspect an uploaded import file. Caller is `confirmUpload` after the
 * GCS object existence check succeeds.
 *
 * Pre-condition: ImportJob row exists, belongs to tenantId, status is
 *                'uploaded' (caller transitions to 'inspecting' before
 *                invoking — see import-jobs-router confirmUpload).
 *
 * Post-condition (happy path):
 *   - status: inspecting → inspected
 *   - detectedFileType, detectedRowCount, detectedColumnCount,
 *     detectedHeaders, sampleRows populated
 *   - inspectionCompletedAt set
 *
 * Post-condition (failure):
 *   - status: inspecting → failed
 *   - errorMessage, errorAt populated
 *   - (does NOT rethrow — caller-friendly; check status to detect)
 */
export async function runInspection(
  prisma: PrismaClient,
  download: DownloadFn,
  input: RunInspectionInput,
): Promise<void> {
  const job = await prisma.importJob.findFirst({
    where: { id: input.importJobId, tenantId: input.tenantId },
    select: {
      id: true,
      status: true,
      fileMimeType: true,
      fileName: true,
      gcsObjectPath: true,
    },
  });
  if (!job) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "ImportJob not found",
    });
  }
  if (job.status !== "inspecting") {
    // Caller is responsible for transitioning to 'inspecting' before
    // calling this — a defensive check catches misuse.
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `Cannot inspect ImportJob in status '${job.status}' (expected 'inspecting')`,
    });
  }

  try {
    const fileType = detectFileType(job.fileMimeType, job.fileName);
    const buffer = await download(job.gcsObjectPath);

    let summary;
    if (fileType === "csv") {
      summary = parseCsvHeadersAndSample(buffer);
    } else if (fileType === "xlsx") {
      summary = parseXlsxHeadersAndSample(buffer);
    } else {
      throw new Error(
        `Unsupported file type — MIME='${job.fileMimeType}', filename='${job.fileName}'. Only CSV + XLSX supported in this cohort.`,
      );
    }

    await prisma.importJob.update({
      where: { id: input.importJobId },
      data: {
        status: "inspected",
        detectedFileType: fileType,
        detectedRowCount: summary.rowCount,
        detectedColumnCount: summary.headers.length,
        detectedHeaders: summary.headers,
        sampleRows: summary.sampleRows,
        inspectionCompletedAt: new Date(),
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.importJob.update({
      where: { id: input.importJobId },
      data: {
        status: "failed",
        errorMessage: message,
        errorAt: new Date(),
      },
    });
    // Do not rethrow — caller checks the returned status to detect failure.
  }
}
