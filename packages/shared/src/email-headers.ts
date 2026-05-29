/**
 * M3-2.5b — Email-header normalization for inbound reply correlation.
 *
 * Shared between the Resend Receiving webhook (publish side) and the
 * `lead-received` consumer (lookup side) so the bracket-strip + `@domain`-
 * strip is single-sourced. Both sides operate on the SAME canonical
 * shape; without this the producer's "store raw" + consumer's "lookup
 * stripped" pair would drift on each tweak.
 *
 * Wire contract:
 *   - Producer puts the RAW Resend Receiving header value into the
 *     LeadReceivedEvent payload (`<id@domain>` with brackets, References
 *     space-separated). Forensic value: re-emitting the wire form is
 *     useful when debugging unmatched inbounds.
 *   - Consumer normalizes via these helpers before sidecar write +
 *     correlation lookup. The outbound sidecar (M3-2.5a) stores Resend's
 *     send-response `id` raw (no brackets, no @domain), so the stripped
 *     form is what matches.
 *
 * Normalization shape (single source of truth):
 *   `<abc@resend.dev>`           → `abc`
 *   `<abc-def-123@some.host>`    → `abc-def-123`
 *   `<abc>`                      → `abc` (no @domain — kept verbatim post-bracket-strip)
 *   `abc@host`                   → `abc` (no brackets — strip works either way)
 *   `''`, null, undefined        → null
 *   non-string                   → null
 */

/**
 * Strip RFC 5322 Message-ID wrapping. Returns null on empty / nullish /
 * non-string input. Order: angle-bracket strip first, then `@domain` strip.
 * Falsey output (empty post-strip) → null so callers can skip lookup
 * unconditionally.
 */
export function stripMessageIdBrackets(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Strip leading `<` and trailing `>`.
  const noAngles = trimmed.replace(/^<+/, '').replace(/>+$/, '');
  // Strip from first `@` onward (the domain part).
  const atIdx = noAngles.indexOf('@');
  const idPart = atIdx >= 0 ? noAngles.slice(0, atIdx) : noAngles;
  const final = idPart.trim();
  return final || null;
}

/**
 * Parse RFC 5322 References header into an array of stripped Message-IDs.
 * References format: `<id1@d1> <id2@d2> <id3@d3>` (whitespace-separated).
 * Per-id we run the same bracket-and-domain strip as Message-ID. Empty
 * input or all-empty entries → empty array.
 */
export function parseReferencesHeader(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  // RFC 5322: tokens separated by whitespace (one or more).
  return trimmed
    .split(/\s+/)
    .map((tok) => stripMessageIdBrackets(tok))
    .filter((id): id is string => id !== null);
}
