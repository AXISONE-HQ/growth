/**
 * Regression guard for the BrainSnapshot schema/query drift bug that
 * shipped a 500 on every authenticated account.get fetch.
 *
 * History:
 *   - `getBlueprintForTenant` in `packages/api/src/services/blueprint-loader.ts`
 *     queried `prisma.brainSnapshot.findFirst({ where: { tenantId,
 *     status: 'active' }, ... })` and read `snapshot.blueprintData`.
 *   - Both `status` and `blueprintData` were never fields of the actual
 *     `BrainSnapshot` Prisma model. Verified across all git history of
 *     `packages/db/prisma/schema.prisma` + the deleted legacy
 *     `apps/api/prisma/schema.prisma`. Real fields: id, tenantId,
 *     companyTruth, behavioralModel, outcomeModel, version, createdAt.
 *   - Pre-KAN-859 the function was unreachable from any live route.
 *     KAN-859 (Cohort 4) wired `account.get` → `loadBlueprintLoader` →
 *     `getBlueprintForTenant` for the Legal tab's `legalDefaults`
 *     resolver. The latent bug surfaced as a 500 on every authenticated
 *     `account.get` fetch in PROD.
 *
 * **Narrow scope intentional.** This guard pins ONLY the
 * `getBlueprintForTenant` callsite + the BrainSnapshot field set this
 * PR touches. The 18+ sibling broken sites in `company-truth.ts` and
 * `onboarding-wizard.ts` are tracked in the omnibus follow-up
 * "BrainSnapshot persistence rearchitecture". Don't widen this guard
 * to fail-fail those sites here — the broader codebase failure is
 * out of scope for this PR.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");

/** Parse the field names of a single Prisma model from schema.prisma. */
function readPrismaModelFields(schemaPath: string, modelName: string): string[] {
  const src = readFileSync(schemaPath, "utf-8");
  const re = new RegExp(String.raw`model\s+${modelName}\s*\{([\s\S]*?)\}`, "m");
  const m = src.match(re);
  if (!m) return [];
  const body = m[1] ?? "";
  const fields: string[] = [];
  for (const line of body.split("\n")) {
    const stripped = line.trim();
    if (!stripped) continue;
    if (stripped.startsWith("//")) continue;
    if (stripped.startsWith("@@")) continue;
    const fieldMatch = stripped.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s+\S+/);
    if (fieldMatch) fields.push(fieldMatch[1]!);
  }
  return fields;
}

const BLUEPRINT_LOADER_PATH = resolve(
  REPO_ROOT,
  "packages/api/src/services/blueprint-loader.ts",
);
const SCHEMA_PATH = resolve(REPO_ROOT, "packages/db/prisma/schema.prisma");

describe("BrainSnapshot schema drift — getBlueprintForTenant guard", () => {
  it("BrainSnapshot model in schema.prisma still has no `status` or `blueprintData` field (validates the assumption this guard rests on)", () => {
    const fields = readPrismaModelFields(SCHEMA_PATH, "BrainSnapshot");
    expect(fields.length, "BrainSnapshot model not found in schema.prisma").toBeGreaterThan(0);
    expect(fields).not.toContain("status");
    expect(fields).not.toContain("blueprintData");
    // The fields that *should* be there:
    for (const expected of ["id", "tenantId", "companyTruth", "behavioralModel", "outcomeModel", "version", "createdAt"]) {
      expect(fields).toContain(expected);
    }
  });

  it("getBlueprintForTenant does not query non-existent BrainSnapshot fields (status / blueprintData)", () => {
    const src = readFileSync(BLUEPRINT_LOADER_PATH, "utf-8");
    // Locate the function body. Match `async function getBlueprintForTenant`
    // up to the next top-level declaration or function (`function ` /
    // `async function ` / `export ` / EOF). Body lives between the first
    // `{` and its matching `}`; we approximate by reading from the opener
    // until we re-hit a line starting `}` at column 0.
    const startIdx = src.indexOf("async function getBlueprintForTenant");
    expect(startIdx, "getBlueprintForTenant declaration not found").toBeGreaterThan(-1);
    const openBraceIdx = src.indexOf("{", startIdx);
    let depth = 0;
    let endIdx = openBraceIdx;
    for (let i = openBraceIdx; i < src.length; i++) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      }
    }
    const body = src.slice(openBraceIdx, endIdx + 1);
    expect(body, "getBlueprintForTenant body did not parse").toMatch(/^\{/);
    // Forbidden references inside this function:
    expect(
      body.includes("status:"),
      "getBlueprintForTenant must not reference `status:` — BrainSnapshot has no status field",
    ).toBe(false);
    expect(
      body.includes("blueprintData"),
      "getBlueprintForTenant must not reference `blueprintData` — BrainSnapshot has no blueprintData field",
    ).toBe(false);
  });

  it("getBlueprintForTenant returns null synchronously without throwing (current behavior pending omnibus follow-up)", async () => {
    // Variable-specifier dynamic import keeps the cross-rootDir
    // packages/api source out of the static TS6059 graph (KAN-689
    // cohort hygiene — same pattern used everywhere apps/api imports
    // from packages/api).
    const spec = "../../../../packages/api/src/services/blueprint-loader.js";
    const mod = (await import(spec)) as {
      getBlueprintForTenant: (tenantId: string) => Promise<unknown>;
    };
    const result = await mod.getBlueprintForTenant("any-tenant-id");
    expect(result).toBeNull();
  });
});
