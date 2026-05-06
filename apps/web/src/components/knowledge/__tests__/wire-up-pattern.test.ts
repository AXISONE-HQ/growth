/**
 * KAN-829 sub-cohort 7 — wire-up-pattern regression guard.
 *
 * Static-grep across `apps/web/src/components/knowledge/*.tsx`:
 *   1. zero relative `/api/...` fetch URLs   — must use `${API_BASE}/...`
 *   2. zero `credentials:"include"` fetches   — apps/api ignores cookies;
 *      auth flows through `Authorization: Bearer` + `x-tenant-id` headers
 *      provided by `buildHeaders()`
 *
 * If this test fails, a new fetch callsite has been added that doesn't go
 * through the canonical `${API_BASE}` + `buildHeaders()` plumbing. Fix the
 * callsite — don't pin the test to the regression.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const KNOWLEDGE_DIR = path.resolve(__dirname, "..");

function listSourceFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(".tsx") && !d.name.endsWith(".test.tsx"))
    .map((d) => path.join(dir, d.name));
}

describe("wire-up pattern — KAN-829 sub-cohort 7 regression guard", () => {
  const files = listSourceFiles(KNOWLEDGE_DIR);

  it("inventory: at least 5 .tsx component files in components/knowledge/", () => {
    // Sanity check — if the directory shrinks unexpectedly the test still
    // does its job, but a 0-file run would silently pass without checking.
    expect(files.length).toBeGreaterThanOrEqual(5);
  });

  it("zero relative /api/ fetch URLs — must use ${API_BASE} prefix", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        // Match `fetch("/api/...` or `fetch(`/api/...` (any quote style).
        // Excludes `fetch(`${API_BASE}/api/...` because that starts with `${`.
        if (/fetch\s*\(\s*["'`]\/api\//.test(line)) {
          offenders.push({ file: path.basename(file), line: idx + 1, text: line.trim() });
        }
      });
    }
    expect(
      offenders,
      `Relative /api/ fetch callsite(s) detected. Use \`\${API_BASE}/api/...\` and pass headers via buildHeaders().\nFound:\n${offenders.map((o) => `  ${o.file}:${o.line} → ${o.text}`).join("\n")}`,
    ).toEqual([]);
  });

  it('zero credentials:"include" — auth flows through Authorization Bearer + x-tenant-id headers', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        // Strip JSDoc/inline comment content before matching so prose doesn't
        // trip the guard. Then check for the actual code-token pattern.
        const codeOnly = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//, "");
        if (/credentials\s*:\s*["']include["']/.test(codeOnly)) {
          offenders.push({ file: path.basename(file), line: idx + 1, text: line.trim() });
        }
      });
    }
    expect(
      offenders,
      `credentials:"include" cookie-auth detected. apps/api ignores cookies — use buildHeaders() for Authorization Bearer + x-tenant-id.\nFound:\n${offenders.map((o) => `  ${o.file}:${o.line} → ${o.text}`).join("\n")}`,
    ).toEqual([]);
  });
});
