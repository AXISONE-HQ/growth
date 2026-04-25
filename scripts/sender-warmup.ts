/**
 * KAN-687 sender warmup harness — daily trickle send to build domain
 * reputation on growth.axisone.ca after the KAN-662 Hotmail-spam outcome.
 *
 * Same code path as scripts/phase-e-retry.ts and scripts/mail-tester-send.ts:
 * publishes ActionSendEvents to the `action.send` Pub/Sub topic, the
 * connectors worker dispatches via the Resend adapter. No shortcuts —
 * we're warming the production sender, not a test one.
 *
 * Usage:
 *   PHASE_E_TENANT_ID=<uuid> PHASE_E_CONNECTION_ID=<uuid> \
 *     npx tsx scripts/sender-warmup.ts --day <N> [--dry-run]
 *
 *   PHASE_E_TENANT_ID=<uuid> PHASE_E_CONNECTION_ID=<uuid> \
 *     npx tsx scripts/sender-warmup.ts --hotmail-check
 *
 * Flags:
 *   --day <1..14>     Send the day-N batch per the SCHEDULE table below.
 *   --dry-run         Print the planned batch (recipients + subjects) without
 *                     publishing. State file is NOT updated.
 *   --hotmail-check   One realistic message to frederic.binette@hotmail.com
 *                     for day-7 / day-14 placement spot-check. Independent of
 *                     the day schedule and idempotency state.
 *
 * Idempotency: state at /tmp/sender-warmup-state.json. A given --day rerun
 * within 12h is a no-op with a clear log line. Override the state file path
 * with WARMUP_STATE_FILE=<path>.
 *
 * Exit codes:
 *   0 — all sends in the batch confirmed, OR batch already ran (idempotent),
 *       OR --dry-run completed.
 *   1 — one or more sends failed, timed out, or hit the DLQ.
 *   2 — bad invocation (missing env, bad day number, no flag).
 */

import { PubSub } from '@google-cloud/pubsub';
import { GoogleAuth } from 'google-auth-library';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync } from 'fs';

const PROJECT_ID = 'growth-493400';
const TOPIC = 'action.send';
const SERVICE_NAME = 'growth-connectors';
const NIL_UUID = '00000000-0000-0000-0000-000000000000';
const STATE_FILE = process.env.WARMUP_STATE_FILE ?? '/tmp/sender-warmup-state.json';
const RERUN_WINDOW_MS = 12 * 60 * 60 * 1000; // 12h

// ── SCHEDULE ─────────────────────────────────────────────────────────────
// Flat 6/day for 14 days — Fred's call after the recipient-pool decision.
// 6/day is the natural cap with 3 inboxes × 2 templates (per-recipient
// template diversity), so the schedule is set explicitly instead of auto-
// truncating from a higher target. Closer to Microsoft's recommended slow-
// ramp profile anyway.
//
// Day-7 and day-14 are the Hotmail-check inflection points — same value,
// different semantics: run --hotmail-check after the day's batch and
// confirm placement before advancing.
const SCHEDULE: Record<number, number> = {
  1: 6,
  2: 6,
  3: 6,
  4: 6,
  5: 6,
  6: 6,
  7: 6, // checkpoint — Hotmail placement check after this run
  8: 6,
  9: 6,
  10: 6,
  11: 6,
  12: 6,
  13: 6,
  14: 6, // checkpoint — Hotmail placement check after this run; if still spam, escalate to SNDS/JMRP
};

// ── RECIPIENT POOL ───────────────────────────────────────────────────────
// Fred's own inboxes. Add more here as the pool grows. The script enforces a
// per-recipient daily cap so the schedule volume can't push any single inbox
// beyond a Microsoft-reasonable rate. If volume > pool * cap, the schedule
// auto-truncates and the dry-run prints a warning.
const RECIPIENTS: Array<{ email: string; displayName: string; provider: string }> = [
  { email: 'fred@axisone.ca', displayName: 'Fred', provider: 'Gmail (axisone.ca)' },
  { email: 'fred@mkze.vc', displayName: 'Fred', provider: 'Gmail (mkze.vc)' },
  { email: 'frederic.binette@hotmail.com', displayName: 'Frederic', provider: 'Outlook (hotmail.com)' },
];
const PER_RECIPIENT_DAILY_CAP = 4; // Microsoft tolerates ~3-5/day from a recovering sender to a single mailbox.

