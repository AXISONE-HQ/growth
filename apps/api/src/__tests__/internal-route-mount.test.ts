/**
 * KAN-866 fix-forward — `/internal` mount-prefix regression guard.
 *
 * Catches the double-prefix bug that bit the Cohort 6 close-out smoke
 * gate: an inner Hono sub-app declared a route as
 * `/internal/account-field-updated-subscriber` AND was mounted at the
 * `/internal` prefix in `index.ts`, putting the live URL at
 * `/internal/internal/account-field-updated-subscriber` — 404 against
 * the URL Terraform's `push_endpoint` targeted.
 *
 * Static-analysis approach: read `index.ts` + each sub-app source,
 * resolve the live URL each route lands at (mount-prefix + declared
 * route), and compare against the contract below — the same URLs that
 * Terraform / Cloud Tasks call sites dispatch against.
 *
 * Static analysis avoids booting the full app (which is `serve()`d at
 * module load — testability anti-pattern, separate cleanup ticket).
 *
 * Adding a new internal endpoint? Add it to `EXPECTED_LIVE_URLS` in
 * the SAME PR as the route + Terraform / task client.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../../../..");

interface ExpectedLiveUrl {
  /** What Terraform / Cloud Tasks call sites point at. */
  liveUrl: string;
  /** Source file declaring the inner Hono route. */
  innerSourcePath: string;
  description: string;
}

const EXPECTED_LIVE_URLS: readonly ExpectedLiveUrl[] = [
  {
    liveUrl: "/internal/account-field-updated-subscriber",
    innerSourcePath:
      "apps/api/src/internal/account-field-updated-subscriber.ts",
    description:
      "KAN-866 — Pub/Sub push_endpoint per infra/terraform/account-field-updated.tf",
  },
  {
    liveUrl: "/internal/internal/account-detect-handler",
    innerSourcePath: "apps/api/src/internal/account-detect-handler.ts",
    description:
      "KAN-862 — Cloud Tasks HANDLER_URL constant (double-prefix; convention cleanup tracked in sibling follow-up)",
  },
  {
    liveUrl: "/internal/cron/deferred-send-evaluator",
    innerSourcePath: "apps/api/src/internal/cron-deferred-send.ts",
    description: "KAN-814 — Cloud Scheduler OIDC trigger",
  },
  {
    liveUrl: "/api/account/detect-events",
    innerSourcePath: "apps/api/src/internal/account-detect-events-sse.ts",
    description: "KAN-866 — SSE endpoint, EventSource consumer",
  },
];

/** Extract `app.route("<prefix>", <varName>)` pairs from index.ts. */
function readMountTable(): Map<string, string> {
  const src = readFileSync(resolve(REPO_ROOT, "apps/api/src/index.ts"), "utf-8");
  const re = /app\.route\(\s*["']([^"']+)["']\s*,\s*(\w+)\s*\)/g;
  const out = new Map<string, string>();
  for (const m of src.matchAll(re)) {
    out.set(m[2]!, m[1]!);
  }
  return out;
}

/** Find the variable name + declared route(s) inside a sub-app source. */
function readInnerRoutes(innerSourcePath: string): {
  varName: string | null;
  routes: string[];
} {
  const src = readFileSync(resolve(REPO_ROOT, innerSourcePath), "utf-8");
  const exportMatch = src.match(/export const (\w+)\s*=\s*new Hono\(\)/);
  const varName = exportMatch?.[1] ?? null;
  if (!varName) return { varName: null, routes: [] };
  const routeRe = new RegExp(
    String.raw`${varName}\.(?:get|post|put|delete|patch)\(\s*["']([^"']+)["']`,
    "g",
  );
  const routes: string[] = [];
  for (const m of src.matchAll(routeRe)) {
    routes.push(m[1]!);
  }
  return { varName, routes };
}

/** Concatenate Hono mount-prefix + declared route into the live URL. */
function joinHonoPath(mountPrefix: string, declaredRoute: string): string {
  if (mountPrefix === "/") return declaredRoute;
  if (mountPrefix.endsWith("/")) {
    return mountPrefix.slice(0, -1) + declaredRoute;
  }
  return mountPrefix + declaredRoute;
}

describe("internal route mount contract — KAN-866 fix-forward regression guard", () => {
  it.each(EXPECTED_LIVE_URLS)(
    "$liveUrl is mounted exactly where Terraform / Cloud Tasks call sites expect",
    (entry) => {
      const mounts = readMountTable();
      const { varName, routes } = readInnerRoutes(entry.innerSourcePath);
      expect(varName, `Could not find Hono export in ${entry.innerSourcePath}`).not.toBeNull();
      const mountPrefix = mounts.get(varName!);
      expect(
        mountPrefix,
        `Sub-app ${varName} is not mounted in index.ts`,
      ).toBeDefined();
      const liveUrls = routes.map((r) => joinHonoPath(mountPrefix!, r));
      expect(
        liveUrls.includes(entry.liveUrl),
        `${entry.description}\n  Expected live URL: ${entry.liveUrl}\n  Mount prefix:      ${mountPrefix}\n  Declared routes:   ${routes.join(", ")}\n  Live URLs:         ${liveUrls.join(", ")}`,
      ).toBe(true);
    },
  );
});
