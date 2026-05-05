/**
 * KAN-798a — Send Policy & Validation Layer (Phase 2 epic 5 of 5, sub-cohort a).
 *
 * Pure rule-based module. **NO LLM call.** Compliance and safety should be
 * deterministic — predictable, auditable, fast, cheap. This module
 * intentionally breaks the "every Phase 2 epic uses LLM" pattern of
 * KAN-794/795/796a/797a in a good way: governance rules are not subject to
 * AI judgment.
 *
 * Takes a ShapedMessage (or equivalent — only `channel` is read; the input
 * shape is intentionally minimal so non-shaped dispatch paths can also use
 * this gate). Evaluates policy rules in order; first deny wins.
 *
 * Rules (in evaluation order):
 *   1. SUPPRESSION — most-recent unrevoked unsubscribe/bounce/optout signal
 *      on the (Contact, channel) pair → deny. MVP: once suppressed, stays
 *      suppressed; revocation handling (re-subscribe events) deferred to
 *      KAN-815 sub-cohort b.
 *   2. RATE LIMIT — count of `<channel>_send` Engagements in last 24h for
 *      this (tenant, contact, channel) ≥ tenant max → deny. MVP default:
 *      3 per channel per contact per 24h. Per-tenant override via
 *      Tenant.settings.sendPolicy.maxSendsPerDayPerContact deferred to
 *      KAN-815 sub-cohort b.
 *   3. TIME-OF-DAY — outside tenant send window → defer with deferUntil
 *      set to next window opening. Default: 9am-9pm tenant-local.
 *      Per-tenant override via `Tenant.settings.sendWindow.{start,end}` as
 *      "HH:MM" strings (KAN-814 sub-cohort 0). Malformed/missing fields
 *      fall back to the 9/21 defaults with a `send-policy-window-fallback`
 *      log line for monitoring. Timezone read from `Tenant.settings.timezone`
 *      (KAN-741 era), UTC fallback.
 *
 * Caller (KAN-815 dispatch wrapper, which also wires sub-cohort b of this
 * epic) decides:
 *   - allow → proceed to channel API call
 *   - deny  → log + skip dispatch + write Action row with denied status
 *   - defer → schedule re-eval at deferUntil OR queue + re-poll
 *
 * Pure function — does NOT persist anything. Caller writes Action row +
 * Engagement row post-dispatch. Same posture as KAN-794-797a sibling
 * pure-module discipline.
 *
 * Sub-cohort scope:
 *   - (a) THIS PR: pure module + tests
 *   - (b) FOLDED INTO KAN-815: dispatch-path wiring + Tenant.settings hook
 *     for per-tenant policy overrides. KAN-815 is the natural integration
 *     point (message-shaper → send-policy gate → channel dispatch).
 *   - (c) FOLDED INTO KAN-808: jurisdiction-aware compliance (CAN-SPAM /
 *     CASL / GDPR specifics). Multi-tenancy hardening is the right home
 *     for region-specific governance, not a standalone sub-cohort.
 */
import type { PrismaClient } from '@prisma/client';
import type { ShapedMessage, ShapedMessageChannel } from './message-shaper.js';

// ─────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────

export type SendPolicyResult =
  | { type: 'allow'; reason: string }
  | { type: 'deny'; reason: string; ruleViolated: 'suppression' | 'rate_limit' }
  | { type: 'defer'; reason: string; deferUntil: Date };

export interface SendPolicyOptions {
  /** Bypass suppression check. For testing or transactional sends (e.g.,
   *  unsubscribe-confirmation emails that must reach a suppressed contact). */
  skipSuppression?: boolean;
  /** Bypass rate-limit check. For testing or operator manual overrides. */
  skipRateLimit?: boolean;
  /** Bypass time-of-day check. For urgent / high-priority sends or testing. */
  skipTimeOfDay?: boolean;
}

/**
 * Minimal input shape — only `channel` is read. Accepts a full ShapedMessage
 * OR any object with a compatible `channel` field, so non-shaped dispatch
 * paths can reuse this gate.
 */
export type SendPolicyMessageInput = Pick<ShapedMessage, 'channel'>;

export class SendPolicyTenantNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SendPolicyTenantNotFoundError';
  }
}

// ─────────────────────────────────────────────
// MVP defaults (Tenant.settings overrides deferred to KAN-815 sub-cohort b)
// ─────────────────────────────────────────────

const RATE_LIMIT_MAX_DEFAULT = 3;
const RATE_LIMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const SEND_WINDOW_START_HOUR_DEFAULT = 9; // 9am
const SEND_WINDOW_END_HOUR_DEFAULT = 21; // 9pm

