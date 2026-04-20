/**
 * SendGrid Domain Authentication — generates DKIM/SPF CNAME records
 * and validates them against the tenant's DNS.
 *
 * Flow:
 *   1. POST /v3/whitelabel/domains      → SendGrid returns 3 CNAME records
 *   2. Render records in the DNS wizard UI (KAN-596)
 *   3. Tenant adds records to their DNS
 *   4. POST /v3/whitelabel/domains/{id}/validate → SendGrid checks + flips verified flag
 *   5. Connection transitions PENDING → ACTIVE on successful validation
 *
 * KAN-593: Call Domain Authentication API, persist records
 * KAN-594: DMARC policy recommendation
 * KAN-595: Verify endpoint + status caching
 */

import { getMasterSendGridClient } from './client.js';
import { logger } from '../../logger.js';

export interface DomainAuthRecord {
  type: 'CNAME' | 'TXT';
  host: string;
  value: string;
  valid?: boolean;
}

export interface DomainAuthOutput {
  domainId: number;
  records: DomainAuthRecord[];
  dmarcSuggestion: string;
  valid: boolean;
}

/** Request Domain Authentication for a sending domain on the tenant's subuser. */
export async function requestDomainAuth(
  subuserUsername: string,
  domain: string,
): Promise<DomainAuthOutput> {
  const client = await getMasterSendGridClient();
  const log = logger.child({ subuserUsername, domain });

  const [res] = await client.request({
    method: 'POST',
    url: '/v3/whitelabel/domains',
    headers: { 'On-Behalf-Of': subuserUsername },
    body: {
      domain,
      subdomain: 'mail', // CNAME hosts at mail.{domain}
      automatic_security: true, // SendGrid manages the DKIM rotation
      default: true,
    },
  });

  const body = res.body as {
    id: number;
    dns: Record<string, { type: string; host: string; data: string; valid?: boolean }>;
    valid?: boolean;
  };

  const records: DomainAuthRecord[] = Object.values(body.dns).map((r) => ({
    type: r.type.toUpperCase() as 'CNAME' | 'TXT',
    host: r.host,
    value: r.data,
    valid: r.valid,
  }));

  log.info({ domainId: body.id, recordCount: records.length }, 'domain auth requested');

  return {
    domainId: body.id,
    records,
    dmarcSuggestion: buildDmarcSuggestion(domain),
    valid: body.valid ?? false,
  };
}

/** Trigger SendGrid to re-check DNS. Should be debounced from the UI (30s). */
export async function validateDomainAuth(
  subuserUsername: string,
  domainId: number,
): Promise<{ valid: boolean; records: DomainAuthRecord[] }> {
  const client = await getMasterSendGridClient();
  const [res] = await client.request({
    method: 'POST',
    url: `/v3/whitelabel/domains/${domainId}/validate`,
    headers: { 'On-Behalf-Of': subuserUsername },
  });
  const body = res.body as {
    valid: boolean;
    validation_results: Record<string, { valid: boolean; reason?: string }>;
  };

  const records: DomainAuthRecord[] = Object.entries(body.validation_results ?? {}).map(
    ([_k, v]) => ({
      type: 'CNAME',
      host: '',
      value: '',
      valid: v.valid,
    }),
  );

  return { valid: body.valid, records };
}

/**
 * Build a suggested DMARC record for the tenant's domain.
 * Quarantine policy with aggregated reports to compliance@axisone.ca —
 * safe default that doesn't break delivery but starts visibility.
 */
function buildDmarcSuggestion(domain: string): string {
  return (
    `_dmarc.${domain} TXT ` +
    `"v=DMARC1; p=quarantine; rua=mailto:dmarc-reports@axisone.ca; ` +
    `ruf=mailto:dmarc-reports@axisone.ca; fo=1; aspf=s; adkim=s"`
  );
}
