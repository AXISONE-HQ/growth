/**
 * M3-2.5a — doctrine pins.
 *
 * Per the build prompt §"Doctrine pins":
 *   - No new config UI route under /settings/email or similar
 *   - provider is TEXT in schema, not Postgres enum (sub-objective-key
 *     precedent — enum-grow-by-migration is the trap we're avoiding)
 *   - engagement_email_metadata sidecar has NO tenant_id column
 *     (tenant scope flows transitively via engagement_id → engagement.
 *     tenant_id; sibling pattern: AccountProfile children)
 *   - KNOWN_EMAIL_PROVIDERS reference list includes 'resend'
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

const REPO_ROOT = resolve(__dirname, '../../../../../');

describe('M3-2.5a doctrine pin — no config UI for email providers', () => {
  it('no /settings/email or /settings/inbound or /settings/providers route exists', () => {
    const settingsDir = resolve(REPO_ROOT, 'apps/web/src/app/settings');
    if (!existsSync(settingsDir)) return;
    const entries = readdirSync(settingsDir);
    const banned = entries.filter((e) =>
      ['email', 'email-providers', 'inbound', 'providers', 'correlation'].includes(e.toLowerCase()),
    );
    expect(banned).toEqual([]);
  });
});

describe('M3-2.5a doctrine pin — provider is TEXT not enum', () => {
  it('schema.prisma EngagementEmailMetadata.provider is String, NOT a custom Prisma enum', () => {
    const schema = readFileSync(resolve(REPO_ROOT, 'packages/db/prisma/schema.prisma'), 'utf-8');
    const modelMatch = schema.match(/model EngagementEmailMetadata \{([\s\S]*?)\n\}/);
    expect(modelMatch).not.toBeNull();
    const body = modelMatch![1];
    // Provider declared as `provider String` (no enum reference).
    expect(body).toMatch(/provider\s+String/);
    // Negative: no enum named EmailProvider exists in schema.
    expect(schema).not.toMatch(/enum EmailProvider /);
  });

  it('shared validator EmailProviderSchema accepts any non-empty string (reference, not gate)', () => {
    const sharedTypes = readFileSync(
      resolve(REPO_ROOT, 'packages/shared/src/email-providers.ts'),
      'utf-8',
    );
    // Validator declared as z.string().min(1) — soft validator.
    expect(sharedTypes).toMatch(/EmailProviderSchema\s*=\s*z\.string\(\)\.min\(1\)/);
  });
});

describe('M3-2.5a doctrine pin — sidecar has NO tenant_id column', () => {
  it('engagement_email_metadata DDL has no tenant_id column (scope flows via engagement_id FK)', () => {
    const schema = readFileSync(resolve(REPO_ROOT, 'packages/db/prisma/schema.prisma'), 'utf-8');
    const modelMatch = schema.match(/model EngagementEmailMetadata \{([\s\S]*?)\n\}/);
    expect(modelMatch).not.toBeNull();
    const body = modelMatch![1];
    expect(body).not.toMatch(/tenantId\s+String/);
    expect(body).not.toMatch(/tenant_id/);
  });

  it('migration.sql for the sidecar has no tenant_id column', () => {
    const migration = readFileSync(
      resolve(REPO_ROOT, 'packages/db/prisma/migrations/20260529133848_m3_2_5a_engagement_decision_id_and_email_metadata/migration.sql'),
      'utf-8',
    );
    // CREATE TABLE block must not declare tenant_id
    const createBlock = migration.match(/CREATE TABLE "engagement_email_metadata"[\s\S]*?\);/);
    expect(createBlock).not.toBeNull();
    expect(createBlock![0]).not.toMatch(/tenant_id/);
  });
});

describe('M3-2.5a doctrine pin — KNOWN_EMAIL_PROVIDERS includes resend (the live adapter)', () => {
  it('shared types KNOWN_EMAIL_PROVIDERS list contains resend', () => {
    const sharedTypes = readFileSync(
      resolve(REPO_ROOT, 'packages/shared/src/email-providers.ts'),
      'utf-8',
    );
    expect(sharedTypes).toMatch(/'resend'/);
  });
});
