/**
 * KAN-707 PR B — Document upload ingestion path.
 *
 * Whitelisted content types (V1):
 *   - pdf  → pdf-parse
 *   - docx → mammoth
 *   - txt  → raw read
 *   - md   → raw read (markdown rendered to plain text by stripping
 *            common markdown punctuation; full MD → text rendering is
 *            future work)
 *
 * Size cap: 50MB. Larger files reject with a clear error before download
 * begins (the file_size_bytes check on KAN-728's GCS upload metadata, when
 * we add it; for now V1 trusts the upload pipeline to enforce).
 *
 * Out of scope for V1 (filed separately):
 *   - Image-only PDFs (OCR) — KAN-728 follow-up
 *   - Encrypted PDFs — KAN-728 follow-up
 *   - Virus scan — KAN-729 follow-up
 *   - Additional types (HTML upload, EPUB, etc.) — KAN-728 follow-up
 */
import { chunkText } from "../knowledge-chunker.js";
import type { IngestionPathInput, IngestionPathResult, PathHandler, PathHandlerDeps } from "./types.js";

const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50MB

function inferContentType(filename: string): "pdf" | "docx" | "txt" | "md" | "unknown" {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".pdf")) return "pdf";
  if (lower.endsWith(".docx")) return "docx";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  return "unknown";
}

async function parseToText(
  contentType: "pdf" | "docx" | "txt" | "md",
  buffer: Buffer,
): Promise<string> {
  switch (contentType) {
    case "txt":
    case "md":
      return buffer.toString("utf8");
    case "pdf": {
      // pdf-parse default export is a function returning { text, numpages, ... }.
      const pdfParse = (await import("pdf-parse")).default;
      const r = await pdfParse(buffer);
      return r.text;
    }
    case "docx": {
      const mammoth = await import("mammoth");
      const r = await mammoth.extractRawText({ buffer });
      return r.value;
    }
  }
}

export const ingestDocument: PathHandler = async (
  input: IngestionPathInput,
  deps: PathHandlerDeps,
): Promise<IngestionPathResult> => {
  if (input.path !== "document") {
    throw new Error(`ingestDocument: wrong path discriminator ${input.path}`);
  }

  const contentType = inferContentType(input.originalFileName);
  if (contentType === "unknown") {
    throw new Error(
      `Unsupported file type for ${input.originalFileName} (allowed: .pdf, .docx, .txt, .md)`,
    );
  }

  const buffer = await deps.downloadFile(input.uploadedFileRef);
  if (buffer.length > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File ${input.originalFileName} exceeds size cap (${buffer.length} > ${MAX_FILE_SIZE_BYTES} bytes / 50MB)`,
    );
  }

  const text = await parseToText(contentType, buffer);
  const chunks = chunkText(text);

  const warnings: string[] = [];
  if (chunks.length === 0) {
    warnings.push(`Document ${input.originalFileName} parsed to empty text — possibly image-only PDF or empty file`);
  }

  return {
    chunks,
    urlsDiscovered: 0,
    urlsIndexed: 0,
    warnings,
  };
};
