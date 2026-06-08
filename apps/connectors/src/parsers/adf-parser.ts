/**
 * KAN-1140 Phase 1 PR 1 — ADF (Auto-lead Data Format) pre-parser.
 *
 * ADF 1.0 is the auto-dealer industry standard for inbound lead exchange.
 * Common shape:
 *
 *   <?xml version="1.0"?>
 *   <?ADF version="1.0"?>
 *   <adf>
 *     <prospect>
 *       <requestdate>2026-06-08T12:00:00-05:00</requestdate>
 *       <vehicle interest="buy" status="new">
 *         <year>2026</year><make>Toyota</make><model>Camry</model>
 *         <stock>STK-12345</stock>
 *       </vehicle>
 *       <customer>
 *         <contact>
 *           <name part="first">Alice</name>
 *           <name part="last">Buyer</name>
 *           <email>alice@example.com</email>
 *           <phone>+1-555-0142</phone>
 *         </contact>
 *       </customer>
 *       <vendor><contact><name>Springfield Toyota</name></contact></vendor>
 *       <provider><contact><name>AutoLeadNetwork</name></contact></provider>
 *     </prospect>
 *   </adf>
 *
 * Parsing strategy (Q3 disposition (b) tree-walk + best-effort):
 *   - Schema-strict XSD validation REJECTS too much (vendors extend freely);
 *     instead we tree-walk known tags + preserve unknown tags as customFields
 *     with `adf_extension_<tag>` prefix
 *   - Malformed XML returns null → webhook falls through to LLM extraction
 *     path (publish-with-low-confidence per KAN-1141 PR 0 doctrine)
 *
 * Library: `cheerio` with `xmlMode: true`. Cheerio is already used in
 * `apps/api/src/services/account-detect-html-fetcher.ts` for HTML traversal;
 * KAN-1140 Phase 1 PR 1 added it to `apps/connectors/package.json` since
 * the parsers live in this workspace. xmlMode disables HTML-specific
 * tag-self-closing rules — appropriate for ADF.
 *
 * Wire-event mapping (per Q6 disposition (c) defer schema):
 *   - vendor: 'adf'
 *   - leadType: 'auto_lead'
 *   - dealName: derived (e.g., "Auto lead — 2026 Toyota Camry — Alice Buyer")
 *   - customFields: { vehicle_year, vehicle_make, vehicle_model, vehicle_stock,
 *                     dealer_name, provider_name, request_date,
 *                     adf_extension_<unknown_tag>: ... }
 */
import { load as loadCheerio } from 'cheerio';

export interface AdfParseResult {
  senderEmail: string;
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  /** Pre-computed deal name suggestion for the consumer (Deal row's name). */
  dealNameSeed: string | null;
  /** Wire-schema-compatible customFields. Per-value stringify already done
   *  (Record<string, string>). */
  customFields: Record<string, string>;
  /** Forensic count of <prospect> entries — some ADF feeds batch. PR 0
   *  parses only the first prospect; surface the count for observability. */
  prospectCount: number;
}

export interface AdfParseInput {
  /** Raw email text body containing the ADF XML payload. */
  text: string;
}

/**
 * Parse an ADF XML payload. Returns null on malformed XML or missing
 * `<adf>` root. Tree-walks known fields; preserves unknown sibling tags
 * with `adf_extension_<tag>` prefix in customFields.
 *
 * Pure function — no I/O.
 */
