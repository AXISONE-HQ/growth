/**
 * Unit tests for the Resend webhook handler (KAN-684).
 *
 * Mocks publishEvent + suppressDb + ioredis so no Pub/Sub / DB / Redis is
 * actually touched. The Svix middleware is mounted with an injected verifier
 * that just returns a fixed payload — bypassing real signature crypto.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../pubsub/index.js', () => ({
  publishEvent: vi.fn(async () => 'msgId-stub'),
}));

vi.mock('../../adapters/resend/suppressions.js', () => ({
  suppressDb: vi.fn(async () => undefined),
}));

const redisSetMock = vi.fn<(...args: unknown[]) => Promise<string | null>>(async () => 'OK');
vi.mock('ioredis', () => {
  const Redis = vi.fn(() => ({
    set: redisSetMock,
    on: vi.fn(),
  }));
  return { default: Redis };
});

// Stub the Svix middleware: real svix crypto would require a valid HMAC, which
// is excessive for handler-flow tests. We replace the builder entirely so
// every request goes through with a fixed payload pulled from the body.
vi.mock('../../middleware/svix.js', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/svix.js')>(
    '../../middleware/svix.js',
  );
  return {
    ...actual,
    buildSvixMiddleware: () =>
      async (c: import('hono').Context, next: () => Promise<void>) => {
        const body = await c.req.text();
        const payload = JSON.parse(body) as Record<string, unknown>;
        c.set('svix' as never, {
          payload,
          svixId: c.req.header('svix-id') ?? 'msg_test',
          svixTimestamp: c.req.header('svix-timestamp') ?? '0',
        } as never);
        await next();
      },
  };
});

// Imports after mocks
import { resendWebhookApp } from '../resend.js';
import { publishEvent } from '../../pubsub/index.js';
import { suppressDb } from '../../adapters/resend/suppressions.js';

const TENANT_ID = '9ca85088-f65b-4bac-b098-fff742281ede';
const ACTION_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const DECISION_ID = 'kan687-test-decision';
const CONTACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONNECTION_ID = '35ad29cd-9c96-4a05-8b90-ec3376936d1d';
const CORRELATION_TAGS = [
  { name: 'tenant_id', value: TENANT_ID },
  { name: 'action_id', value: ACTION_ID },
  { name: 'decision_id', value: DECISION_ID },
  { name: 'contact_id', value: CONTACT_ID },
  { name: 'connection_id', value: CONNECTION_ID },
];

function post(payload: Record<string, unknown>, svixId = 'msg_unique_' + Math.random().toString(36).slice(2)) {
  return resendWebhookApp.request('/', {
    method: 'POST',
    headers: {
      'svix-id': svixId,
      'svix-timestamp': String(Math.floor(Date.now() / 1000)),
      'svix-signature': 'v1,stubbed',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });
}

beforeEach(() => {
  vi.mocked(publishEvent).mockClear();
  vi.mocked(suppressDb).mockClear();
  redisSetMock.mockClear();
  redisSetMock.mockResolvedValue('OK');
});

describe('email.delivered → publishes action.executed status=delivered', () => {
  it('publishes once with correct correlation', async () => {
    const res = await post({
      type: 'email.delivered',
      data: { email_id: 'em_001', to: ['fred@axisone.ca'], tags: CORRELATION_TAGS },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).toHaveBeenCalledTimes(1);
    const event = vi.mocked(publishEvent).mock.calls[0][0];
    if (event.topic !== 'action.executed') throw new Error('expected action.executed');
    expect(event.topic).toBe('action.executed');
    expect(event.status).toBe('delivered');
    if (event.topic === 'action.executed') {
      expect(event.tenantId).toBe(TENANT_ID);
      expect(event.actionId).toBe(ACTION_ID);
      expect(event.providerMessageId).toBe('em_001');
      expect(event.provider).toBe('resend');
      expect(event.channel).toBe('EMAIL');
    }
    expect(suppressDb).not.toHaveBeenCalled();
  });
});

describe('email.bounced — hard bounce → status=failed + suppression', () => {
  it('publishes failed + writes hard-bounce suppression', async () => {
    const res = await post({
      type: 'email.bounced',
      data: {
        email_id: 'em_002',
        to: ['bouncey@example.com'],
        tags: CORRELATION_TAGS,
        bounce: { type: 'hard', subType: 'general', message: 'mailbox not found' },
      },
    });
    expect(res.status).toBe(200);
    const event = vi.mocked(publishEvent).mock.calls[0][0];
    if (event.topic !== 'action.executed') throw new Error('expected action.executed');
    expect(event.status).toBe('failed');
    if (event.topic === 'action.executed') {
      expect(event.errorClass).toBe('permanent');
      expect(event.errorMessage).toContain('mailbox not found');
    }
    expect(suppressDb).toHaveBeenCalledWith(TENANT_ID, 'bouncey@example.com', 'bounce');
  });
});

describe('email.bounced — soft bounce → status=failed but NO suppression', () => {
  it('publishes failed/transient and does not suppress on soft bounce', async () => {
    const res = await post({
      type: 'email.bounced',
      data: {
        email_id: 'em_003',
        to: ['softy@example.com'],
        tags: CORRELATION_TAGS,
        bounce: { type: 'soft', message: 'mailbox full' },
      },
    });
    expect(res.status).toBe(200);
    const event = vi.mocked(publishEvent).mock.calls[0][0];
    if (event.topic !== 'action.executed') throw new Error('expected action.executed');
    expect(event.status).toBe('failed');
    if (event.topic === 'action.executed') {
      expect(event.errorClass).toBe('transient');
    }
    expect(suppressDb).not.toHaveBeenCalled();
  });
});

describe('email.complained → status=suppressed + ALWAYS suppression', () => {
  it('publishes suppressed + writes spam suppression', async () => {
    const res = await post({
      type: 'email.complained',
      data: { email_id: 'em_004', to: ['mad@example.com'], tags: CORRELATION_TAGS },
    });
    expect(res.status).toBe(200);
    const event = vi.mocked(publishEvent).mock.calls[0][0];
    if (event.topic !== 'action.executed') throw new Error('expected action.executed');
    expect(event.status).toBe('suppressed');
    expect(suppressDb).toHaveBeenCalledWith(TENANT_ID, 'mad@example.com', 'spam');
  });
});

describe('email.sent / email.delivery_delayed → no DB writes, no publishes', () => {
  it('email.sent is informational only', async () => {
    const res = await post({
      type: 'email.sent',
      data: { email_id: 'em_005', to: ['x@example.com'], tags: CORRELATION_TAGS },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
    expect(suppressDb).not.toHaveBeenCalled();
  });

  it('email.delivery_delayed is informational only (transient)', async () => {
    const res = await post({
      type: 'email.delivery_delayed',
      data: { email_id: 'em_006', to: ['x@example.com'], tags: CORRELATION_TAGS },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe('email.opened / email.clicked → logged only (no engagement schema yet)', () => {
  it('email.opened does not publish or write', async () => {
    const res = await post({
      type: 'email.opened',
      data: { email_id: 'em_007', to: ['x@example.com'], tags: CORRELATION_TAGS },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
    expect(suppressDb).not.toHaveBeenCalled();
  });

  it('email.clicked does not publish or write', async () => {
    const res = await post({
      type: 'email.clicked',
      data: {
        email_id: 'em_008',
        to: ['x@example.com'],
        tags: CORRELATION_TAGS,
        click: { link: 'https://growth.axisone.ca/dashboard' },
      },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
  });
});

describe('idempotency', () => {
  it('duplicate svix-id → second call no-ops (no publish, no suppress)', async () => {
    redisSetMock.mockResolvedValueOnce('OK'); // first
    redisSetMock.mockResolvedValueOnce(null); // second — already exists
    const fixedId = 'msg_dedup_test';

    const res1 = await post(
      { type: 'email.delivered', data: { email_id: 'em_dup', to: ['x@example.com'], tags: CORRELATION_TAGS } },
      fixedId,
    );
    const res2 = await post(
      { type: 'email.delivered', data: { email_id: 'em_dup', to: ['x@example.com'], tags: CORRELATION_TAGS } },
      fixedId,
    );

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(publishEvent).toHaveBeenCalledTimes(1);
  });

  it('Redis failure → fail-open (event still processed, logged loudly)', async () => {
    redisSetMock.mockRejectedValueOnce(new Error('redis down'));
    const res = await post({
      type: 'email.delivered',
      data: { email_id: 'em_failopen', to: ['x@example.com'], tags: CORRELATION_TAGS },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).toHaveBeenCalledTimes(1);
  });
});

describe('correlation-tag handling', () => {
  it('missing tags → log warning, no publish, but still 200', async () => {
    const res = await post({
      type: 'email.delivered',
      data: { email_id: 'em_no_tags', to: ['x@example.com'], tags: [] },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('partial tags (missing connection_id) → log + skip publish', async () => {
    const res = await post({
      type: 'email.delivered',
      data: {
        email_id: 'em_partial',
        to: ['x@example.com'],
        tags: CORRELATION_TAGS.filter((t) => t.name !== 'connection_id'),
      },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
  });

  it('hard bounce without tenant_id → no suppression (need tenant for the row)', async () => {
    const res = await post({
      type: 'email.bounced',
      data: {
        email_id: 'em_no_tenant',
        to: ['x@example.com'],
        tags: CORRELATION_TAGS.filter((t) => t.name !== 'tenant_id'),
        bounce: { type: 'hard' },
      },
    });
    expect(res.status).toBe(200);
    expect(suppressDb).not.toHaveBeenCalled();
  });
});

describe('handler error → still 200 (per Resend retry policy)', () => {
  it('publishEvent throws → 200 returned, error logged', async () => {
    vi.mocked(publishEvent).mockRejectedValueOnce(new Error('pubsub down'));
    const res = await post({
      type: 'email.delivered',
      data: { email_id: 'em_publish_fails', to: ['x@example.com'], tags: CORRELATION_TAGS },
    });
    expect(res.status).toBe(200);
  });
});

describe('unknown event type', () => {
  it('logs and returns 200 (defensive against future Resend additions)', async () => {
    const res = await post({
      type: 'email.future_event_we_dont_know_about',
      data: { email_id: 'em_unknown', to: ['x@example.com'], tags: CORRELATION_TAGS },
    });
    expect(res.status).toBe(200);
    expect(publishEvent).not.toHaveBeenCalled();
    expect(suppressDb).not.toHaveBeenCalled();
  });
});