/**
 * Suppression signal vocabulary. Read from Engagement history (no Contact-
 * level suppression field exists today). Defensive list:
 *   - email_unsubscribe / contact_optout: explicit user action
 *   - email_bounce: hard bounce signal from connector
 *   - email_complained: spam-complaint signal from connector (Resend webhooks
 *     emit this; included defensively even though not yet classified in
 *     engagement-service NEGATIVE_TYPES — KAN-749 vocab discipline applies
 *     to ACTION types, not engagement-history reads)
 */
const SUPPRESSION_ENGAGEMENT_TYPES: ReadonlyArray<string> = [
  'email_unsubscribe',
  'email_bounce',
  'email_complained',
  'contact_optout',
];

// ─────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────

/**
 * Evaluate whether a message may dispatch to its target channel.
 *
 * First-deny ordering: suppression beats rate limit beats time-of-day.
 * Suppression is the most consequential (regulatory exposure on send-after-
 * unsubscribe), then rate limit (consent / spam posture), then time-of-day
 * (UX / professionalism — defer not deny).
 *
 * Throws SendPolicyTenantNotFoundError when tenantId doesn't exist (the
 * time-of-day check needs the tenant for timezone resolution; failing fast
 * surfaces a programming error rather than silently UTC-defaulting).
 */
export async function evaluateSendPolicy(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  message: SendPolicyMessageInput,
  options: SendPolicyOptions = {},
): Promise<SendPolicyResult> {
  const channel = message.channel;

  // 1. Suppression — first deny wins because regulatory exposure is highest.
  if (!options.skipSuppression) {
    const suppression = await checkSuppression(prisma, contactId, channel);
    if (suppression.suppressed) {
      return {
        type: 'deny',
        reason: `Contact suppressed for ${channel}: ${suppression.reason} on ${suppression.suppressedAt!.toISOString()}`,
        ruleViolated: 'suppression',
      };
    }
  }

  // 2. Rate limit per (tenant, contact, channel) over rolling 24h.
  if (!options.skipRateLimit) {
    const rate = await checkRateLimit(prisma, tenantId, contactId, channel);
    if (rate.exceeded) {
      return {
        type: 'deny',
        reason: `Rate limit exceeded: ${rate.count}/${rate.max} ${channel} sends to this contact in last 24h`,
        ruleViolated: 'rate_limit',
      };
    }
  }

  // 3. Time-of-day window. Loads Tenant for (future) timezone field; UTC
  //    fallback today.
  if (!options.skipTimeOfDay) {
    const window = await checkTimeOfDay(prisma, tenantId);
    if (!window.inWindow) {
      return {
        type: 'defer',
        reason: `Outside tenant send window (${window.windowDescription})`,
        deferUntil: window.nextWindowOpenAt,
      };
    }
  }

  return { type: 'allow', reason: 'All policy checks passed' };
}

// ─────────────────────────────────────────────
// Helper — suppression check
// ─────────────────────────────────────────────

interface SuppressionResult {
  suppressed: boolean;
  reason?: string;
  suppressedAt?: Date;
}

async function checkSuppression(
  prisma: PrismaClient,
  contactId: string,
  channel: ShapedMessageChannel,
): Promise<SuppressionResult> {
  // Per-channel suppression: a contact unsubscribed from email is NOT
  // suppressed for SMS unless an SMS-specific suppression signal exists.
  // Query filters on (contactId, channel) to enforce this isolation.
  const recent = await prisma.engagement.findFirst({
    where: {
      contactId,
      channel,
      engagementType: { in: SUPPRESSION_ENGAGEMENT_TYPES as string[] },
    },
    orderBy: { occurredAt: 'desc' },
    select: { engagementType: true, occurredAt: true },
  });

  if (!recent) return { suppressed: false };

  // MVP: once suppressed, stays suppressed. KAN-815 sub-cohort b can wire
  // re-subscribe revocation handling (look for a more-recent re-subscribe
  // signal that revokes the suppression).
  return {
    suppressed: true,
    reason: recent.engagementType,
    suppressedAt: recent.occurredAt,
  };
}

// ─────────────────────────────────────────────
// Helper — rate limit check
// ─────────────────────────────────────────────

interface RateLimitResult {
  exceeded: boolean;
  count: number;
  max: number;
}

async function checkRateLimit(
  prisma: PrismaClient,
  tenantId: string,
  contactId: string,
  channel: ShapedMessageChannel,
): Promise<RateLimitResult> {
  const since = new Date(Date.now() - RATE_LIMIT_WINDOW_MS);

  // Per-channel separation — count only engagements with engagementType
  // matching the target channel. SMS sends do not count toward email rate
  // limit (and vice versa).
  const count = await prisma.engagement.count({
    where: {
      tenantId,
      contactId,
      channel,
      engagementType: { startsWith: `${channel}_send` },
      occurredAt: { gte: since },
    },
  });

  return {
    exceeded: count >= RATE_LIMIT_MAX_DEFAULT,
    count,
    max: RATE_LIMIT_MAX_DEFAULT,
  };
}