// ── CONTENT TEMPLATES ────────────────────────────────────────────────────
// 2 drafted as proof of style; the other 8 are TODOs awaiting Fred's review.
// Each template is a function (recipientFirstName, dateStr) → { subject, text, html }.
// Realistic length (300-800 words HTML), transactional voice, distinct subjects.

interface RenderedMessage {
  subject: string;
  text: string;
  html: string;
}
type Template = (firstName: string, dateStr: string, seed: number) => RenderedMessage;

const TEMPLATES: { id: string; render: Template }[] = [
  {
    id: 'daily-digest',
    render: (firstName, dateStr, seed) => {
      const opps = 5 + (seed % 7);
      const decisions = 3 + (seed % 5);
      const actions = 2 + (seed % 4);
      const completedRate = 78 + (seed % 12);
      // Subject varies by seed so two recipients getting the daily-digest in
      // the same batch don't share an identical subject line. Microsoft's
      // filters cluster subjects across the inbox.
      const subject = `Your AxisOne Growth pipeline summary — ${opps} new opportunities`;
      const text = [
        `Hi ${firstName},`,
        '',
        `Here's your AxisOne Growth pipeline summary for ${dateStr}.`,
        '',
        `OPPORTUNITIES`,
        `${opps} new opportunities entered the pipeline today, drawn from the seed feed and your Day-1 wedge signals. Three are in the high-intent bucket — they showed pricing-page activity within the last 48 hours, which historically correlates with a 2.4x close rate compared to the baseline.`,
        '',
        `DECISIONS`,
        `The Decision Engine ran ${decisions} contact-level decisions overnight. Each ran against your tenant's playbook ladder; the recommended actions are queued for Communication Agent review. Two decisions deferred to manual review because the contact's last engagement signal was older than the freshness window.`,
        '',
        `ACTIONS EXECUTED`,
        `${actions} outbound actions completed yesterday with a ${completedRate}% delivery rate. The remaining were classified as deterministic failures (mostly bounce/suppression) and won't be retried.`,
        '',
        `WHAT'S NEXT`,
        `The next pipeline tick runs at 09:00 ${dateStr === 'today' ? 'tomorrow' : 'on the next business day'}. If you'd like to review opportunities before they enter playbook execution, the Pipeline view has a "needs review" filter at the top.`,
        '',
        `View dashboard: https://growth.axisone.ca/dashboard`,
        '',
        '— AxisOne Growth',
        '',
        "You're receiving this because you have AxisOne Growth daily digests enabled.",
      ].join('\n');
      const html = `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#111;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;">
<p>Hi ${firstName},</p>
<p>Here's your AxisOne Growth pipeline summary for <strong>${dateStr}</strong>.</p>

<h3 style="margin-top:24px;">Opportunities</h3>
<p><strong>${opps}</strong> new opportunities entered the pipeline today, drawn from the seed feed and your Day-1 wedge signals. Three are in the high-intent bucket — they showed pricing-page activity within the last 48 hours, which historically correlates with a 2.4x close rate compared to the baseline.</p>

<h3 style="margin-top:24px;">Decisions</h3>
<p>The Decision Engine ran <strong>${decisions}</strong> contact-level decisions overnight. Each ran against your tenant's playbook ladder; the recommended actions are queued for Communication Agent review. Two decisions deferred to manual review because the contact's last engagement signal was older than the freshness window.</p>

<h3 style="margin-top:24px;">Actions executed</h3>
<p><strong>${actions}</strong> outbound actions completed yesterday with a <strong>${completedRate}%</strong> delivery rate. The remaining were classified as deterministic failures (mostly bounce/suppression) and won't be retried.</p>

<h3 style="margin-top:24px;">What's next</h3>
<p>The next pipeline tick runs at 09:00 ${dateStr === 'today' ? 'tomorrow' : 'on the next business day'}. If you'd like to review opportunities before they enter playbook execution, the Pipeline view has a "needs review" filter at the top.</p>

<p style="margin-top:24px;"><a href="https://growth.axisone.ca/dashboard" style="background:#4F46E5;color:white;padding:10px 18px;text-decoration:none;border-radius:6px;display:inline-block;">View dashboard</a></p>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px 0;">
<p style="color:#6b7280;font-size:13px;">— AxisOne Growth</p>
<p style="color:#6b7280;font-size:12px;">You're receiving this because you have AxisOne Growth daily digests enabled.</p>
</body></html>`.trim();
      return { subject, text, html };
    },
  },
  {
    id: 'weekly-recap',
    render: (firstName, dateStr, seed) => {
      const totalActions = 38 + (seed % 22);
      const inboxRate = 82 + (seed % 8);
      const newOpps = 14 + (seed % 6);
      const closedWon = 2 + (seed % 3);
      const subject = `This week on AxisOne Growth — ${totalActions} actions, ${closedWon} closed-won`;
      const text = [
        `Hi ${firstName},`,
        '',
        `Quick recap of your AxisOne Growth pipeline this week.`,
        '',
        `THE NUMBERS`,
        `- ${totalActions} outbound actions executed`,
        `- ${inboxRate}% inbox delivery rate (Gmail + Outlook combined)`,
        `- ${newOpps} new opportunities surfaced`,
        `- ${closedWon} closed-won`,
        '',
        `WHAT MOVED`,
        `Your highest-intent opportunity this week was sourced from the wedge signal "viewed pricing 3+ times in 7 days" — closed in 4 days, total touch count was 6 (2 emails, 1 SMS, 3 in-app nudges). The playbook that ran was the Day-1 standard ladder.`,
        '',
        `Two opportunities moved out of the pipeline this week without a closed-won — both because the contact unsubscribed from the email channel after the first nudge. The behavior is logged and will downweight the email-first ladder for similar-shaped contacts going forward.`,
        '',
        `WHERE TO LOOK NEXT`,
        `Three opportunities are sitting in the "needs review" bucket as of ${dateStr}. They flagged because the Decision Engine couldn't reach a confident recommendation given the available signals. The fastest unblock is usually adding a missing CRM field on the contact (job title is the most common gap).`,
        '',
        `The full week-over-week comparison is on your dashboard:`,
        `https://growth.axisone.ca/dashboard?range=week`,
        '',
        '— AxisOne Growth',
        '',
        `Sent weekly. To change frequency, visit your notification preferences.`,
      ].join('\n');
      const html = `
<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#111;line-height:1.6;max-width:560px;margin:0 auto;padding:24px;">
<p>Hi ${firstName},</p>
<p>Quick recap of your AxisOne Growth pipeline this week.</p>

<h3 style="margin-top:24px;">The numbers</h3>
<table cellpadding="6" style="border-collapse:collapse;font-size:14px;">
<tr><td style="color:#6b7280;">Outbound actions executed</td><td><strong>${totalActions}</strong></td></tr>
<tr><td style="color:#6b7280;">Inbox delivery rate (Gmail + Outlook)</td><td><strong>${inboxRate}%</strong></td></tr>
<tr><td style="color:#6b7280;">New opportunities surfaced</td><td><strong>${newOpps}</strong></td></tr>
<tr><td style="color:#6b7280;">Closed-won</td><td><strong>${closedWon}</strong></td></tr>
</table>

<h3 style="margin-top:24px;">What moved</h3>
<p>Your highest-intent opportunity this week was sourced from the wedge signal <em>"viewed pricing 3+ times in 7 days"</em> — closed in 4 days, total touch count was 6 (2 emails, 1 SMS, 3 in-app nudges). The playbook that ran was the Day-1 standard ladder.</p>
<p>Two opportunities moved out of the pipeline this week without a closed-won — both because the contact unsubscribed from the email channel after the first nudge. The behavior is logged and will downweight the email-first ladder for similar-shaped contacts going forward.</p>

<h3 style="margin-top:24px;">Where to look next</h3>
<p>Three opportunities are sitting in the <strong>needs review</strong> bucket as of ${dateStr}. They flagged because the Decision Engine couldn't reach a confident recommendation given the available signals. The fastest unblock is usually adding a missing CRM field on the contact (job title is the most common gap).</p>

<p style="margin-top:24px;"><a href="https://growth.axisone.ca/dashboard?range=week" style="background:#4F46E5;color:white;padding:10px 18px;text-decoration:none;border-radius:6px;display:inline-block;">View weekly comparison</a></p>

<hr style="border:none;border-top:1px solid #e5e7eb;margin:32px 0 16px 0;">
<p style="color:#6b7280;font-size:13px;">— AxisOne Growth</p>
<p style="color:#6b7280;font-size:12px;">Sent weekly. To change frequency, visit your notification preferences.</p>
</body></html>`.trim();
      return { subject, text, html };
    },
  },
  // TODO(KAN-687): 8 more templates pending Fred's review of the 2 above.
  // Planned IDs (per brief):
  //   - onboarding-nudge          ("Next step in your AxisOne setup")
  //   - action-confirmation       ("Your action completed — <fake_action_name>")
  //   - playbook-update           ("Your playbook ladder was updated")
  //   - opportunity-surfaced      ("New opportunity for review: <fake_company>")
  //   - decision-deferred         ("A decision was deferred for your review")
  //   - integration-health        ("Your <integration> is healthy")
  //   - week-ahead                ("Your week ahead on AxisOne Growth")
  //   - feature-announce          ("New in AxisOne Growth: <fake_feature>")
];

