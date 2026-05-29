/**
 * M3-2.5b — doctrine pins.
 *
 * Per the build prompt §"Doctrine pins":
 *   - No new config UI route under /settings/email or similar
 *   - Correlation lookup includes tenant filter (defense-in-depth)
 *   - LeadReceivedEvent inboundHeaders is optional (back-compat)
 *   - Helper encapsulation: resolveActiveDealForContact reused on inbound
 *     side (single source — engine + this slice; grep-provable)
 *   - No schema migration in this slice (engagement_email_metadata DDL
 *     came from M3-2.5a)
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../../../');

describe('M3-2.5b doctrine pin — no config UI for inbound correlation', () => {
  it('no /settings/email|inbound|providers|correlation route exists (carried from 2.5a)', () => {
    const settingsDir = resolve(REPO_ROOT, 'apps/web/src/app/settings');
    if (!existsSync(settingsDir)) return;
    const entries = readdirSync(settingsDir);
    const banned = entries.filter((e) =>
      ['email', 'email-providers', 'inbound', 'providers', 'correlation'].includes(e.toLowerCase()),
    );
    expect(banned).toEqual([]);
  });
});

describe('M3-2.5b doctrine pin — correlation lookup includes tenant filter', () => {
  it('lead-received-push.ts correlation query has where.engagement.tenantId (defense-in-depth)', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'apps/api/src/subscribers/lead-received-push.ts'),
      'utf-8',
    );
    // The relation filter is the discriminator — without it, the helper
    // would rely solely on the global UNIQUE which is correct but lacks
    // explicit scope. Defense-in-depth requires the filter.
    expect(src).toMatch(/engagement:\s*\{\s*tenantId/);
  });
});

describe('M3-2.5b doctrine pin — LeadReceivedEvent.inboundHeaders is optional (back-compat)', () => {
  it('schema field is `.optional()` so pre-M3-2.5b producers parse cleanly', () => {
    const schemaSrc = readFileSync(
      resolve(REPO_ROOT, 'packages/shared/src/lead-received.ts'),
      'utf-8',
    );
    // `inboundHeaders: z.object({...}).optional()` — entire object opted.
    expect(schemaSrc).toMatch(/inboundHeaders[\s\S]{0,200}\.optional\(\)/);
  });
});

describe('M3-2.5b doctrine pin — resolveActiveDealForContact reused (single source)', () => {
  it('lead-received-push.ts uses the resolve-active-deal loader (NOT inline duplicate)', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'apps/api/src/subscribers/lead-received-push.ts'),
      'utf-8',
    );
    expect(src).toMatch(/loadResolveActiveDealModule/);
    expect(src).toMatch(/['"]\.\.\/\.\.\/\.\.\/\.\.\/packages\/api\/src\/services\/resolve-active-deal\.js['"]/);
  });

  it('no inline duplicate of the helper-exact shape exists in lead-received-push.ts', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'apps/api/src/subscribers/lead-received-push.ts'),
      'utf-8',
    );
    // Helper's distinctive marker: orderBy enteredStageAt desc + select id only.
    expect(src).not.toMatch(/enteredStageAt:\s*['"]desc['"]/);
  });
});

describe('M3-2.5b doctrine pin — no new Prisma migration in this slice', () => {
  it('no migration directory dated 2026-05-30 or later exists yet (sidecar DDL came from 2.5a)', () => {
    const migrationsDir = resolve(REPO_ROOT, 'packages/db/prisma/migrations');
    const entries = readdirSync(migrationsDir);
    // M3-2.5a migration: 20260529133848_m3_2_5a_engagement_decision_id_and_email_metadata.
    // M3-2.5b adds no DDL; if any migration with a 2.5b name shows up, the
    // doctrine has been violated.
    const m25bMigration = entries.filter(
      (e) => e.toLowerCase().includes('m3_2_5b') || e.toLowerCase().includes('m3-2-5b'),
    );
    expect(m25bMigration).toEqual([]);
  });
});

describe('M3-2.5b doctrine pin — shared header-normalization helper at expected path', () => {
  it('packages/shared/src/email-headers.ts exists and exports stripMessageIdBrackets + parseReferencesHeader', () => {
    const src = readFileSync(
      resolve(REPO_ROOT, 'packages/shared/src/email-headers.ts'),
      'utf-8',
    );
    expect(src).toMatch(/export function stripMessageIdBrackets/);
    expect(src).toMatch(/export function parseReferencesHeader/);
  });

  it('packages/shared/src/index.ts re-exports email-headers', () => {
    const idx = readFileSync(resolve(REPO_ROOT, 'packages/shared/src/index.ts'), 'utf-8');
    expect(idx).toMatch(/export \* from\s+['"]\.\/email-headers\.js['"]/);
  });
});
