import { describe, it, expect } from "vitest";
import {
  checkUrl,
  checkUploadedFile,
  checkQaPair,
  isInProgress,
  STATUS_VARIANT,
  MAX_UPLOAD_BYTES,
  ALLOWED_DOC_EXTENSIONS,
} from "../knowledge-validation.js";

describe("checkUrl", () => {
  it("requires HTTPS", () => {
    expect(checkUrl("http://example.com").ok).toBe(false);
    expect(checkUrl("https://example.com").ok).toBe(true);
  });
  it("rejects empty / whitespace input", () => {
    expect(checkUrl("").ok).toBe(false);
    expect(checkUrl("   ").ok).toBe(false);
  });
  it("rejects unparseable URLs", () => {
    expect(checkUrl("https://").ok).toBe(false);
    expect(checkUrl("not a url").ok).toBe(false);
  });
  it("accepts valid HTTPS with path + query", () => {
    expect(checkUrl("https://example.com/about?ref=docs").ok).toBe(true);
  });
});

describe("checkUploadedFile", () => {
  it("requires non-empty name", () => {
    expect(checkUploadedFile({ name: "", size: 100 }).ok).toBe(false);
  });
  it("requires a whitelisted extension", () => {
    expect(checkUploadedFile({ name: "doc.exe", size: 100 }).ok).toBe(false);
    expect(checkUploadedFile({ name: "doc.xlsx", size: 100 }).ok).toBe(false);
  });
  it("accepts each allowed extension", () => {
    for (const ext of ALLOWED_DOC_EXTENSIONS) {
      const r = checkUploadedFile({ name: `file${ext}`, size: 100 });
      expect(r.ok).toBe(true);
    }
  });
  it("rejects empty files", () => {
    expect(checkUploadedFile({ name: "x.pdf", size: 0 }).ok).toBe(false);
  });
  it("rejects files over 50MB", () => {
    expect(checkUploadedFile({ name: "x.pdf", size: MAX_UPLOAD_BYTES + 1 }).ok).toBe(false);
    expect(checkUploadedFile({ name: "x.pdf", size: MAX_UPLOAD_BYTES }).ok).toBe(true);
  });
});

describe("checkQaPair", () => {
  it("requires both fields", () => {
    expect(checkQaPair({ question: "", answer: "A" }).ok).toBe(false);
    expect(checkQaPair({ question: "Q", answer: "" }).ok).toBe(false);
  });
  it("enforces length caps", () => {
    expect(checkQaPair({ question: "x".repeat(2001), answer: "A" }).ok).toBe(false);
    expect(checkQaPair({ question: "Q", answer: "x".repeat(10001) }).ok).toBe(false);
  });
  it("accepts valid pairs", () => {
    expect(checkQaPair({ question: "What is X?", answer: "X is Y" }).ok).toBe(true);
  });
});

describe("isInProgress + STATUS_VARIANT", () => {
  it("flags pending + processing as in-progress; others not", () => {
    expect(isInProgress("pending")).toBe(true);
    expect(isInProgress("processing")).toBe(true);
    expect(isInProgress("indexed")).toBe(false);
    expect(isInProgress("failed")).toBe(false);
    expect(isInProgress("stale")).toBe(false);
  });
  it("maps each status to a variant", () => {
    expect(STATUS_VARIANT.pending).toBe("info");
    expect(STATUS_VARIANT.indexed).toBe("success");
    expect(STATUS_VARIANT.failed).toBe("destructive");
    expect(STATUS_VARIANT.stale).toBe("warning");
  });
});