// ── STATE FILE I/O ───────────────────────────────────────────────────────
interface StateFile {
  runs: Array<{
    day: number;
    ranAt: string; // ISO
    volume: number;
    succeeded: number;
    failed: number;
  }>;
}

function loadState(): StateFile {
  if (!existsSync(STATE_FILE)) return { runs: [] };
  try {
    const raw = readFileSync(STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as StateFile;
    if (!Array.isArray(parsed.runs)) return { runs: [] };
    return parsed;
  } catch {
    return { runs: [] };
  }
}

function saveState(s: StateFile): void {
  writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
}

function lastRunForDay(s: StateFile, day: number): StateFile['runs'][number] | undefined {
  return [...s.runs].reverse().find((r) => r.day === day);
}

// ── ARG PARSING ──────────────────────────────────────────────────────────
interface Args {
  day?: number;
  dryRun: boolean;
  hotmailCheck: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { dryRun: false, hotmailCheck: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--day') {
      const next = argv[++i];
      const n = Number(next);
      if (!Number.isInteger(n) || n < 1 || n > 14) {
        throw new Error(`--day must be an integer 1..14, got ${next}`);
      }
      args.day = n;
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--hotmail-check') {
      args.hotmailCheck = true;
    } else if (a === '--help' || a === '-h') {
      console.log('Usage: see header docstring at scripts/sender-warmup.ts');
      process.exit(0);
    } else {
      throw new Error(`unknown arg: ${a}`);
    }
  }
  if (!args.hotmailCheck && args.day == null) {
    throw new Error('must pass either --day <N> or --hotmail-check');
  }
  return args;
}

