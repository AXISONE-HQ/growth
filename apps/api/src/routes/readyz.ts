/**
 * KAN-1013 — deploy-time readiness probe.
 *
 * Third leg of the CI Gate Audit (KAN-1016), after KAN-1017 (packages/api
 * typecheck ✅) and KAN-1011 (apps/web typecheck ✅). Closes the gap that
 * shipped the cost-cap-dead incident: the deploy smoke verified container
 * startup + a static `/health` 200, but never asserted that the deployed
 * service could actually reach its critical dependencies (Redis,
 * Cloud SQL, engine module). Result: secret-drift + missing-VPC-egress
 * shipped silent for weeks.
 *
 * /health vs /readyz — deliberately split:
 *   - /health is liveness ("process up"). Static 200. Cloud Run's load
 *     balancer hits this; coupling it to dependency health would cascade
 *     a transient Redis blip into a yanked revision.
 *   - /readyz is readiness ("deps reachable"). Deep checks. Used by the
 *     post-deploy smoke + ops-side ad-hoc probes. Returns 503 on any dep
 *     failure so smoke can `curl -fsS` and exit non-zero naturally.
 *
 * Three checks, all in parallel via Promise.allSettled (one slow dep
 * doesn't tail-latency the whole probe):
 *
 *   1. Redis PING (catches the cap-cap-dead class: secret-drift,
 *      missing VPC egress, Memorystore unreachable)
 *   2. DB SELECT 1 (catches Cloud SQL Auth Proxy / cred / VPC drift)
 *   3. Engine module-load + canonical-Objective parse (catches
 *      module-load failures + engine Zod-schema drift since last deploy;
 *      sibling to KAN-1029's PROD-shape contract test, but enforced at
 *      DEPLOY time, not just CI)
 *
 * Auth posture: PUBLIC. Sibling to /health which is allUsers-public.
 * Acceptable trade-off (per founder review 2026-05-26) because:
 *   - The response is MINIMAL by design: per-dep { ok, latencyMs } only.
 *     No error strings, no hostnames, no versions, no connection details.
 *     A failing dep returns `ok: false`; the WHY lives in service logs,
 *     not the response body.
 *   - Cloud Run IAM is per-service (all-or-nothing); requiring auth on
 *     /readyz alone would mean app-level OIDC verification in this
 *     handler, disproportionate code for a low-sensitivity probe.
 *   - Follow-up tracked: OIDC-tightening + rate-limit (per-call Redis
 *     PING + DB query + engine parse is a mild abuse/recon surface).
 */
import { Hono } from 'hono';
import { prisma } from '../prisma.js';
import { getRedisClient } from '../services/redis-client.js';

export const readyzApp = new Hono();

// ─────────────────────────────────────────────
// Engine readiness — variable-specifier dynamic import per
// reference_variable_specifier_dynamic_import (cross-rootDir).
// Memoized so repeated /readyz probes don't re-import.
// ─────────────────────────────────────────────
interface ObjectiveSchemaModule {
  ObjectiveSchema: { parse: (v: unknown) => unknown };
}
let _objectiveSchemaModule: ObjectiveSchemaModule | null = null;
async function loadObjectiveSchemaModule(): Promise<ObjectiveSchemaModule> {
  if (_objectiveSchemaModule) return _objectiveSchemaModule;
  const spec = '../../../../packages/api/src/services/objective-gap-analyzer.js';
  _objectiveSchemaModule = (await import(spec)) as ObjectiveSchemaModule;
  return _objectiveSchemaModule;
}

// Canonical Objective shape — mirrors the KAN-1029 PROD-shape contract
// fixture (all 8 catalog rows have blueprint_id=null, success_condition={},
// sub_objectives=[]). If this parses, the engine's read-surface schema is
// current with the PROD data contract. If it throws, either the engine
// module didn't load (drift, broken import, missing dep) or the schema
// has regressed away from the PROD-shape contract.
const CANONICAL_OBJECTIVE = Object.freeze({
  id: 'readyz-probe-objective',
  tenantId: 'readyz-probe-tenant',
  type: 'warm_up',
  name: 'KAN-1013 readiness probe',
  successCondition: {},
  subObjectives: [],
  blueprintId: null,
  createdAt: '2026-05-26T00:00:00.000Z',
});

// ─────────────────────────────────────────────
// Per-dep timeout — bounds tail latency so a slow/hung dep can't stall
// the probe past the smoke's overall budget. 5s is generous for any
// healthy dep (Redis PING < 10ms, DB SELECT 1 < 50ms typical, engine
// parse < 5ms); a dep that needs longer is degraded enough to flag.
// ─────────────────────────────────────────────
const PER_DEP_TIMEOUT_MS = 5000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timeoutId: NodeJS.Timeout | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('timeout')), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

type DepResult =
  | { ok: true; latencyMs: number }
  | { ok: false };

async function checkRedis(): Promise<DepResult> {
  const t0 = Date.now();
  try {
    const client = getRedisClient();
    const pong = await withTimeout(client.ping(), PER_DEP_TIMEOUT_MS);
    if (pong !== 'PONG') return { ok: false };
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false };
  }
}

async function checkDb(): Promise<DepResult> {
  const t0 = Date.now();
  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, PER_DEP_TIMEOUT_MS);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false };
  }
}

async function checkEngine(): Promise<DepResult> {
  const t0 = Date.now();
  try {
    const mod = await withTimeout(loadObjectiveSchemaModule(), PER_DEP_TIMEOUT_MS);
    // Single-call schema parse — no DB, no LLM, no side effects.
    mod.ObjectiveSchema.parse(CANONICAL_OBJECTIVE);
    return { ok: true, latencyMs: Date.now() - t0 };
  } catch {
    return { ok: false };
  }
}

readyzApp.get('/readyz', async (c) => {
  // Promise.allSettled — one slow/failing dep doesn't tail-latency or
  // short-circuit the others. Every probe reports on every dep.
  const [redisR, dbR, engineR] = await Promise.allSettled([
    checkRedis(),
    checkDb(),
    checkEngine(),
  ]);

  const settled = (r: PromiseSettledResult<DepResult>): DepResult =>
    r.status === 'fulfilled' ? r.value : { ok: false };

  const deps = {
    redis: settled(redisR),
    db: settled(dbR),
    engine: settled(engineR),
  };

  const allOk = deps.redis.ok && deps.db.ok && deps.engine.ok;

  // Minimal payload contract (per founder review): per-dep ok + latencyMs
  // only. No error strings, hostnames, versions, connection details, or
  // stacks. A failing dep returns ok:false; root-cause lives in service
  // logs (Cloud Logging), not in this response body.
  const body = {
    status: allOk ? 'ready' : 'not_ready',
    deps,
  };

  // 503 on any dep failure — smoke `curl -fsS` exits non-zero naturally.
  // 200 only when every dep is reachable.
  return c.json(body, allOk ? 200 : 503);
});
