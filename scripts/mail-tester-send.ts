/**
 * KAN-687 mail-tester harness — single send through the production Resend
 * pipeline, scored externally at mail-tester.com.
 *
 * Same code path as scripts/phase-e-retry.ts (publishes ActionSendEvent to
 * the `action.send` Pub/Sub topic, which the connectors worker pushes through
 * the Resend adapter). One recipient per invocation. Prints the worker's
 * Resend data.id for cross-reference, then closing instructions to refresh
 * the mail-tester URL.
 *
 * Usage:
 *   PHASE_E_TENANT_ID=<uuid> \
 *   PHASE_E_CONNECTION_ID=<uuid> \
 *   npx tsx scripts/mail-tester-send.ts test-xxxxxxxx@srv1.mail-tester.com
 *
 * Exit codes:
 *   0 — published and worker confirmed sent
 *   1 — publish or worker dispatch failed; see error output
 *   2 — bad invocation (missing env or address arg)
 */

import { PubSub } from '@google-cloud/pubsub';
import { GoogleAuth } from 'google-auth-library';
import { randomUUID } from 'crypto';

const PROJECT_ID = 'growth-493400';
const TOPIC = 'action.send';
const SERVICE_NAME = 'growth-connectors';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

const TENANT_ID = process.env.PHASE_E_TENANT_ID;
const CONNECTION_ID = process.env.PHASE_E_CONNECTION_ID ?? NIL_UUID;
const RECIPIENT = process.argv[2];

if (!TENANT_ID) {
  console.error('ERROR: set PHASE_E_TENANT_ID to the demo tenant UUID.');
  process.exit(2);
}
if (!RECIPIENT || !RECIPIENT.includes('@')) {
  console.error('ERROR: pass the mail-tester recipient address as the first arg.');
  console.error('  e.g. npx tsx scripts/mail-tester-send.ts test-xxxxxxxx@srv1.mail-tester.com');
  process.exit(2);
}

interface DispatchLog {
  status?: string;
  providerMessageId?: string;
  errorMessage?: string;
  errorClass?: string;
  ts?: string;
}

