/**
 * KAN-817 — Publish-site tests for action-send-push.
 *
 * Asserts that the action.executed event published after Resend dispatch
 * carries `subject` and `bodyPreview` derived from the OutboundMessage,
 * with all the truncation + fallback rules from the spec:
 *
 *   - body present → bodyPreview = trimmed body (slice 500)
 *   - whitespace-only body → falls through to html (or undefined)
 *   - html-only → bodyPreview = htmlToText(html), links + images dropped,
 *     whitespace collapsed, sliced to 500
 *   - neither body nor html → bodyPreview undefined (NOT empty string)
 *   - subject > 200 chars → truncated to 200
 *   - subject undefined → subject field absent on the published event
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const publishEventMock = vi.fn<(event: Record<string, unknown>) => Promise<string>>(
  async () => 'msgid-stub',
);
const sendMock = vi.fn();
const findUniqueMock = vi.fn();
const findFirstMock = vi.fn();

vi.mock('../../pubsub/index.js', () => ({
  publishEvent: publishEventMock,
}));

vi.mock('../../adapters/resend/index.js', () => ({
  ResendAdapter: vi.fn().mockImplementation(() => ({
    send: sendMock,
  })),
}));

vi.mock('../../repository/connection-repository.js', () => ({
  prisma: {
    channelConnection: {
      findUnique: findUniqueMock,
      findFirst: findFirstMock,
    },
  },
}));

const { actionSendPushApp } = await import('../action-send-push.js');

const TENANT_ID = '9ca85088-f65b-4bac-b098-fff742281ede';
const ACTION_ID = '550e8400-e29b-41d4-a716-446655440000';
const DECISION_ID = 'decision_kan817_test';
const CONTACT_ID = '11111111-aaaa-bbbb-cccc-222222222222';
const CONNECTION_ID = '35ad29cd-9c96-4a05-8b90-ec3376936d1d';

function buildSendEnvelope(content: { subject?: string; body: string; html?: string }) {
  const event = {
    topic: 'action.send' as const,
    timestamp: new Date().toISOString(),
    connectionId: CONNECTION_ID,
    message: {
      tenantId: TENANT_ID,
      actionId: ACTION_ID,
      decisionId: DECISION_ID,
      contactId: CONTACT_ID,
      recipient: { email: 'fred@mkze.vc' },
      content,
    },
  };
  return {
    message: {
      data: Buffer.from(JSON.stringify(event)).toString('base64'),
      messageId: 'pubsub-msg-test',
    },
    subscription: 'projects/x/subscriptions/y',
  };
}

async function postEnvelope(envelope: unknown) {
  return actionSendPushApp.request('/action-send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope),
  });
}

beforeEach(() => {
  publishEventMock.mockReset();
  publishEventMock.mockResolvedValue('msgid-stub');
  sendMock.mockReset();
  sendMock.mockResolvedValue({
    status: 'sent',
    providerMessageId: 'resend-msg-id',
  });
  findUniqueMock.mockReset();
  findUniqueMock.mockResolvedValue({
    id: CONNECTION_ID,
    tenantId: TENANT_ID,
    channelType: 'EMAIL',
    provider: 'resend',
    providerAccountId: 'acct',
    status: 'ACTIVE',
    credentialsRef: 'ref',
    label: null,
    metadata: { mode: 'simple' },
    connectedAt: new Date(),
  });
  findFirstMock.mockReset();
});

describe('KAN-817 — action-send-push subject + bodyPreview population', () => {
  it('plain body present → bodyPreview = trimmed body, subject populated', async () => {
    const res = await postEnvelope(
      buildSendEnvelope({
        subject: 'Quick check-in',
        body: 'Hey — wanted to see if you had thoughts on pricing. Talk soon!',
      }),
    );
    expect(res.status).toBe(200);
    expect(publishEventMock).toHaveBeenCalledOnce();
    const published = publishEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(published.subject).toBe('Quick check-in');
    expect(published.bodyPreview).toBe(
      'Hey — wanted to see if you had thoughts on pricing. Talk soon!',
    );
  });

  it('whitespace-only body → falls through to html, bodyPreview from htmlToText', async () => {
    const res = await postEnvelope(
      buildSendEnvelope({
        subject: 'Subj',
        body: '   \n\n   \t  ',
        html: '<p>Real content from HTML</p>',
      }),
    );
    expect(res.status).toBe(200);
    const published = publishEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(published.bodyPreview).toBe('Real content from HTML');
  });

  it('whitespace-only body + no html → bodyPreview undefined (NOT empty string)', async () => {
    const res = await postEnvelope(
      buildSendEnvelope({
        subject: 'Subj',
        body: '   \n\n   ',
      }),
    );
    expect(res.status).toBe(200);
    const published = publishEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect('bodyPreview' in published).toBe(false);
  });

  it('html-only path → links and images dropped, whitespace collapsed', async () => {
    const html = `
      <html><body>
        <p>Click here:</p>
        <a href="https://example.com/very-long-utm-tracker-url">our pricing page</a>
        <img src="https://example.com/spacer.gif" alt="">
        <p>And we have   extra
        spaces  here.</p>
      </body></html>
    `;
    const res = await postEnvelope(
      buildSendEnvelope({
        subject: 'html-only',
        body: '',
        html,
      }),
    );
    expect(res.status).toBe(200);
    const published = publishEventMock.mock.calls[0]![0] as Record<string, unknown>;
    const bodyPreview = published.bodyPreview as string;
    // Link text preserved, URL dropped (ignoreHref).
    expect(bodyPreview).toContain('our pricing page');
    expect(bodyPreview).not.toContain('https://example.com');
    // Image dropped.
    expect(bodyPreview).not.toContain('spacer.gif');
    // Whitespace collapsed — no double spaces, no newlines remaining.
    expect(bodyPreview).not.toMatch(/\s{2,}/);
    expect(bodyPreview).not.toContain('\n');
    // Real prose preserved.
    expect(bodyPreview).toContain('extra spaces here');
  });

  it('neither body nor html → both subject (if present) populated, bodyPreview absent', async () => {
    const res = await postEnvelope(
      buildSendEnvelope({
        subject: 'just a subject',
        body: '',
      }),
    );
    expect(res.status).toBe(200);
    const published = publishEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect(published.subject).toBe('just a subject');
    expect('bodyPreview' in published).toBe(false);
  });

  it('subject > 200 chars → truncated to exactly 200', async () => {
    const longSubject = 'A'.repeat(250);
    const res = await postEnvelope(
      buildSendEnvelope({
        subject: longSubject,
        body: 'short body',
      }),
    );
    expect(res.status).toBe(200);
    const published = publishEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((published.subject as string).length).toBe(200);
    expect(published.subject).toBe('A'.repeat(200));
  });

  it('body > 500 chars → bodyPreview truncated to exactly 500', async () => {
    const longBody = 'B'.repeat(700);
    const res = await postEnvelope(
      buildSendEnvelope({
        subject: 'Subj',
        body: longBody,
      }),
    );
    expect(res.status).toBe(200);
    const published = publishEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect((published.bodyPreview as string).length).toBe(500);
  });

  it('subject undefined → subject field absent on the published event', async () => {
    const res = await postEnvelope(
      buildSendEnvelope({
        body: 'body only, no subject',
      }),
    );
    expect(res.status).toBe(200);
    const published = publishEventMock.mock.calls[0]![0] as Record<string, unknown>;
    expect('subject' in published).toBe(false);
    expect(published.bodyPreview).toBe('body only, no subject');
  });
});
