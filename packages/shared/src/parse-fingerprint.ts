/**
 * KAN-1140 Phase 3 PR 7 — Format signature derivation.
 *
 * Hoisted to @growth/shared (per Phase 2 Step 7 Senior PO lock) so the
 * webhook (apps/connectors), the lead-received-push consumer (apps/api),
 * and the reclassify service (packages/api) all hash against the same
 * algorithm. Algorithm drift across workspaces would silently corrupt
 * fingerprint dedup; single source of truth eliminates the class.
 *
 * Three hashes, all sha256 hex digest:
 *
 *   - structureHash    — format-specific tag-tree (HTML/ADF) OR sorted
 *                        label-token inventory (plain-text). Null on
 *                        'unknown' format.
 *   - senderDomainHash — sha256(normalized From-address). Always populated.
 *   - labelTokenHash   — plain-text label inventory ONLY. Null off
 *                        plain-text. On plain-text it EQUALS structureHash
 *                        — surfaced as a separate column so operators can
 *                        query the "same label set" view independently.
 *
 * # Algorithm determinism
 *
 * The hash inputs MUST be byte-stable across machine, runtime, and time
 * to preserve fingerprint dedup. Stability discipline:
 *
 *   - Tag names lowercased
 *   - Attribute names sorted alphabetically (case-sensitive sort matches
 *     Unicode code-point order; deterministic across JS engines)
 *   - Attribute values + text content + comments + processing
 *     instructions stripped entirely
 *   - Label-token inventory sorted alphabetically and joined with `|`
 *
 * # Tag-tree extraction (regex-based, NO cheerio)
 *
 * Cheerio drag adds ~280KB to packages/shared for one helper. Regex
 * extraction is sufficient for the hashing purpose (we don't care about
 * malformed HTML or text content — only tag-attribute structure). The
 * regex tokenizes opening tags + extracts tag name + attribute names;
 * everything else gets dropped. This is byte-stable and faster than
 * cheerio parse + walk.
 *
 * # Sender domain normalization
 *
 * Lowercase email; strip `+suffix` from local part; preserve full
 * `local@domain` form (NOT just domain) so e.g.
 * `noreply+abc@formspree.io` and `noreply+xyz@formspree.io` collapse
 * to the same fingerprint while `support@formspree.io` does not.
 */
import { createHash } from "crypto";

export type DetectedFormat = "adf" | "html" | "html-in-text" | "plain-text" | "unknown";

export interface ParseFingerprintHashes {
  structureHash: string | null;
  senderDomainHash: string;
  labelTokenHash: string | null;
}

export interface DeriveParseFingerprintInput {
  format: DetectedFormat;
  body: string;
  fromAddress: string;
}

function sha256(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * Strip `+suffix` from local part; lowercase both halves; preserve the
 * `local@domain` shape (NOT just domain). Treats malformed input
 * (no `@`) as a single token.
 */
export function normalizeSenderAddress(fromAddress: string): string {
  const at = fromAddress.lastIndexOf("@");
  if (at < 0) return fromAddress.toLowerCase();
  const local = fromAddress.slice(0, at).toLowerCase().split("+")[0];
  const domain = fromAddress.slice(at + 1).toLowerCase();
  return `${local}@${domain}`;
}

/**
 * Extract opening tags + their attribute-name lists from HTML/XML body
 * via regex. Returns a canonical string form: each tag becomes
 * `tagname[attr1,attr2,attr3]` and they're joined with `|`. Closing
 * tags are skipped; attribute VALUES are skipped; text content is
 * skipped; comments + CDATA + processing instructions are skipped.
 *
 * Output is byte-stable across engines for the same input.
 */
export function extractTagTreeForHash(body: string): string {
  // Skip processing instructions, comments, CDATA
  const stripped = body
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "");
  // Match opening + self-closing tags (skip closing tags via leading "/")
  const tagRe = /<([a-zA-Z][a-zA-Z0-9:-]*)(\s[^>]*)?\/?>/g;
  // Match attribute names inside the tag's attr section
  const attrNameRe = /([a-zA-Z_][a-zA-Z0-9_:-]*)\s*=/g;
  const tokens: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(stripped)) !== null) {
    const tagName = m[1].toLowerCase();
    const attrSection = m[2] ?? "";
    const attrNames: string[] = [];
    let am: RegExpExecArray | null;
    while ((am = attrNameRe.exec(attrSection)) !== null) {
      attrNames.push(am[1].toLowerCase());
    }
    attrNameRe.lastIndex = 0;
    attrNames.sort();
    tokens.push(`${tagName}[${attrNames.join(",")}]`);
  }
  return tokens.join("|");
}

