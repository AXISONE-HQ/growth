/**
 * DS v1 alignment cohort — foundation-pattern regression guard.
 *
 * Static checks across the components/ tree (excluding shadcn primitives in
 * components/ui/). Catches regressions BEFORE they ship by enforcing the
 * spec-mandated patterns at test time.
 *
 * Spec: docs/design-system/v1.md
 *   - Part 1 §Typography (rule: two weights only — 400 + 500. No 600/700.)
 *   - Part 1 §Typography (rule: no hardcoded text-[Npx] — use type-scale tokens)
 *   - Part 5 §Forbidden words (full list + KAN-829 carry-over)
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const KNOWLEDGE_DIR = path.resolve(__dirname, "../knowledge");
const GROWTH_DIR = path.resolve(__dirname, "../growth");

interface SourceFile {
  path: string;
  basename: string;
  content: string;
}

function listTsxAndTs(dir: string): SourceFile[] {
  if (!fs.existsSync(dir)) return [];
  const out: SourceFile[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile() && (entry.name.endsWith(".tsx") || entry.name.endsWith(".ts"))) {
      if (entry.name.endsWith(".test.tsx") || entry.name.endsWith(".test.ts")) continue;
      const full = path.join(dir, entry.name);
      out.push({
        path: full,
        basename: entry.name,
        content: fs.readFileSync(full, "utf8"),
      });
    }
  }
  return out;
}

const knowledgeSources = listTsxAndTs(KNOWLEDGE_DIR);
const growthSources = listTsxAndTs(GROWTH_DIR);
const allSources = [...knowledgeSources, ...growthSources];

describe("DS v1 foundation-pattern — regression guard", () => {
  it("inventory: at least 8 component files audited", () => {
    // Sanity check — if directory restructuring shrinks this drastically, the
    // guard could pass on an empty corpus. Pin the floor.
    expect(allSources.length).toBeGreaterThanOrEqual(8);
  });

  it("Test 1 — no hardcoded text-[Npx] classes (must use spec type-scale tokens)", () => {
    // Allowed: text-[var(...)] for inline CSS-var-driven sizing, but bare pixel
    // values like text-[15px] indicate someone bypassed the type scale.
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const src of allSources) {
      const lines = src.content.split("\n");
      lines.forEach((line, idx) => {
        // Match `text-[Npx]` where N is digits — e.g. text-[13px], text-[15px]
        if (/text-\[\d+px\]/.test(line)) {
          offenders.push({ file: src.basename, line: idx + 1, text: line.trim() });
        }
      });
    }
    expect(
      offenders,
      `Hardcoded text-[Npx] classes detected. Use type-scale tokens (.text-display / .text-h1 / .text-h2 / .text-h3 / .text-body-lg / .text-body / .text-label / .text-caption / .text-micro / .text-mono-sm) per spec Part 1.\nFound:\n${offenders.map((o) => `  ${o.file}:${o.line} → ${o.text}`).join("\n")}`,
    ).toEqual([]);
  });

  it("Test 2 — two-weight rule: no font-semibold or font-bold (only 400 + 500 via type scale)", () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    for (const src of allSources) {
      const lines = src.content.split("\n");
      lines.forEach((line, idx) => {
        // Strip comments before matching — the rule itself is referenced in
        // JSDoc and shouldn't trigger.
        const codeOnly = line.replace(/\/\/.*$/, "").replace(/\/\*[\s\S]*?\*\//, "");
        // Match font-semibold or font-bold OR font-[600] or font-[700]
        if (/\bfont-(semibold|bold)\b/.test(codeOnly) || /font-\[(600|700)\]/.test(codeOnly)) {
          offenders.push({ file: src.basename, line: idx + 1, text: line.trim() });
        }
      });
    }
    expect(
      offenders,
      `font-semibold / font-bold detected. DS v1 spec Part 1 §Typography rule: two weights only (400 + 500). Use .text-h1/h2/h3/label/micro for medium-weight text (which bundles weight 500), or font-medium for inline overrides.\nFound:\n${offenders.map((o) => `  ${o.file}:${o.line} → ${o.text}`).join("\n")}`,
    ).toEqual([]);
  });

  it("Test 3 — forbidden microcopy across all components/{knowledge,growth}/", () => {
    // Full list per spec Part 5 + KAN-829 carry-overs.
    const FORBIDDEN: string[] = [
      "magic",
      "simply",
      "easily",
      "seamlessly",
      "revolutionary",
      "cutting-edge",
      "leverage",
      "synergy",
      "unfortunately",
      "please",
      "sorry",
      "unleash",
      "supercharge",
      "unlock the power",
      "take it to the next level",
      "limited time",
      "hurry",
      "exclusive",
      "premium experience",
    ];

    const offenders: Array<{ file: string; line: number; word: string; text: string }> = [];

    for (const src of allSources) {
      const lines = src.content.split("\n");
      lines.forEach((line, idx) => {
        // Skip comment-only lines — JSDoc references the forbidden words by
        // name (e.g., `forbidden words: magic, simply, just, ...`). The audit
        // should only catch user-rendered strings.
        const trimmed = line.trim();
        if (
          trimmed.startsWith("//") ||
          trimmed.startsWith("*") ||
          trimmed.startsWith("/*") ||
          trimmed.startsWith("/**")
        ) {
          return;
        }
        const lower = line.toLowerCase();
        for (const word of FORBIDDEN) {
          const re = new RegExp(`\\b${word.replace(/-/g, "[-]").replace(/ /g, "\\s+")}\\b`);
          if (re.test(lower)) {
            offenders.push({
              file: src.basename,
              line: idx + 1,
              word,
              text: line.trim(),
            });
          }
        }
        // "just" — only allowed inside `relativeTime()` formatter (the literal
        // string "just now"). Components/knowledge consumers all import it
        // from @/lib/relative-time, so the source files in this corpus must
        // not contain the word "just" at all.
        if (/\bjust\b/.test(lower)) {
          offenders.push({
            file: src.basename,
            line: idx + 1,
            word: "just (allowed only in lib/relative-time.ts)",
            text: line.trim(),
          });
        }
      });
    }

    expect(
      offenders,
      `Forbidden microcopy detected.\nFound:\n${offenders.map((o) => `  ${o.file}:${o.line} [${o.word}] → ${o.text}`).join("\n")}`,
    ).toEqual([]);
  });
});