export function parseAdfEmail(input: AdfParseInput): AdfParseResult | null {
  const xml = input.text?.trim();
  if (!xml || xml.length === 0) return null;

  let $: ReturnType<typeof loadCheerio>;
  try {
    $ = loadCheerio(xml, { xmlMode: true });
  } catch {
    return null;
  }

  const $adf = $('adf').first();
  if ($adf.length === 0) return null;

  const $prospects = $adf.find('prospect');
  if ($prospects.length === 0) return null;
  const $prospect = $prospects.first();

  // ── Customer contact (the lead's identity)
  const $contact = $prospect.find('customer > contact').first();
  const firstName = readNamePart($contact, 'first');
  const lastName = readNamePart($contact, 'last');
  // Fall back to full <name> with no part attr if first/last not present
  const fullName =
    !firstName && !lastName
      ? $contact.find('name').not('[part]').first().text().trim() || null
      : null;
  const senderEmail = ($contact.find('email').first().text() ?? '').trim().toLowerCase();
  const phone = ($contact.find('phone').first().text() ?? '').trim() || null;

  // Split fullName fallback into first/last if we landed there
  let derivedFirst = firstName;
  let derivedLast = lastName;
  if (fullName) {
    const parts = fullName.split(/\s+/);
    derivedFirst = parts[0] ?? null;
    derivedLast = parts.length > 1 ? parts.slice(1).join(' ') : null;
  }

  // ── Vehicle (auto-specific structured fields)
  const $vehicle = $prospect.find('vehicle').first();
  const vehicleYear = $vehicle.find('year').first().text().trim() || null;
  const vehicleMake = $vehicle.find('make').first().text().trim() || null;
  const vehicleModel = $vehicle.find('model').first().text().trim() || null;
  const vehicleStock = $vehicle.find('stock').first().text().trim() || null;
  const vehicleInterest = $vehicle.attr('interest') || null;
  const vehicleStatus = $vehicle.attr('status') || null;

  // ── Vendor / provider (dealer + lead-network attribution)
  const dealerName =
    $prospect.find('vendor > contact > name').first().text().trim() || null;
  const providerName =
    $prospect.find('provider > contact > name').first().text().trim() || null;

  // ── Request date
  const requestDate = $prospect.find('requestdate').first().text().trim() || null;

  // ── Build customFields (Record<string, string>)
  const customFields: Record<string, string> = {};
  if (vehicleYear) customFields.vehicle_year = vehicleYear;
  if (vehicleMake) customFields.vehicle_make = vehicleMake;
  if (vehicleModel) customFields.vehicle_model = vehicleModel;
  if (vehicleStock) customFields.vehicle_stock = vehicleStock;
  if (vehicleInterest) customFields.vehicle_interest = vehicleInterest;
  if (vehicleStatus) customFields.vehicle_status = vehicleStatus;
  if (dealerName) customFields.dealer_name = dealerName;
  if (providerName) customFields.provider_name = providerName;
  if (requestDate) customFields.request_date = requestDate;

  // ── Unknown sibling tags under <prospect> → adf_extension_<tag>
  // (Vendor extensions; preserved per Q3 disposition (b))
  const KNOWN_PROSPECT_CHILDREN = new Set([
    'requestdate',
    'vehicle',
    'customer',
    'vendor',
    'provider',
  ]);
  $prospect.children().each((_, el) => {
    const tag = (('tagName' in el ? el.tagName : (el as { name?: string }).name) || '').toLowerCase();
    if (!tag || KNOWN_PROSPECT_CHILDREN.has(tag)) return;
    const value = $(el).text().trim();
    if (value) customFields[`adf_extension_${tag}`] = value;
  });

  // ── Build dealNameSeed
  const vehicleDescriptor = [vehicleYear, vehicleMake, vehicleModel]
    .filter(Boolean)
    .join(' ');
  const buyerName = [derivedFirst, derivedLast].filter(Boolean).join(' ').trim();
  const dealNameSeed = vehicleDescriptor
    ? buyerName
      ? `Auto lead — ${vehicleDescriptor} — ${buyerName}`
      : `Auto lead — ${vehicleDescriptor}`
    : buyerName
      ? `Auto lead — ${buyerName}`
      : null;

  return {
    senderEmail,
    firstName: derivedFirst,
    lastName: derivedLast,
    phone,
    dealNameSeed,
    customFields,
    prospectCount: $prospects.length,
  };
}

function readNamePart(
  $contact: ReturnType<typeof loadCheerio> extends (...args: never[]) => infer R
    ? R
    : never,
  part: 'first' | 'last',
): string | null;
function readNamePart(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  $contact: any,
  part: 'first' | 'last',
): string | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const found = ($contact as any).find(`name[part="${part}"]`).first().text().trim();
  return found || null;
}

/**
 * Lightweight presence check used by the webhook handler to decide whether
 * to invoke `parseAdfEmail`. Mirrors `isFormspreeSource` precedent
 * (single-predicate dispatcher seam).
 *
 * Returns true when the input text starts with an XML/ADF prolog or
 * contains an `<adf>` root tag. Cheaper than running the full parser
 * for negative cases.
 */
export function isAdfPayload(text: string | null | undefined): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  return (
    /^\s*<\?xml\b/i.test(trimmed) ||
    /^\s*<\?ADF\b/i.test(trimmed) ||
    /<adf\b/i.test(trimmed)
  );
}
