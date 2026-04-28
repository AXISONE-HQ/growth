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
  it("requires a non-empty name", () => {
    expect(checkUploadedFile({ name: "", size: 100 }).ok).toBe(false);
    expect(checkUploadedFile({ name: "   ", size: 100 }).ok).toBe(false);
  });
  it("rejects unsupported extensions", () => {
    expect(checkUploadedFile({ name: "image.png", size: 100 }).ok).toBe(false);
    expect(checkUploadedFile({ name: "data.csv", size: 100 }).ok).toBe(false);
  });
  it("accepts whitelisted extensions", () => {
    for (const ext of ALLOWED_DOC_EXTENSIONS) {
      expect(checkUploadedFile({ name: `doc${ext}`, size: 100 }).ok).toBe(true);
    }
  });
  it("rejects empty files", () => {
    expect(checkUploadedFile({ name: "doc.pdf", size: 0 }).ok).toBe(false);
    expect(checkUploadedFile({ name: "doc.pdf", size: -1 }).ok).toBe(false);
  });
  it("rejects files exceeding the size cap", () => {
    expect(checkUploadedFile({ name: "doc.pdf", size: MAX_UPLOAD_BYTES + 1 }).ok).toBe(false);
  });
  it("accepts files at the exact size cap", () => {
    expect(checkUploadedFile({ name: "doc.pdf", size: MAX_UPLOAD_BYTES }).ok).toBe(true);
  });
});

describe("checkQaPair", () => {
  it("requires non-empty question and answer", () => {
    expect(checkQaPair({ question: "", answer: "a" }).ok).toBe(false);
    expect(checkQaPair({ question: "q", answer: "" }).ok).toBe(false);
    expect(checkQaPair({ question: "   ", answer: "   " }).ok).toBe(false);
  });
  it("enforces length caps", () => {
    expect(checkQaPair({ question: "q".repeat(2001), answer: "a" }).ok).toBe(false);
    expect(checkQaPair({ question: "q", answer: "a".repeat(10001) }).ok).toBe(false);
  });
  it("accepts valid pairs", () => {
    expect(checkQaPair({ question: "Refund policy?", answer: "5 days" }).ok).toBe(true);
  });
});

describe("isInProgress", () => {
  it("returns true for pending and processing", () => {
    expect(isInProgress("pending")).toBe(true);
    expect(isInProgress("processing")).toBe(true);
  });
  it("returns false for terminal statuses", () => {
    expect(isInProgress("indexed")).toBe(false);
    expect(isInProgress("failed")).toBe(false);
    expect(isInProgress("stale")).toBe(false);
  });
});

describe("STATUS_VARIANT", () => {
  it("maps every KnowledgeSourceStatus to a UI variant", () => {
    expect(STATUS_VARIANT.pending).toBe("info");
    expect(STATUS_VARIANT.processing).toBe("info");
    expect(STATUS_VARIANT.indexed).toBe("success");
    expect(STATUS_VARIANT.failed).toBe("destructive");
    expect(STATUS_VARIANT.stale).toBe("warning");
  });
});
