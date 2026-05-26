/**
 * KAN-1013 — /readyz endpoint behavior matrix.
 *
 * Pins the per-dep ok/ok-false routing + HTTP 200/503 contract + the
 * minimal-payload-only response shape (per founder review: no error
 * strings, hostnames, versions, or connection details — just per-dep
 * { ok, latencyMs } on success, { ok: false } on failure).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// ── Engine module mock — controllable per test ────────────────────────
const objectiveSchemaParse = vi.fn();
vi.mock('../../../../packages/api/src/services/objective-gap-analyzer.js', () => ({
  ObjectiveSchema: { parse: objectiveSchemaParse },
}));

// ── Prisma mock ───────────────────────────────────────────────────────
const queryRaw = vi.fn();
vi.mock('../prisma.js', () => ({
  prisma: {
    $queryRaw: (...args: unknown[]) => queryRaw(...args),
  },
}));

// ── Redis client mock ─────────────────────────────────────────────────
const ping = vi.fn();
vi.mock('../services/redis-client.js', () => ({
  getRedisClient: () => ({ ping }),
}));

async function probe() {
  const { readyzApp } = await import('../routes/readyz.js');
  const app = new Hono();
  app.route('/', readyzApp);
  const res = await app.request('/readyz', { method: 'GET' });
  const body = await res.json();
  return { status: res.status, body: body as any };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Defaults — everything OK
  ping.mockResolvedValue('PONG');
  queryRaw.mockResolvedValue([{ '?column?': 1 }]);
  objectiveSchemaParse.mockReturnValue({});
});

describe('KAN-1013 — /readyz: all deps OK → 200 status=ready', () => {
  it('200 + status=ready when all three deps respond', async () => {
    const { status, body } = await probe();
    expect(status).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.deps.redis.ok).toBe(true);
    expect(body.deps.db.ok).toBe(true);
    expect(body.deps.engine.ok).toBe(true);
    // Latency reported on success
    expect(typeof body.deps.redis.latencyMs).toBe('number');
    expect(typeof body.deps.db.latencyMs).toBe('number');
    expect(typeof body.deps.engine.latencyMs).toBe('number');
  });
});

describe('KAN-1013 — /readyz: per-dep failure → 503 status=not_ready', () => {
  it('Redis throws → 503 with redis.ok:false, other deps still report ok', async () => {
    ping.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const { status, body } = await probe();
    expect(status).toBe(503);
    expect(body.status).toBe('not_ready');
    expect(body.deps.redis.ok).toBe(false);
    expect(body.deps.db.ok).toBe(true);
    expect(body.deps.engine.ok).toBe(true);
  });

  it('Redis returns non-PONG → 503 with redis.ok:false (broken Redis response)', async () => {
    ping.mockResolvedValueOnce('WRONG');
    const { status, body } = await probe();
    expect(status).toBe(503);
    expect(body.deps.redis.ok).toBe(false);
  });

  it('DB throws → 503 with db.ok:false', async () => {
    queryRaw.mockRejectedValueOnce(new Error('Connection refused'));
    const { status, body } = await probe();
    expect(status).toBe(503);
    expect(body.deps.redis.ok).toBe(true);
    expect(body.deps.db.ok).toBe(false);
    expect(body.deps.engine.ok).toBe(true);
  });

  it('Engine Zod parse throws → 503 with engine.ok:false (schema drift class)', async () => {
    objectiveSchemaParse.mockImplementationOnce(() => {
      throw new Error('ZodError: ...');
    });
    const { status, body } = await probe();
    expect(status).toBe(503);
    expect(body.deps.engine.ok).toBe(false);
    expect(body.deps.redis.ok).toBe(true);
    expect(body.deps.db.ok).toBe(true);
  });

  it('Multiple deps fail → 503 with all failed deps marked', async () => {
    ping.mockRejectedValueOnce(new Error('redis down'));
    queryRaw.mockRejectedValueOnce(new Error('db down'));
    const { status, body } = await probe();
    expect(status).toBe(503);
    expect(body.deps.redis.ok).toBe(false);
    expect(body.deps.db.ok).toBe(false);
    expect(body.deps.engine.ok).toBe(true);
  });
});

describe('KAN-1013 — /readyz: minimal-payload contract (no info leakage)', () => {
  it('failure response contains NO error string / message / stack / hostname / version', async () => {
    ping.mockRejectedValueOnce(new Error('Connection refused at 10.0.1.3:6379 — REDACT THIS HOSTNAME'));
    queryRaw.mockRejectedValueOnce(new Error('Cloud SQL Auth Proxy not connected — REDACT'));
    objectiveSchemaParse.mockImplementationOnce(() => {
      throw new Error('SECRET_INTERNAL_DETAIL — leak guard test');
    });
    const { status, body } = await probe();
    expect(status).toBe(503);
    const serialized = JSON.stringify(body);
    // None of the error-detail substrings should appear in the response
    expect(serialized).not.toContain('REDACT');
    expect(serialized).not.toContain('10.0.1.3');
    expect(serialized).not.toContain('Cloud SQL');
    expect(serialized).not.toContain('SECRET_INTERNAL_DETAIL');
    expect(serialized).not.toContain('ZodError');
    // Failing deps emit ONLY { ok: false } — no latencyMs (no side-channel timing leak)
    expect(body.deps.redis).toEqual({ ok: false });
    expect(body.deps.db).toEqual({ ok: false });
    expect(body.deps.engine).toEqual({ ok: false });
  });

  it('success response shape is exactly { status, deps: { <name>: { ok, latencyMs } } }', async () => {
    const { body } = await probe();
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(['deps', 'status']);
    const depKeys = Object.keys(body.deps).sort();
    expect(depKeys).toEqual(['db', 'engine', 'redis']);
    for (const dep of ['redis', 'db', 'engine']) {
      const depKeys2 = Object.keys(body.deps[dep]).sort();
      expect(depKeys2).toEqual(['latencyMs', 'ok']);
    }
  });
});

describe('KAN-1013 — /readyz: per-dep timeout bounds tail latency', () => {
  it('Redis that hangs → resolves as ok:false within timeout window (does NOT hang the probe)', async () => {
    // Simulate a Redis that never resolves
    ping.mockImplementationOnce(() => new Promise(() => {}));
    const t0 = Date.now();
    const { status, body } = await probe();
    const elapsed = Date.now() - t0;
    expect(status).toBe(503);
    expect(body.deps.redis.ok).toBe(false);
    // Hard upper bound — 5s per-dep timeout + 500ms slop. If this fails,
    // the timeout isn't bounding properly and the probe could stall.
    expect(elapsed).toBeLessThan(5500);
  }, 10000); // vitest test timeout — generous over the 5s per-dep timeout
});
