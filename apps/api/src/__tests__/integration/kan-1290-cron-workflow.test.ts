/**
 * KAN-1290 Slice 6 Item 3 — GH Actions cron workflow contract test.
 *
 * The daily inventory-sync workflow (`.github/workflows/inventory-sync-daily.yml`)
 * executes three shell steps:
 *
 *   1. curl-fetch the dealer JSON (`/tmp/dealer-feed.json`)
 *   2. jq-assemble the reconcile payload (`/tmp/reconcile-payload.json`)
 *      → wraps the dealer entries in `{ entries: [...], source: "..." }`
 *   3. curl-POST the payload to `/api/v1/inventory/reconcile`
 *
 * This test exercises step 2 — the jq transformation — as a permanent
 * regression guard against the contract between the workflow YAML and the
 * `inventorySyncApp.post('/reconcile', ...)` handler in
 * `apps/api/src/routes/inventory-sync.ts`. Per Memo 56 micro-fix-forward-
 * with-codification-test: codify the operational contract after the first
 * empirical signal (PR #382 fix-forward URL-correction) so future workflow
 * edits surface contract-shape regressions in unit time.
 *
 * # Why test the YAML directly
 *
 * The workflow uses jq inline via heredoc. Without this test, a future YAML
 * edit could silently change the payload shape (e.g. drop the `entries`
 * key, rename `source`) and the daily cron would only fail post-deploy on
 * next firing. Pulling the jq command out of the YAML + running it locally
 * against a fixture catches contract regressions at PR time.
 *
 * # Non-coverage
 *
 * - curl steps (fetch + POST) are environment-dependent and intentionally
 *   NOT exercised. The endpoint contract itself is covered by
 *   `kan-1219-inventory-sync.test.ts` scenarios 6 + 7.
 * - Auth header handling: covered upstream.
 * - jq binary availability: skipped on CI runners that lack jq (vitest
 *   `it.skip` guard).
 */
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const WORKFLOW_PATH = join(
  process.cwd(),
  ".github/workflows/inventory-sync-daily.yml",
);

function hasJq(): boolean {
  try {
    execSync("jq --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function extractJqCommand(workflowYaml: string): string {
  // The workflow's "Build reconcile payload" step embeds:
  //   jq -n \
  //     --slurpfile entries /tmp/dealer-feed.json \
  //     '{ entries: $entries[0], source: "github-actions-daily-cron" }' \
  //     > /tmp/reconcile-payload.json
  // Pull the jq expression literal directly — single-quote-delimited.
  const match = workflowYaml.match(/jq -n[^']+'([^']+)'/);
  if (!match || !match[1]) {
    throw new Error(
      "Could not locate jq expression in workflow YAML. Did the Build " +
        "reconcile payload step shape change?",
    );
  }
  return match[1];
}

describe("KAN-1290 Slice 6 — GH Actions inventory-sync workflow contract", () => {
  it.skipIf(!hasJq())(
    "scenario 1 — jq assembly produces the reconcile-endpoint contract shape",
    () => {
      const yaml = readFileSync(WORKFLOW_PATH, "utf8");
      const jqExpr = extractJqCommand(yaml);

      // The workflow's actual jq expression literal.
      expect(jqExpr).toMatch(/entries/);
      expect(jqExpr).toMatch(/source/);
      expect(jqExpr).toMatch(/github-actions-daily-cron/);

      // Fixture dealer feed matching the 4mkauto JSON shape.
      const fixture = [
        {
          car_vin: "1HGCM82633A123456",
          car_year: "2024",
          maker: "Honda",
          model: "Accord",
          car_body: "sedan",
          car_transmission: "automatic",
          car_fuel_type: "gasoline",
          car_drivetrain: "fwd",
          condition: "used",
        },
      ];
      const dir = mkdtempSync(join(tmpdir(), "kan-1290-cron-"));
      const feedPath = join(dir, "dealer-feed.json");
      writeFileSync(feedPath, JSON.stringify(fixture));

      // Run the exact jq expression from the workflow against the fixture.
      const out = execSync(
        `jq -n --slurpfile entries ${feedPath} '${jqExpr}'`,
        { encoding: "utf8" },
      );
      const payload = JSON.parse(out) as {
        entries?: unknown;
        source?: unknown;
      };

      // Contract: { entries: <array>, source: <string> } — matches the
      // body shape parsed in inventorySyncApp.post('/reconcile', ...).
      expect(Array.isArray(payload.entries)).toBe(true);
      expect(payload.source).toBe("github-actions-daily-cron");
      // Round-trip: jq preserves the dealer entries unchanged.
      expect(payload.entries).toEqual(fixture);
    },
  );

  it("scenario 2 — workflow references the empirically-validated dealer URL", () => {
    // Post-PR-#382 fix-forward: the workflow MUST target the validated
    // cars_formatted.json path (wp-json/cars/v1/all returns HTML 301).
    // Regression guard against a future edit reverting to the wrong URL.
    const yaml = readFileSync(WORKFLOW_PATH, "utf8");
    expect(yaml).toContain(
      "www.4mkauto.com/wp-content/themes/astra/car_single_page_data/cars_formatted.json",
    );
    expect(yaml).not.toMatch(/4mkauto\.com\/wp-json\/cars\/v1\/all/);
  });

  it("scenario 3 — workflow declares the required GH Actions secrets contract", () => {
    // The workflow consumes INVENTORY_SYNC_API_BASE + INVENTORY_SYNC_KEY_4MKAUTO
    // via secrets.*. If a future edit renames either secret, the daily cron
    // breaks silently (the env var becomes undefined). Codify the contract.
    const yaml = readFileSync(WORKFLOW_PATH, "utf8");
    expect(yaml).toContain("INVENTORY_SYNC_API_BASE");
    expect(yaml).toContain("INVENTORY_SYNC_KEY_4MKAUTO");
    expect(yaml).toContain("X-AxisOne-API-Key");
  });

  it("scenario 4 — workflow fails the reconcile step on non-200 HTTP response", () => {
    // The reconcile step explicitly tests HTTP_CODE != 200 and exits 1.
    // Codify that contract; a future "always exit 0" regression would let
    // the daily cron false-report success.
    const yaml = readFileSync(WORKFLOW_PATH, "utf8");
    expect(yaml).toMatch(/if \[ "\$\{HTTP_CODE\}" != "200" \]/);
    expect(yaml).toMatch(/exit 1/);
  });
});
