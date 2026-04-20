/**
 * SMS keyword handling per CTIA / TCPA / CASL.
 *
 * Carriers require operators to honor specific opt-out/help/opt-in keywords
 * on every 10DLC number. Detection happens BEFORE anything else on inbound —
 * keyword traffic must not flow into the AI loop.
 *
 * KAN-579: STOP/HELP/START keyword handling per TCPA
 */

/** Keyword categories we act on. Canonical STOP/HELP/START + widely-accepted variants. */
export type SmsKeyword = 'STOP' | 'HELP' | 'START';

// Normalize incoming body for robust matching.
// Industry practice: case-insensitive, single token, trim.
const STOP_WORDS = new Set(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT']);
const HELP_WORDS = new Set(['HELP', 'INFO']);
const START_WORDS = new Set(['START', 'YES', 'UNSTOP']);

export function detectKeyword(body: string): SmsKeyword | null {
  const token = body.trim().toUpperCase();
  // Only single-word messages should trigger. Multi-word with STOP mid-sentence is NOT an opt-out.
  if (token.includes(' ')) return null;
  if (STOP_WORDS.has(token)) return 'STOP';
  if (HELP_WORDS.has(token)) return 'HELP';
  if (START_WORDS.has(token)) return 'START';
  return null;
}

/**
 * Standard CTIA-compliant HELP auto-reply body.
 * Tenants can override via AiAgentConfig in a future iteration.
 */
export function helpAutoReplyBody(brandName: string): string {
  return (
    `${brandName}: Reply STOP to unsubscribe. For support email support@${brandName.toLowerCase().replace(/\s+/g, '')}.com. ` +
    `Msg&Data rates may apply.`
  );
}

/** Standard STOP confirmation body (carriers typically auto-reply too — this is redundant-safe). */
export function stopConfirmationBody(brandName: string): string {
  return `${brandName}: You're unsubscribed. No more messages will be sent. Reply START to resubscribe.`;
}

export function startConfirmationBody(brandName: string): string {
  return `${brandName}: You've been resubscribed. Reply STOP anytime to opt out.`;
}
