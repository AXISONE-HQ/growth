/**
 * KAN-851 regression guard — Prisma Decimal-as-string render bug.
 *
 * PROD console error caught during visual QA:
 *   `TypeError: e.price.toFixed is not a function`
 *
 * Root cause: Prisma serializes Decimal columns to STRING in JSON
 * ("250.00"), not number. Calling `.toFixed()` directly on the field
 * crashes because String has no `.toFixed`. The fix routes every
 * Decimal-sourced field through `coerceDecimal()` (or `Number()`) first.
 *
 * **What this test guards**: any new `.price.toFixed(` call (or any
 * other Decimal-named field calling Number-typed methods) inside
 * `components/knowledge/` MUST be preceded by a `Number(` coercion on
 * the same expression. This is a static-grep guard — not a substitute
 * for unit tests, but it catches the class of bugs we just shipped.
 *
 * **Sibling unit coverage**: this file also exercises the runtime
 * behavior of `formatServicePrice` against the real PROD payload shape
 * (string Decimal) so a green build means the format helper survives
 * Prisma's JSON wire shape.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatServicePrice, coerceDecimal } from "../../../lib/service-pricing";

const KNOWLEDGE_DIR = join(__dirname, "..");

function walkSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "__tests__" || entry === "node_modules") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...walkSourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.|\.spec\.|\.stories\./.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

describe("KAN-851 — Prisma Decimal coercion regression guard", () => {
  it("no `.toFixed(` call on a Decimal-named field without preceding Number() coercion", () => {
    const files = walkSourceFiles(KNOWLEDGE_DIR);
    expect(files.length).toBeGreaterThan(0);

    // Decimal-typed columns currently in the Prisma schema. Add new
    // Decimal column names here when they're introduced (Service.price,
    // Deal.value, Target.value/currentProgress/projection per
    // packages/db/prisma/schema.prisma at KAN-851 time).
    const decimalFields = ["price", "value", "currentProgress", "projection"];

    const violations: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        for (const field of decimalFields) {
          // Match "x.<field>.toFixed(" — naked Decimal-method call
          const naked = new RegExp(`\\.${field}\\.toFixed\\(`);
          if (naked.test(line)) {
            violations.push(
              `${file}:${i + 1}  →  ${line.trim()}\n  (use Number(x.${field}).toFixed() or formatServicePrice/coerceDecimal helper)`,
            );
          }
        }
      });
    }

    expect(
      violations,
      `KAN-851 regression: Decimal-as-string render bug. Coerce via Number() or coerceDecimal() before calling .toFixed():\n\n${violations.join("\n\n")}`,
    ).toEqual([]);
  });

  it("formatServicePrice handles string-shape Decimal (PROD payload)", () => {
    expect(
      formatServicePrice({
        price: "250.00",
        priceUnit: "PER_HOUR",
        priceCustomLabel: null,
      }),
    ).toBe("$250.00 per hour");
  });

  it("formatServicePrice handles number-shape Decimal (test fixtures)", () => {
    expect(
      formatServicePrice({
        price: 299,
        priceUnit: "PER_MONTH",
        priceCustomLabel: null,
      }),
    ).toBe("$299.00 per month");
  });

  it("formatServicePrice falls back to '(price not set)' on null for non-CUSTOM units", () => {
    expect(
      formatServicePrice({
        price: null,
        priceUnit: "PER_HOUR",
        priceCustomLabel: null,
      }),
    ).toBe("(price not set) per hour");
  });

  it("formatServicePrice uses custom label verbatim on CUSTOM unit", () => {
    expect(
      formatServicePrice({
        price: null,
        priceUnit: "CUSTOM",
        priceCustomLabel: "Sliding scale",
      }),
    ).toBe("Sliding scale");
  });

  it("formatServicePrice falls back to 'Contact for pricing' on CUSTOM with empty label", () => {
    expect(
      formatServicePrice({
        price: null,
        priceUnit: "CUSTOM",
        priceCustomLabel: null,
      }),
    ).toBe("Contact for pricing");
  });

  it("coerceDecimal returns null on null/undefined/non-finite", () => {
    expect(coerceDecimal(null)).toBeNull();
    expect(coerceDecimal(undefined)).toBeNull();
    expect(coerceDecimal("not-a-number")).toBeNull();
    expect(coerceDecimal(Number.NaN)).toBeNull();
  });

  it("coerceDecimal returns finite number for both string and number shapes", () => {
    expect(coerceDecimal("250.00")).toBe(250);
    expect(coerceDecimal("0.99")).toBe(0.99);
    expect(coerceDecimal(42)).toBe(42);
    expect(coerceDecimal(0)).toBe(0);
  });
});
