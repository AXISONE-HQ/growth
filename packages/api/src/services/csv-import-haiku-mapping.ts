/**
 * KAN-734 — Haiku-powered column-to-schema mapping (extracted from csv-import.ts).
 *
 * Hosts: UNIFIED_SCHEMA_FIELDS, FieldMapping, runHaikuFieldMapping,
 * runFallbackMapping. Pulled out of csv-import.ts so the unit test for the
 * llm-client integration doesn't transitively load express/csv-parse/multer/
 * GCS at module-load time. csv-import.ts re-exports for back-compat.
 *
 * KAN-734: routed through llm-client (`tier: 'cheap'`, callerTag csv-import:column-mapping)
 * so the call emits an llm.call cost event with the right tenant attribution.
 * Behavior change: model upgraded from claude-3-haiku-20240307 (Mar 2024) to
 * claude-haiku-4-5-20251001 (Oct 2025) — same Haiku family. Smoke fixture in
 * __fixtures__/csv-import-baseline.csv.
 */
import { complete as llmComplete } from './llm-client.js';

// —— Unified Contact Schema (target fields) ———————————————

export const UNIFIED_SCHEMA_FIELDS = [
  { field: 'email', type: 'string', description: 'Email address' },
  { field: 'phone', type: 'string', description: 'Phone number (any format)' },
  { field: 'firstName', type: 'string', description: 'First name / given name' },
  { field: 'lastName', type: 'string', description: 'Last name / surname / family name' },
  { field: 'segment', type: 'string', description: 'Customer segment or category' },
  { field: 'lifecycleStage', type: 'string', description: 'Lifecycle stage (lead, prospect, customer, churned)' },
  { field: 'source', type: 'string', description: 'Lead source or acquisition channel' },
  { field: 'company', type: 'string', description: 'Company or organization name' },
  { field: 'title', type: 'string', description: 'Job title or role' },
  { field: 'city', type: 'string', description: 'City' },
  { field: 'state', type: 'string', description: 'State or province' },
  { field: 'country', type: 'string', description: 'Country' },
  { field: 'postalCode', type: 'string', description: 'Postal / ZIP code' },
  { field: 'website', type: 'string', description: 'Website URL' },
  { field: 'notes', type: 'string', description: 'Notes or comments' },
  { field: 'tags', type: 'string', description: 'Tags or labels (comma-separated)' },
  { field: 'externalId', type: 'string', description: 'External system ID' },
  { field: '_skip', type: 'special', description: 'Column should be ignored / not mapped' },
] as const;

export type UnifiedField = (typeof UNIFIED_SCHEMA_FIELDS)[number]['field'];

export interface FieldMapping {
  csvColumn: string;
  targetField: UnifiedField;
  confidence: number;
  sampleValues: string[];
  reasoning: string;
}

/**
 * Use Anthropic Haiku (via llm-client) to infer column-to-schema mappings.
 * Sends column headers + sample values → gets structured JSON response.
 */