// ─────────────────────────────────────────────
// Helper — time-of-day check
// ─────────────────────────────────────────────

interface TimeOfDayResult {
  inWindow: boolean;
  windowDescription: string;
  nextWindowOpenAt: Date;
}

async function checkTimeOfDay(
  prisma: PrismaClient,
  tenantId: string,
): Promise<TimeOfDayResult> {
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, settings: true },
  });
  if (!tenant) {
    throw new SendPolicyTenantNotFoundError(`Tenant not found: ${tenantId}`);
  }

  // Tenant.timezone field doesn't exist (per pre-flight). Read from
  // Tenant.settings.timezone JSON path defensively; fall back to UTC.
  const settingsObj =
    tenant.settings && typeof tenant.settings === 'object' && !Array.isArray(tenant.settings)
      ? (tenant.settings as Record<string, unknown>)
      : {};
  const settingsTz =
    typeof settingsObj.timezone === 'string' ? (settingsObj.timezone as string) : 'UTC';

  const now = new Date();
  const tenantLocalHour = getTenantLocalHour(now, settingsTz);

  // KAN-814 sub-cohort 0 — per-tenant send-window override. Reads
  // `Tenant.settings.sendWindow.{start, end}` as "HH:MM" strings and parses
  // the integer hour. Malformed/missing values fall back to the 9/21
  // defaults with a `send-policy-window-fallback` log line so we can
  // monitor whether tenants are configuring this correctly.
  const { startHour, endHour } = resolveSendWindowHours(settingsObj, tenantId);
  const windowDescription = `${startHour}:00-${endHour}:00 ${settingsTz}`;

  const inWindow = tenantLocalHour >= startHour && tenantLocalHour < endHour;
  const nextWindowOpenAt = computeNextWindowOpen(now, tenantLocalHour, startHour, endHour, settingsTz);

  return { inWindow, windowDescription, nextWindowOpenAt };
}

/**
 * KAN-814 sub-cohort 0 — resolve per-tenant send-window start/end hours.
 *
 * Reads `Tenant.settings.sendWindow.{start, end}` as "HH:MM" strings and
 * parses the integer hour. Malformed/missing values fall back to the 9/21
 * defaults with a `send-policy-window-fallback` log line so we can monitor
 * whether tenants are configuring this correctly.
 *
 * Exported for test introspection — same posture as `getTenantLocalHour`.
 */
export function resolveSendWindowHours(
  settingsObj: Record<string, unknown>,
  tenantId: string,
): { startHour: number; endHour: number } {
  const sendWindow = settingsObj.sendWindow;
  if (
    !sendWindow ||
    typeof sendWindow !== 'object' ||
    Array.isArray(sendWindow)
  ) {
    // No override configured — silent default; only the malformed-but-present
    // case logs (so we don't spam logs for every default-tenant request).
    return {
      startHour: SEND_WINDOW_START_HOUR_DEFAULT,
      endHour: SEND_WINDOW_END_HOUR_DEFAULT,
    };
  }
  const sw = sendWindow as Record<string, unknown>;
  // Start hour rounds DOWN — "09:30" means "window starts during hour 9"
  // (slightly permissive). End hour rounds UP — "23:59" means "window
  // stays open all day" → endHour=24 → inWindow check `hour < 24` always
  // true. Both choices favor the tenant's expressed intent (open the
  // window) over hour-bucket exclusion.
  const startHour = parseHourFromHHMM(sw.start, 'down');
  const endHour = parseHourFromHHMM(sw.end, 'up');
  if (startHour === null || endHour === null) {
    console.warn(
      `[send-policy] send-policy-window-fallback tenantId=${tenantId} reason=malformed_sendWindow start=${JSON.stringify(sw.start)} end=${JSON.stringify(sw.end)} — falling back to ${SEND_WINDOW_START_HOUR_DEFAULT}/${SEND_WINDOW_END_HOUR_DEFAULT}`,
    );
    return {
      startHour: SEND_WINDOW_START_HOUR_DEFAULT,
      endHour: SEND_WINDOW_END_HOUR_DEFAULT,
    };
  }
  return { startHour, endHour };
}

