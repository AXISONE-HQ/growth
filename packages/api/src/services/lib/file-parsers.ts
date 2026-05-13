/**
 * KAN-896 — Ingestion Cohort 2.1a. CSV + XLSX parsers for inspection.
 *
 * Pure functions, no GCS / Prisma / network deps. Consumed by
 * import-inspector.ts which orchestrates the download-then-parse flow.
 *
 * Output shape is uniform across both formats so downstream consumers
 * (PR 5 field mapping UI → csv-import-haiku-mapping.runHaikuFieldMapping)
 * don't need to branch on file type.
 *
 * CSV: papaparse with header:true, dynamicTyping:false (preserve strings —
 *      Haiku mapping infers types downstream from sample values).
 * XLSX: SheetJS reads first sheet only; multi-sheet support deferred until
 *       a real customer file needs it.
 */
import Papa from "papaparse";
import * as XLSX from "xlsx";

export type ImportFileTypeName = "csv" | "xlsx" | "unknown";

export interface ParsedFileSummary {
  headers: string[];
  /** First 5 data rows as Record<string, unknown>. Empty array if file
   *  has 0 data rows. */
  sampleRows: Array<Record<string, unknown>>;
  /** Total data rows (excludes header row). */
  rowCount: number;
}

/** Resolve file type from MIME first, then filename extension fallback.
 *  Returns 'unknown' when neither matches a supported format. */
export function detectFileType(
  mimeType: string,
  filename: string,
): ImportFileTypeName {
  // MIME-first detection (HTTP layer authoritative when present).
  if (mimeType === "text/csv") return "csv";
  if (
    mimeType === "application/vnd.ms-excel" ||
    mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  ) {
    return "xlsx";
  }
  // Filename extension fallback (some clients send octet-stream).
  const lower = filename.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) return "xlsx";
  return "unknown";
}

/**
 * Parse a CSV buffer. Uses papaparse with header-row mode.
 *
 * - dynamicTyping:false — preserve string values verbatim. The Haiku
 *   mapping infers types downstream; aggressive type coercion here
 *   would lose information (e.g., "01234" → 1234 drops the leading zero).
 * - skipEmptyLines:'greedy' — discards rows that are entirely whitespace.
 */
export function parseCsvHeadersAndSample(buffer: Buffer): ParsedFileSummary {
  const text = buffer.toString("utf-8");
  const result = Papa.parse<Record<string, string>>(text, {
    header: true,
    dynamicTyping: false,
    skipEmptyLines: "greedy",
  });

  const headers = result.meta.fields ?? [];
  const rows = result.data;
  return {
    headers,
    sampleRows: rows.slice(0, 5),
    rowCount: rows.length,
  };
}

/**
 * Parse an XLSX buffer. Reads first sheet only.
 *
 * SheetJS quirks:
 *  - `defval: null` ensures empty cells render as null (vs undefined),
 *    which matches papaparse behavior for empty CSV cells.
 *  - `raw: false` formats dates/numbers via the cell's display format
 *    string, preserving what the user saw in Excel.
 *  - `cellDates: true` so date cells come back as JS Date objects (then
 *    serialized to ISO strings via JSON.stringify downstream).
 */
export function parseXlsxHeadersAndSample(buffer: Buffer): ParsedFileSummary {
  const workbook = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const firstSheetName = workbook.SheetNames[0];
  if (!firstSheetName) {
    return { headers: [], sampleRows: [], rowCount: 0 };
  }
  const sheet = workbook.Sheets[firstSheetName];

  // sheet_to_json with header:1 returns Array<Array<unknown>>; we want
  // the first row as headers and the rest as data rows.
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: null,
    raw: false,
  });

  if (aoa.length === 0) {
    return { headers: [], sampleRows: [], rowCount: 0 };
  }

  const headerRow = aoa[0] ?? [];
  const headers = headerRow.map((h) => (typeof h === "string" ? h : String(h ?? "")));
  const dataRows = aoa.slice(1);

  const sampleRows: Array<Record<string, unknown>> = dataRows
    .slice(0, 5)
    .map((row) => {
      const obj: Record<string, unknown> = {};
      headers.forEach((header, i) => {
        obj[header] = row[i] ?? null;
      });
      return obj;
    });

  return {
    headers,
    sampleRows,
    rowCount: dataRows.length,
  };
}