/**
 * Extract sorted label-token inventory from a plain-text body. Pattern
 * matches `^Label:` lines (whitespace, hyphens, underscores allowed in
 * the label); duplicates collapse to a single token; result is sorted
 * alphabetically and joined with `|`.
 *
 * Examples:
 *   `Name: Alice\nEmail: a@b.c` → ["Email", "Name"] → "Email|Name"
 *   `name: x\nName: y` → ["Name", "name"] (case-sensitive — captures
 *                       per-form casing convention)
 */
export function extractLabelTokens(body: string): string[] {
  const labels = new Set<string>();
  for (const line of body.split("\n")) {
    const m = line.match(/^([A-Za-z][\w \-]*):/);
    if (m) labels.add(m[1].trim());
  }
  return Array.from(labels).sort();
}

/**
 * KAN-1140 Phase 3 PR 8 — Auto-suggest predicate.
 *
 * Hoisted to @growth/shared per Memo 37 (cross-workspace algorithm hoist
 * eliminates byte-stability drift class). Three call sites need to agree
 * on this predicate byte-for-byte:
 *
 *   1. apps/connectors/src/app.ts — webhook hook runs the predicate
 *      after every UPSERT to evaluate auto-promotion pending → suggested
 *   2. apps/api/src/__tests__/integration/parse-fingerprint-write-path.test.ts
 *      — integration test helper mirrors production 1:1 against real
 *      Postgres so regressions surface as failures
 *   3. (Future) KAN-1147 cron poller — may re-evaluate the predicate on
 *      a schedule independent of inbound write traffic
 *
 * If the predicate drifted across these sites, fingerprint promotion
 * semantics would diverge silently. Single source of truth eliminates
 * the class.
 *
 * Q3 lock (KAN-1140 PR 8 Phase 1):
 *   - pending AND (count >= 5 AND format_confidence = 'high') → suggest
 *   - pending AND reclassify_count >= 1 → suggest
 *   - any other state → no-op (Q-ADD-2 lock: gate on === 'pending',
 *     NOT !== 'supported', to defend against re-suggesting `unsupported`)
 */
export interface AutoSuggestInput {
  supportStatus: string;
  occurrenceCount: number;
  formatConfidence: string;
  reclassifyCount: number;
}

export function shouldAutoSuggest(row: AutoSuggestInput): boolean {
  return (
    row.supportStatus === "pending" &&
    ((row.occurrenceCount >= 5 && row.formatConfidence === "high") ||
      row.reclassifyCount >= 1)
  );
}

/**
 * Derive the layered hash trio for an inbound. See file-level comment
 * for algorithm details. `format` MUST be the format-detector's output
 * (NOT operator-corrected — fingerprints capture wire reality).
 */
export function deriveParseFingerprint(
  input: DeriveParseFingerprintInput,
): ParseFingerprintHashes {
  const senderDomainHash = sha256(normalizeSenderAddress(input.fromAddress));
  let structureHash: string | null = null;
  let labelTokenHash: string | null = null;

  if (input.format === "html" || input.format === "html-in-text" || input.format === "adf") {
    structureHash = sha256(extractTagTreeForHash(input.body));
  } else if (input.format === "plain-text") {
    const labels = extractLabelTokens(input.body);
    labelTokenHash = sha256(labels.join("|"));
    // plain-text "structure" IS the label inventory — surface both as
    // equal so dedup and label-only queries agree.
    structureHash = labelTokenHash;
  }
  // 'unknown' → both structureHash and labelTokenHash stay null

  return { structureHash, senderDomainHash, labelTokenHash };
}