// ── BATCH PLANNING ───────────────────────────────────────────────────────
interface PlannedSend {
  recipient: (typeof RECIPIENTS)[number];
  templateId: string;
  subject: string;
  text: string;
  html: string;
  seed: number;
}

function planBatch(day: number): { sends: PlannedSend[]; truncatedFrom?: number } {
  const requested = SCHEDULE[day];
  // Per-recipient template diversity: a single recipient never receives the
  // same template twice within one batch. With T templates, max distinct
  // sends per recipient is T. So the effective per-recipient cap is the
  // smaller of the operator-set cap and the template pool size.
  const effectiveCap = Math.min(PER_RECIPIENT_DAILY_CAP, TEMPLATES.length);
  const cap = RECIPIENTS.length * effectiveCap;
  const volume = Math.min(requested, cap);
  const truncatedFrom = volume < requested ? requested : undefined;
  const today = new Date();
  const dateStr = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

  const sends: PlannedSend[] = [];
  // Each recipient cycles through templates in their own order, with the
  // starting template offset by recipient index. This (a) guarantees a single
  // recipient never repeats a template within a batch and (b) keeps adjacent
  // recipients on different templates as long as TEMPLATES.length > 1.
  // With T < R (template pool < recipient pool) some inter-recipient template
  // sharing is unavoidable per pigeonhole — subject-line variation in the
  // template handles the resulting subject collision.
  const perRecipientCount: Record<string, number> = {};
  for (let i = 0; i < volume; i++) {
    const recipient = RECIPIENTS[i % RECIPIENTS.length];
    const recipientIndex = i % RECIPIENTS.length;
    const recipientCount = perRecipientCount[recipient.email] ?? 0;
    perRecipientCount[recipient.email] = recipientCount + 1;
    const templateIndex = (recipientCount + recipientIndex) % TEMPLATES.length;
    const tpl = TEMPLATES[templateIndex];
    const seed = day * 100 + i;
    const rendered = tpl.render(recipient.displayName, dateStr, seed);
    sends.push({ recipient, templateId: tpl.id, ...rendered, seed });
  }
  return { sends, truncatedFrom };
}