async function pollForDispatch(
  auth: GoogleAuth,
  actionId: string,
  publishedAt: Date,
): Promise<DispatchLog | null> {
  const POLL_TIMEOUT_MS = 90_000;
  const POLL_INTERVAL_MS = 4_000;
  const sinceIso = new Date(publishedAt.getTime() - 5_000).toISOString();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const client = await auth.getClient();

  while (Date.now() < deadline) {
    const filter = [
      `resource.type="cloud_run_revision"`,
      `resource.labels.service_name="${SERVICE_NAME}"`,
      `timestamp>="${sinceIso}"`,
      `jsonPayload.actionId="${actionId}"`,
    ].join(' AND ');

    const res = (await client.request({
      url: 'https://logging.googleapis.com/v2/entries:list',
      method: 'POST',
      data: {
        resourceNames: [`projects/${PROJECT_ID}`],
        filter,
        orderBy: 'timestamp asc',
        pageSize: 25,
      },
    })) as { data: { entries?: Array<Record<string, unknown>> } };

    for (const e of res.data.entries ?? []) {
      const jp = (e.jsonPayload ?? {}) as Record<string, unknown>;
      const msg = jp.msg as string | undefined;
      const ts = (e as { timestamp?: string }).timestamp;
      if (!msg) continue;
      if (msg.includes('dispatched')) {
        return {
          status: jp.status as string,
          providerMessageId: jp.providerMessageId as string,
          ts,
        };
      }
      if (msg.includes('no ACTIVE email')) {
        return { status: 'dropped', errorMessage: 'no ACTIVE EMAIL ChannelConnection — ack+dropped', ts };
      }
      if (msg.includes('rejected')) {
        const err = (jp.err as Record<string, unknown> | undefined) ?? {};
        return {
          status: 'rejected',
          errorMessage: err.message as string | undefined,
          errorClass: err.name as string | undefined,
          ts,
        };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}

async function main(): Promise<void> {
  const actionId = randomUUID();
  const decisionId = `kan-687-mt-${Date.now().toString(36)}`;
  const contactId = randomUUID();
  const traceId = `kan-687-mt-${Date.now()}`;
  const ts = new Date().toISOString();

  const event = {
    topic: 'action.send' as const,
    timestamp: ts,
    connectionId: CONNECTION_ID,
    message: {
      tenantId: TENANT_ID,
      actionId,
      decisionId,
      contactId,
      traceId,
      recipient: { email: RECIPIENT, displayName: 'mail-tester' },
      content: {
        subject: 'Deliverability baseline — KAN-687',
        body: [
          'KAN-687 mail-tester baseline.',
          '',
          `actionId:  ${actionId}`,
          `traceId:   ${traceId}`,
          `timestamp: ${ts}`,
          '',
          'This is a single send through the production Resend pipeline,',
          'destined for mail-tester.com to score the deliverability posture',
          'of the growth.axisone.ca sender domain.',
          '',
          'See docs/infra/deliverability.md for the runbook context.',
        ].join('\n'),
        html: [
          '<p>KAN-687 mail-tester baseline.</p>',
          '<ul>',
          `<li>actionId: <code>${actionId}</code></li>`,
          `<li>traceId: <code>${traceId}</code></li>`,
          `<li>timestamp: ${ts}</li>`,
          '</ul>',
          '<p>This is a single send through the production Resend pipeline,',
          'destined for mail-tester.com to score the deliverability posture',
          'of the <code>growth.axisone.ca</code> sender domain.</p>',
          '<p>See <code>docs/infra/deliverability.md</code> for the runbook context.</p>',
        ].join(''),
      },
      categories: ['kan-687-mail-tester'],
    },
  };

  console.log(`mail-tester harness — single send to ${RECIPIENT}`);
  console.log(`  project:      ${PROJECT_ID}`);
  console.log(`  tenantId:     ${TENANT_ID}`);
  console.log(`  connectionId: ${CONNECTION_ID}`);
  console.log(`  actionId:     ${actionId}`);
  console.log('');

  const pubsub = new PubSub({ projectId: PROJECT_ID });
  const t0 = Date.now();
  const publishedAt = new Date();
  let pubsubMessageId: string;
  try {
    pubsubMessageId = await pubsub
      .topic(TOPIC)
      .publishMessage({ data: Buffer.from(JSON.stringify(event)) });
  } catch (err) {
    console.error('publish failed:', err);
    process.exit(1);
  }
  const publishMs = Date.now() - t0;
  console.log(`✓ published — pubsubMessageId=${pubsubMessageId} (${publishMs}ms)`);
  console.log('Polling Cloud Logging for worker confirmation (90s timeout)...');

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/logging.read'] });
  const result = await pollForDispatch(auth, actionId, publishedAt);

  if (!result) {
    console.log('');
    console.error('✗ no worker log entry within 90s — check Cloud Logging manually.');
    console.error(`  filter: jsonPayload.actionId="${actionId}"`);
    process.exit(1);
  }

  const dispatchMs = result.ts ? new Date(result.ts).getTime() - publishedAt.getTime() : null;
  console.log('');
  console.log(`worker dispatch: status=${result.status}` + (dispatchMs != null ? ` (${dispatchMs}ms after publish)` : ''));
  if (result.providerMessageId) {
    console.log(`Resend data.id: ${result.providerMessageId}`);
  }
  if (result.errorMessage) {
    console.log(`error class: ${result.errorClass ?? '(unset)'}`);
    console.log(`error message: ${result.errorMessage}`);
  }

  if (result.status !== 'sent') {
    console.log('');
    console.error('✗ send did not reach status=sent. mail-tester score will not be available.');
    process.exit(1);
  }

  console.log('');
  console.log('✅ Send accepted by Resend.');
  console.log('');
  console.log('Now refresh the mail-tester URL within the next 5 minutes:');
  console.log('  → the page you grabbed the address from on https://www.mail-tester.com/');
  console.log('');
  console.log('Capture the score and key findings, paste into docs/infra/deliverability.md');
  console.log("(under the 'Last audited' / current status block at the top).");
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
