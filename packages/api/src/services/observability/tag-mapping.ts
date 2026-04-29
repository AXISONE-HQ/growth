/**
 * KAN-745 PR B — locked callerTag prefix taxonomy.
 *
 * Six prefixes total. The aggregator collapses the free-form `callerTag`
 * field on every llm.call event into one of these prefixes for rollup
 * keying. Adding a new prefix means adding to this constant + filing a
 * follow-up to update the May 6 audit classifier (TBD if/when needed).
 *
 * Match order matters: longest prefix first so `agentic-tool` doesn't
 * collide with `agentic`.
 */
export const CALLER_TAG_PREFIXES = [
  /** agentic-decision-runner per-iteration LLM calls (KAN-745 PR A) */
  'agentic-tool',
  /** agentic tool-call dispatch (KAN-739; emits via llm-client when KAN-734-class follow-up lands) */
  'agentic',
  /** KAN-660 send-time message generation (Haiku tier) */
  'message-composer',
  /** KAN-705 AI lead-assignment fallback (Sonnet tier) */
  'lead-assignment',
  /** KAN-754 Recommendations accept-emit if/when it routes through llm-client */
  'recommendation',
] as const;

export type CallerTagPrefix = typeof CALLER_TAG_PREFIXES[number] | 'other';

const SORTED_BY_LENGTH_DESC = [...CALLER_TAG_PREFIXES].sort((a, b) => b.length - a.length);

/**
 * Collapse a free-form callerTag string into one of the canonical prefixes.
 * Examples:
 *   'agentic-tool:get_contact_context' → 'agentic-tool'
 *   'agentic:iter3'                    → 'agentic'
 *   'message-composer:compose'         → 'message-composer'
 *   'unknown-source:v1'                → 'other'
 *   undefined                          → 'other'
 */
export function callerTagToPrefix(callerTag: string | undefined | null): CallerTagPrefix {
  if (!callerTag) return 'other';
  for (const prefix of SORTED_BY_LENGTH_DESC) {
    // Match either bare prefix or `<prefix>:<rest>` / `<prefix>-<rest>`.
    if (callerTag === prefix || callerTag.startsWith(`${prefix}:`) || callerTag.startsWith(`${prefix}-`)) {
      // Distinguish 'agentic' from 'agentic-tool' via the longest-match
      // ordering above. Sanity check: 'agentic-tool:foo' must NOT collapse
      // to 'agentic' just because the string contains the substring.
      if (prefix === 'agentic' && callerTag.startsWith('agentic-')) {
        // 'agentic-tool' should have been matched first; if we got here,
        // the tag is some 'agentic-other' — treat as 'agentic' since there's
        // no narrower bucket. Defensive — shouldn't occur in V1.
      }
      return prefix;
    }
  }
  return 'other';
}