export async function runHaikuFieldMapping(
  headers: string[],
  sampleRows: Record<string, string>[],
  tenantId: string,
): Promise<FieldMapping[]> {
  const schemaDescription = UNIFIED_SCHEMA_FIELDS.map(
    (f) => `  - ${f.field}: ${f.description} (${f.type})`,
  ).join('\n');

  const columnSamples = headers
    .map((header) => {
      const values = sampleRows.map((row) => row[header] || '').filter(Boolean);
      return `  - "${header}": [${values.map((v) => `"${v}"`).join(', ')}]`;
    })
    .join('\n');

  const prompt = `You are a data mapping assistant. Given CSV column headers with sample values, map each column to the most appropriate field in our unified contact schema.

## Unified Contact Schema Fields:
${schemaDescription}

## CSV Columns with Sample Values:
${columnSamples}

## Instructions:
- Map each CSV column to exactly ONE schema field, or "_skip" if no match.
- Consider column names, data patterns, and sample values.
- Provide a confidence score (0.0 to 1.0) for each mapping.
- Common patterns: "e-mail" → email, "fname" → firstName, "lname" → lastName, "tel" → phone, "zip" → postalCode.

## Response Format (JSON array):
[
  {
    "csvColumn": "column_name",
    "targetField": "schema_field",
    "confidence": 0.95,
    "reasoning": "brief explanation"
  }
]

Return ONLY the JSON array, no other text.`;

  try {
    const response = await llmComplete({
      tenantId,
      tier: 'cheap',
      userPrompt: prompt,
      maxTokens: 2048,
      callerTag: 'csv-import:column-mapping',
    });

    const jsonText = response.text.trim();
    const jsonMatch = jsonText.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      throw new Error('Could not extract JSON array from Haiku response');
    }

    const rawMappings = JSON.parse(jsonMatch[0]);

    const mappings: FieldMapping[] = rawMappings.map((m: any) => ({
      csvColumn: m.csvColumn,
      targetField: m.targetField || '_skip',
      confidence: Math.min(1, Math.max(0, Number(m.confidence) || 0)),
      sampleValues: sampleRows.map((row) => row[m.csvColumn] || '').filter(Boolean).slice(0, 3),
      reasoning: m.reasoning || '',
    }));

    const mappedColumns = new Set(mappings.map((m: FieldMapping) => m.csvColumn));
    for (const header of headers) {
      if (!mappedColumns.has(header)) {
        mappings.push({
          csvColumn: header,
          targetField: '_skip',
          confidence: 0,
          sampleValues: sampleRows.map((row) => row[header] || '').filter(Boolean).slice(0, 3),
          reasoning: 'No matching schema field found',
        });
      }
    }

    return mappings;
  } catch (error: any) {
    console.error('Haiku field mapping error:', error);
    return runFallbackMapping(headers, sampleRows);
  }
}

/**
 * Fallback heuristic mapping when Haiku is unavailable.
 * Uses simple keyword matching on column headers.
 */
export function runFallbackMapping(
  headers: string[],
  sampleRows: Record<string, string>[],
): FieldMapping[] {
  const heuristicMap: Record<string, UnifiedField> = {
    email: 'email',
    'e-mail': 'email',
    email_address: 'email',
    emailaddress: 'email',
    phone: 'phone',
    telephone: 'phone',
    tel: 'phone',
    mobile: 'phone',
    phone_number: 'phone',
    phonenumber: 'phone',
    cell: 'phone',
    first_name: 'firstName',
    firstname: 'firstName',
    'first name': 'firstName',
    fname: 'firstName',
    given_name: 'firstName',
    last_name: 'lastName',
    lastname: 'lastName',
    'last name': 'lastName',
    lname: 'lastName',
    family_name: 'lastName',
    surname: 'lastName',
    name: 'firstName',
    segment: 'segment',
    category: 'segment',
    group: 'segment',
    lifecycle_stage: 'lifecycleStage',
    lifecyclestage: 'lifecycleStage',
    stage: 'lifecycleStage',
    status: 'lifecycleStage',
    source: 'source',
    lead_source: 'source',
    leadsource: 'source',
    channel: 'source',
    company: 'company',
    organization: 'company',
    org: 'company',
    company_name: 'company',
    title: 'title',
    job_title: 'title',
    jobtitle: 'title',
    role: 'title',
    position: 'title',
    city: 'city',
    town: 'city',
    state: 'state',
    province: 'state',
    region: 'state',
    country: 'country',
    nation: 'country',
    postal_code: 'postalCode',
    postalcode: 'postalCode',
    zip: 'postalCode',
    zip_code: 'postalCode',
    zipcode: 'postalCode',
    website: 'website',
    url: 'website',
    web: 'website',
    notes: 'notes',
    comment: 'notes',
    comments: 'notes',
    description: 'notes',
    tags: 'tags',
    label: 'tags',
    labels: 'tags',
    external_id: 'externalId',
    externalid: 'externalId',
    id: 'externalId',
    customer_id: 'externalId',
  };

  return headers.map((header) => {
    const normalized = header.toLowerCase().trim().replace(/[\s\-]+/g, '_');
    const match = heuristicMap[normalized] || heuristicMap[header.toLowerCase().trim()];

    return {
      csvColumn: header,
      targetField: match || '_skip',
      confidence: match ? 0.7 : 0,
      sampleValues: sampleRows.map((row) => row[header] || '').filter(Boolean).slice(0, 3),
      reasoning: match
        ? `Heuristic match: "${header}" → ${match}`
        : 'No heuristic match found (fallback mode)',
    };
  });
}