// ── PUBLISH + POLL ───────────────────────────────────────────────────────
const TENANT_ID = process.env.PHASE_E_TENANT_ID;
const CONNECTION_ID = process.env.PHASE_E_CONNECTION_ID ?? NIL_UUID;

function buildEvent(send: PlannedSend): { event: unknown; actionId: string } {
  const actionId = randomUUID();
  const decisionId = `kan-687-warmup-${Date.now().toString(36)}-${send.seed}`;
  const contactId = randomUUID();
  const traceId = `kan-687-warmup-${Date.now()}-${send.seed}`;
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
      recipient: { email: send.recipient.email, displayName: send.recipient.displayName },
      content: { subject: send.subject, body: send.text, html: send.html },
      categories: ['kan-687-warmup', `template:${send.templateId}`],
    },
  };
  return { event, actionId };
}

interface Result {
  email: string;
  templateId: string;
  actionId: string;
  publishedAt: Date;
  publishMs: number;
  resendMessageId?: string;
  status: 'pending' | 'sent' | 'suppressed' | 'failed' | 'dropped' | 'rejected' | 'timeout';
  error?: string;
}

async function pollWorkerLogs(auth: GoogleAuth, results: Result[]): Promise<void> {
  const POLL_TIMEOUT_MS = 120_000;
  const POLL_INTERVAL_MS = 5_000;
  const pending = results.filter((r) => r.status === 'pending');
  if (pending.length === 0) return;

  const earliest = pending.reduce(
    (min, r) => (r.publishedAt < min ? r.publishedAt : min),
    pending[0].publishedAt,
  );
  const sinceIso = new Date(earliest.getTime() - 5_000).toISOString();
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  const client = await auth.getClient();

  while (Date.now() < deadline && pending.some((r) => r.status === 'pending')) {
    const filter = [
      `resource.type="cloud_run_revision"`,
      `resource.labels.service_name="${SERVICE_NAME}"`,
      `timestamp>="${sinceIso}"`,
      `(jsonPayload.msg:"action-send-push" OR jsonPayload.msg:"simple-mode")`,
    ].join(' AND ');

    const res = (await client.request({
      url: 'https://logging.googleapis.com/v2/entries:list',
      method: 'POST',
      data: {
        resourceNames: [`projects/${PROJECT_ID}`],
        filter,
        orderBy: 'timestamp asc',
        pageSize: 200,
      },
    })) as { data: { entries?: Array<Record<string, unknown>> } };

    for (const e of res.data.entries ?? []) {
      const jp = (e.jsonPayload ?? {}) as Record<string, unknown>;
      const actionId = jp.actionId as string | undefined;
      const msg = jp.msg as string | undefined;
      if (!actionId || !msg) continue;
      const target = pending.find((r) => r.actionId === actionId && r.status === 'pending');
      if (!target) continue;

      if (msg.includes('dispatched')) {
        const status = jp.status as string | undefined;
        target.resendMessageId = jp.providerMessageId as string | undefined;
        target.status = status === 'sent' ? 'sent' : status === 'suppressed' ? 'suppressed' : 'failed';
        if (target.status === 'failed') target.error = 'worker dispatched with status=failed';
      } else if (msg.includes('no ACTIVE email')) {
        target.status = 'dropped';
        target.error = 'worker found no ACTIVE EMAIL ChannelConnection';
      } else if (msg.includes('rejected')) {
        const err = (jp.err as Record<string, unknown> | undefined) ?? {};
        target.status = 'rejected';
        target.error = `${err.name ?? 'unknown'}: ${err.message ?? ''}`;
      }
    }

    if (pending.every((r) => r.status !== 'pending')) break;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }

  for (const r of pending) {
    if (r.status === 'pending') {
      r.status = 'timeout';
      r.error = `no worker log entry within ${POLL_TIMEOUT_MS / 1000}s`;
    }
  }
}

