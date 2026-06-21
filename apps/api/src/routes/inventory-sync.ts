/**
 * KAN-1219 Slice F2 — POST /api/v1/inventory/reconcile
 *
 * Authenticated reconcile endpoint for the daily dealer-feed sync.
 * Called by the GitHub Actions cron workflow (`.github/workflows/
 * inventory-sync-daily.yml`) with an `X-AxisOne-API-Key` header (re-using
 * the existing `TenantApiKey` substrate from KAN-742). The dealer JSON
 * payload is parsed via the same `mapDrivegoodEntry` logic the
 * inventory-crawler uses, then handed to `reconcileInventory()` (Slice F1).
 *
 * The endpoint exists primarily to let GitHub-hosted runners (which use
 * a different IP range from Cloud Run) bypass the 4mkauto CAPTCHA that
 * blocks our Cloud Run egress. First cron firing = empirical signal of
 * whether GitHub IPs are also CAPTCHA-gated (informal banking:
 * GitHub-Actions-as-alternative-IP infrastructure, 1st anchor).
 *
 * Per Memo 54 empirical-priority — hardcode the Drivegood (4mkauto)
 * mapper here; we generalize when a 2nd dealer feed lands. The route
 * itself accepts an explicit `source` discriminator so the reconcile
 * audit log captures provenance (`github-actions-daily-cron`,
 * `operator-sync-now`, etc.) without code changes.
 */
import { Hono } from "hono";
import {
  verifyApiKey,
  touchLastUsedAt,
} from "../services/api-key-auth.js";
import { prisma } from "../prisma.js";
import {
  mapDrivegoodEntry,
  type ReconcileVehicleEntry,
} from "../lib/drivegood-mapper.js";

// KAN-689 variable-specifier dynamic loader for cross-rootDir modules
// in packages/api. Mirrors the lead-api.ts pattern. The reconcile service
// signature is loosely typed at the route layer; full types live in
// packages/api/src/services/vehicle-service.ts.
interface ReconcileResult {
  seenCount: number;
  createdCount: number;
  updatedCount: number;
  removedCount: number;
  unchangedCount: number;
  errors: Array<{ vin: string; phase: string; message: string }>;
}
interface VehicleServiceModule {
  reconcileInventory: (
    prisma: unknown,
    tenantId: string,
    entries: ReconcileVehicleEntry[],
    source: string,
    hooks: unknown,
  ) => Promise<ReconcileResult>;
}
let _vehicleServiceModule: VehicleServiceModule | null = null;
async function loadVehicleService(): Promise<VehicleServiceModule> {
  if (_vehicleServiceModule) return _vehicleServiceModule;
  const spec = "../../../../packages/api/src/services/vehicle-service.js";
  _vehicleServiceModule = (await import(spec)) as VehicleServiceModule;
  return _vehicleServiceModule;
}

// Test seam — inject mock service.
export function __setVehicleServiceForTest(mod: VehicleServiceModule | null): void {
  _vehicleServiceModule = mod;
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/v1/inventory/reconcile
// ─────────────────────────────────────────────────────────────────────

export const inventorySyncApp = new Hono();

inventorySyncApp.post("/reconcile", async (c) => {
  // 1. API key auth (reuses KAN-742 substrate).
  const apiKey =
    c.req.header("x-axisone-api-key") ?? c.req.header("X-AxisOne-API-Key");
  if (!apiKey) {
    return c.json({ error: "Missing X-AxisOne-API-Key header" }, 401);
  }
  const auth = await verifyApiKey(apiKey);
  if (!auth) {
    return c.json({ error: "Invalid API key" }, 401);
  }
  touchLastUsedAt(auth.apiKeyId);

  // 2. Body validation. Wire shape: { entries: [...drivegood JSON...], source?: string }.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Body must be valid JSON" }, 400);
  }
  if (
    body == null ||
    typeof body !== "object" ||
    !("entries" in body) ||
    !Array.isArray((body as { entries: unknown }).entries)
  ) {
    return c.json(
      { error: "Body must have shape { entries: [...], source?: string }" },
      400,
    );
  }
  const rawEntries = (body as { entries: Record<string, unknown>[] }).entries;
  const sourceRaw = (body as { source?: unknown }).source;
  const source =
    typeof sourceRaw === "string" && sourceRaw.length > 0
      ? sourceRaw
      : "inventory-sync-api";

  // 3. Map raw JSON → ReconcileVehicleEntry[]. Entries with missing VIN
  //    or required enum slots are silently dropped (the reconcile will
  //    then NOT see them in its "feed" set; that's the correct semantic
  //    — we can't confidently reconcile what we can't fully parse).
  const entries: ReconcileVehicleEntry[] = [];
  let skippedCount = 0;
  for (const raw of rawEntries) {
    const e = mapDrivegoodEntry(raw);
    if (e) entries.push(e);
    else skippedCount++;
  }

  // 4. Reconcile.
  const svc = await loadVehicleService();
  const hooks = {
    auditLog: {
      writeInTx: async (
        tx: unknown,
        payload: {
          tenantId: string;
          actor: string;
          actionType: string;
          payload: Record<string, unknown>;
          reasoning: string;
        },
      ): Promise<{ id: string }> =>
        (
          tx as {
            auditLog: { create: (args: unknown) => Promise<{ id: string }> };
          }
        ).auditLog.create({
          data: {
            tenantId: payload.tenantId,
            actor: payload.actor,
            actionType: payload.actionType,
            payload: payload.payload,
            reasoning: payload.reasoning,
          },
        }),
    },
  };
  const result = await svc.reconcileInventory(
    prisma,
    auth.tenantId,
    entries,
    source,
    hooks,
  );

  return c.json({
    sourceEntries: rawEntries.length,
    parsedEntries: entries.length,
    skippedEntries: skippedCount,
    seenCount: result.seenCount,
    createdCount: result.createdCount,
    updatedCount: result.updatedCount,
    removedCount: result.removedCount,
    unchangedCount: result.unchangedCount,
    errorSamples: result.errors.slice(0, 10),
  });
});
