/**
 * KAN-896 — file-parsers.ts unit tests.
 *
 * Coverage:
 *   - detectFileType: MIME-first then extension fallback then 'unknown'
 *   - parseCsvHeadersAndSample: basic / quoted / empty / 1-row scenarios
 *   - parseXlsxHeadersAndSample: basic / empty / multi-sheet (first only)
 *
 * XLSX fixtures are generated in-test via the SheetJS `xlsx` library to
 * avoid checking binary blobs into the repo. CSV fixtures are inline
 * strings.
 */
import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  detectFileType,
  parseCsvHeadersAndSample,
  parseXlsxHeadersAndSample,
} from "../lib/file-parsers.js";

describe("KAN-896 — detectFileType", () => {
  it("returns 'csv' for text/csv MIME", () => {
    expect(detectFileType("text/csv", "anything.bin")).toBe("csv");
  });

  it("returns 'xlsx' for both XLSX MIME variants", () => {
    expect(
      detectFileType(
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "x.bin",
      ),
    ).toBe("xlsx");
    expect(detectFileType("application/vnd.ms-excel", "x.bin")).toBe("xlsx");
  });

  it("falls back to filename .csv when MIME is octet-stream", () => {
    expect(detectFileType("application/octet-stream", "leads.csv")).toBe("csv");
  });

  it("falls back to filename .xlsx / .xls when MIME is octet-stream", () => {
    expect(detectFileType("application/octet-stream", "leads.xlsx")).toBe(
      "xlsx",
    );
    expect(detectFileType("application/octet-stream", "old.xls")).toBe("xlsx");
  });

  it("returns 'unknown' when neither MIME nor extension matches", () => {
    expect(detectFileType("application/pdf", "leads.pdf")).toBe("unknown");
    expect(detectFileType("text/plain", "notes.txt")).toBe("unknown");
  });
});

describe("KAN-896 — parseCsvHeadersAndSample", () => {
  it("parses a basic 2-column CSV with header row", () => {
    const csv = "email,firstName\nalice@x.com,Alice\nbob@x.com,Bob\n";
    const result = parseCsvHeadersAndSample(Buffer.from(csv));
    expect(result.headers).toEqual(["email", "firstName"]);
    expect(result.rowCount).toBe(2);
    expect(result.sampleRows).toEqual([
      { email: "alice@x.com", firstName: "Alice" },
      { email: "bob@x.com", firstName: "Bob" },
    ]);
  });

  it("caps sampleRows at 5 even when file has more", () => {
    const rows = Array.from({ length: 10 }, (_, i) => `r${i}@x.com,Name${i}`);
    const csv = "email,name\n" + rows.join("\n");
    const result = parseCsvHeadersAndSample(Buffer.from(csv));
    expect(result.rowCount).toBe(10);
    expect(result.sampleRows.length).toBe(5);
    expect(result.sampleRows[0]).toEqual({ email: "r0@x.com", name: "Name0" });
    expect(result.sampleRows[4]).toEqual({ email: "r4@x.com", name: "Name4" });
  });

  it("handles quoted values with embedded commas", () => {
    const csv = 'name,address\n"Alice","123 Main St, Apt 4"\n';
    const result = parseCsvHeadersAndSample(Buffer.from(csv));
    expect(result.rowCount).toBe(1);
    expect(result.sampleRows[0]).toEqual({
      name: "Alice",
      address: "123 Main St, Apt 4",
    });
  });

  it("returns 0 rows for header-only CSV", () => {
    const csv = "email,firstName\n";
    const result = parseCsvHeadersAndSample(Buffer.from(csv));
    expect(result.headers).toEqual(["email", "firstName"]);
    expect(result.rowCount).toBe(0);
    expect(result.sampleRows).toEqual([]);
  });

  it("skips empty lines (greedy mode)", () => {
    const csv = "email,name\n\nalice@x.com,Alice\n\n\nbob@x.com,Bob\n";
    const result = parseCsvHeadersAndSample(Buffer.from(csv));
    expect(result.rowCount).toBe(2);
  });
});

describe("KAN-896 — parseXlsxHeadersAndSample", () => {
  it("parses a basic 2-column sheet with header row", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([
      ["email", "firstName"],
      ["alice@x.com", "Alice"],
      ["bob@x.com", "Bob"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const result = parseXlsxHeadersAndSample(Buffer.from(buffer));
    expect(result.headers).toEqual(["email", "firstName"]);
    expect(result.rowCount).toBe(2);
    expect(result.sampleRows[0]).toEqual({
      email: "alice@x.com",
      firstName: "Alice",
    });
  });

  it("returns 0 rows for empty workbook", () => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const result = parseXlsxHeadersAndSample(Buffer.from(buffer));
    expect(result.headers).toEqual([]);
    expect(result.rowCount).toBe(0);
    expect(result.sampleRows).toEqual([]);
  });

  it("reads only the first sheet (multi-sheet workbook)", () => {
    const wb = XLSX.utils.book_new();
    const ws1 = XLSX.utils.aoa_to_sheet([
      ["sheet1_col"],
      ["sheet1_val_a"],
    ]);
    const ws2 = XLSX.utils.aoa_to_sheet([
      ["sheet2_col"],
      ["sheet2_val_a"],
      ["sheet2_val_b"],
    ]);
    XLSX.utils.book_append_sheet(wb, ws1, "First");
    XLSX.utils.book_append_sheet(wb, ws2, "Second");
    const buffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const result = parseXlsxHeadersAndSample(Buffer.from(buffer));
    // First sheet has 1 data row + 1 header. Second sheet ignored.
    expect(result.headers).toEqual(["sheet1_col"]);
    expect(result.rowCount).toBe(1);
    expect(result.sampleRows[0]).toEqual({ sheet1_col: "sheet1_val_a" });
  });
});