function pad(s: string, n: number): string {
  const t = s.length > n ? s.slice(0, n - 1) + '…' : s;
  return t.padEnd(n);
}

function printResultsTable(results: Result[]): void {
  const cols = [
    { h: 'Recipient', w: 32 },
    { h: 'Template', w: 22 },
    { h: 'Resend Message ID', w: 28 },
    { h: 'Status', w: 10 },
  ];
  const sep = '+' + cols.map((c) => '-'.repeat(c.w + 2)).join('+') + '+';
  console.log(sep);
  console.log('| ' + cols.map((c) => pad(c.h, c.w)).join(' | ') + ' |');
  console.log(sep);
  for (const r of results) {
    console.log(
      '| ' +
        [
          pad(r.email, cols[0].w),
          pad(r.templateId, cols[1].w),
          pad(r.resendMessageId ?? '(none)', cols[2].w),
          pad(r.status, cols[3].w),
        ].join(' | ') +
        ' |',
    );
  }
  console.log(sep);
}

// ── COMMAND HANDLERS ─────────────────────────────────────────────────────
async function runDay(day: number, dryRun: boolean): Promise<number> {
  const { sends, truncatedFrom } = planBatch(day);
  const requested = SCHEDULE[day];

  console.log(`[sender-warmup] day ${day} — schedule asks for ${requested} send(s)`);
  if (truncatedFrom) {
    console.log(
      `  ⚠️ TRUNCATED to ${sends.length} (recipient pool ${RECIPIENTS.length} × per-recipient daily cap ${PER_RECIPIENT_DAILY_CAP})`,
    );
    console.log('  Add more inboxes to RECIPIENTS or raise PER_RECIPIENT_DAILY_CAP to grow the pool.');
  }
  if (TEMPLATES.length < 5) {
    console.log(
      `  ⚠️ Template pool is ${TEMPLATES.length}/8 (planned). Per-batch variety is constrained until the rest land.`,
    );
  }
  console.log('');

  console.log('Planned batch:');
  for (let i = 0; i < sends.length; i++) {
    const s = sends[i];
    console.log(`  ${String(i + 1).padStart(2)}. → ${s.recipient.email.padEnd(32)} [${s.templateId}] "${s.subject}"`);
  }
  console.log('');

  if (dryRun) {
    console.log('[--dry-run] no events published. State file not updated. Exit 0.');
    return 0;
  }

  if (!TENANT_ID) {
    console.error('ERROR: PHASE_E_TENANT_ID is required for live runs.');
    return 2;
  }

  // Idempotency check (only on live runs)
  const state = loadState();
  const prior = lastRunForDay(state, day);
  if (prior) {
    const ageMs = Date.now() - new Date(prior.ranAt).getTime();
    if (ageMs < RERUN_WINDOW_MS) {
      const hours = (ageMs / 1000 / 60 / 60).toFixed(1);
      console.log(
        `[idempotent no-op] day ${day} already ran at ${prior.ranAt} (${hours}h ago). Wait > 12h or move state file (${STATE_FILE}) to retry.`,
      );
      return 0;
    }
  }

  // Publish
  console.log(`Publishing ${sends.length} ActionSendEvent(s)...`);
  const pubsub = new PubSub({ projectId: PROJECT_ID });
  const topic = pubsub.topic(TOPIC);
  const results: Result[] = [];

  for (const s of sends) {
    const { event, actionId } = buildEvent(s);
    const t0 = Date.now();
    const publishedAt = new Date();
    try {
      const messageId = await topic.publishMessage({ data: Buffer.from(JSON.stringify(event)) });
      const publishMs = Date.now() - t0;
      console.log(`  ✓ → ${s.recipient.email}  actionId=${actionId}  pubsubId=${messageId}  (${publishMs}ms)`);
      results.push({
        email: s.recipient.email,
        templateId: s.templateId,
        actionId,
        publishedAt,
        publishMs,
        status: 'pending',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ✗ publish failed for ${s.recipient.email}: ${msg}`);
      results.push({
        email: s.recipient.email,
        templateId: s.templateId,
        actionId,
        publishedAt,
        publishMs: Date.now() - t0,
        status: 'failed',
        error: msg,
      });
    }
  }

  console.log(`\nPolling Cloud Logging for worker confirmations (120s timeout)...`);
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/logging.read'] });
  await pollWorkerLogs(auth, results);

  console.log('');
  printResultsTable(results);

  const succeeded = results.filter((r) => r.status === 'sent').length;
  const failed = results.length - succeeded;

  // Update state
  state.runs.push({
    day,
    ranAt: new Date().toISOString(),
    volume: results.length,
    succeeded,
    failed,
  });
  saveState(state);

  console.log('');
  console.log(`day ${day} summary: ${succeeded}/${results.length} sent`);
  if (day === 7 || day === 14) {
    console.log('');
    console.log(`👀 CHECKPOINT — manually verify Hotmail (frederic.binette@hotmail.com) placement.`);
    console.log(`   If still in spam: slow the ramp (don't advance to day ${day + 1}), wait 7d, escalate to`);
    console.log(`   Microsoft SNDS registration. See docs/infra/deliverability.md "Warmup playbook".`);
  }
  return failed === 0 ? 0 : 1;
}

async function runHotmailCheck(): Promise<number> {
  if (!TENANT_ID) {
    console.error('ERROR: PHASE_E_TENANT_ID is required.');
    return 2;
  }
  const dateStr = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const tpl = TEMPLATES[0]; // daily-digest, the most plausible single send
  const rendered = tpl.render('Frederic', dateStr, Math.floor(Math.random() * 1000));
  const send: PlannedSend = {
    recipient: RECIPIENTS.find((r) => r.email === 'frederic.binette@hotmail.com')!,
    templateId: tpl.id,
    seed: 0,
    ...rendered,
  };
  console.log(`[--hotmail-check] one realistic message to ${send.recipient.email}`);
  console.log(`  template: ${send.templateId}`);
  console.log(`  subject:  "${send.subject}"`);
  console.log('');

  const { event, actionId } = buildEvent(send);
  const pubsub = new PubSub({ projectId: PROJECT_ID });
  const t0 = Date.now();
  const publishedAt = new Date();
  let pubsubId: string;
  try {
    pubsubId = await pubsub.topic(TOPIC).publishMessage({ data: Buffer.from(JSON.stringify(event)) });
  } catch (err) {
    console.error('publish failed:', err);
    return 1;
  }
  console.log(`✓ published — pubsubMessageId=${pubsubId} actionId=${actionId} (${Date.now() - t0}ms)`);
  console.log('Polling Cloud Logging for confirmation (120s)...');

  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/logging.read'] });
  const results: Result[] = [
    {
      email: send.recipient.email,
      templateId: send.templateId,
      actionId,
      publishedAt,
      publishMs: Date.now() - t0,
      status: 'pending',
    },
  ];
  await pollWorkerLogs(auth, results);
  console.log('');
  printResultsTable(results);
  console.log('');
  if (results[0].status === 'sent') {
    console.log(`Resend message ID: ${results[0].resendMessageId}`);
    console.log('');
    console.log('👀 Now check the Outlook inbox at frederic.binette@hotmail.com:');
    console.log('   - Inbox  → reputation is recovering ✓');
    console.log('   - Spam   → ramp needs more days, OR escalate to SNDS/JMRP');
    console.log(`   Subject to look for: "${send.subject}"`);
    return 0;
  }
  return 1;
}

// ── ENTRY ────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error('ERROR:', err instanceof Error ? err.message : String(err));
    console.error('Usage: see header docstring at scripts/sender-warmup.ts');
    process.exit(2);
  }

  if (args.hotmailCheck) {
    process.exit(await runHotmailCheck());
  }
  process.exit(await runDay(args.day!, args.dryRun));
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