/**
 * Parse "HH:MM" into integer hour. Returns null on any parse failure
 * (non-string, wrong shape, out-of-range). The HH:MM grammar matches what
 * tenant settings UI emits and what onboarding wizards typically write.
 *
 *   - mode='down' (start): drop the minute portion; "09:30" → 9
 *   - mode='up' (end): if minute > 0 round to the next hour; "21:30" → 22,
 *     "23:59" → 24 (sentinel for "all day" — `inWindow` check `hour < 24`
 *     always true).
 *
 * Hour range accepted: 0-23 input. Output range: 0-24 (mode='up' may emit
 * 24 as the "no upper bound" sentinel).
 */
function parseHourFromHHMM(raw: unknown, mode: 'up' | 'down'): number | null {
  if (typeof raw !== 'string') return null;
  const match = raw.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hour = parseInt(match[1]!, 10);
  const minute = parseInt(match[2]!, 10);
  if (isNaN(hour) || hour < 0 || hour > 23) return null;
  if (isNaN(minute) || minute < 0 || minute > 59) return null;
  if (mode === 'up' && minute > 0) return hour + 1;
  return hour;
}

/**
 * Tenant-local hour of the current moment. Uses Intl.DateTimeFormat with the
 * tenant's IANA timezone (or UTC fallback). Returns 0-23 integer.
 *
 * Exported for test introspection — timezone math is load-bearing for the
 * defer path; tests mock Date and assert hour boundaries.
 */
export function getTenantLocalHour(now: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    const hourStr = formatter.format(now);
    // 24h returns "0"-"23"; 12h returns "0 AM" etc — we asked hour12=false.
    const parsed = parseInt(hourStr, 10);
    if (isNaN(parsed) || parsed < 0 || parsed > 23) {
      // Defensive — invalid timezone falls back to UTC.
      return now.getUTCHours();
    }
    return parsed;
  } catch {
    // Invalid IANA timezone string → UTC fallback.
    return now.getUTCHours();
  }
}

/**
 * Compute the next window-open Date in tenant-local time.
 *
 * If currently before window-start (e.g. 6am, window 9am-9pm) → today at startHour.
 * If currently after window-end (e.g. 10pm, window 9am-9pm) → tomorrow at startHour.
 * If currently in window → today at startHour (defensive — caller doesn't
 * read this on the in-window path, but always returning a valid Date keeps
 * the type narrow).
 *
 * Exported for test introspection.
 */
export function computeNextWindowOpen(
  now: Date,
  tenantLocalHour: number,
  startHour: number,
  _endHour: number,
  timezone: string,
): Date {
  // Compute the next "tenant-local startHour" as a UTC Date instant.
  // Strategy: format `now` in the tenant timezone to extract local Y/M/D,
  // construct a Date string in that timezone at startHour, parse back to UTC.
  const localDateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now); // en-CA → "YYYY-MM-DD"

  const [year, month, day] = localDateStr.split('-').map((n) => parseInt(n, 10));

  // If we're past window-end today, advance to tomorrow.
  // If we're before window-start today, today's startHour is fine.
  // If we're in window (defensive caller path), return today's startHour too.
  let targetDay = day;
  let targetMonth = month;
  let targetYear = year;
  if (tenantLocalHour >= _endHour) {
    // Tomorrow.
    const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
    targetYear = tomorrow.getUTCFullYear();
    targetMonth = tomorrow.getUTCMonth() + 1;
    targetDay = tomorrow.getUTCDate();
  }

  // Build a Date that represents `targetYear-targetMonth-targetDay startHour:00:00`
  // in the tenant's timezone, expressed as UTC. We do this by computing the
  // UTC offset for that target instant in the tenant's timezone.
  // Approach: build a candidate UTC Date at startHour, then adjust by the
  // tenant's offset at that moment.
  const candidate = new Date(Date.UTC(targetYear, targetMonth - 1, targetDay, startHour, 0, 0));
  const offsetMin = getTimezoneOffsetMinutes(candidate, timezone);
  // candidate is interpreted as UTC startHour; we want startHour in the
  // tenant's local time. So shift by the offset (negative offsets like
  // America/New_York EST = -300 min require ADDING |offset| to UTC).
  return new Date(candidate.getTime() - offsetMin * 60 * 1000);
}

/**
 * UTC offset in minutes for a given UTC instant in the tenant's timezone.
 * Positive for east of UTC (e.g. Europe/Berlin in summer = +120), negative
 * for west (e.g. America/New_York EST = -300, EDT = -240).
 */
function getTimezoneOffsetMinutes(utcInstant: Date, timezone: string): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(utcInstant);
    const get = (type: string) => parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
    const localMs = Date.UTC(
      get('year'),
      get('month') - 1,
      get('day'),
      get('hour') === 24 ? 0 : get('hour'), // Intl can yield "24" at midnight
      get('minute'),
      get('second'),
    );
    return Math.round((localMs - utcInstant.getTime()) / 60000);
  } catch {
    return 0; // UTC fallback.
  }
}
