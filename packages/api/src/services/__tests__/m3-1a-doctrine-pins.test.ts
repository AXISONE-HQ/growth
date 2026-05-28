/**
 * M3-1a — doctrine pins.
 *
 * "Configuration is a failure mode" + "AI proposes, human validates" +
 * "Strategy replaces workflow" + "Action-type taxonomy stays clean":
 *
 *   - No tenant config UI route under /settings/sub-objectives, /settings/
 *     discovery, /settings/gap-state. Defaults work at zero-setup; future
 *     variation is Blueprint payloads, not config screens.
 *   - SubObjectiveSource enum has 4 sources (decision_initialize, manual,
 *     extraction, enrichment) — manual is one of four, NOT the primary
 *     fill path. Engine generates discovery actions; manual is operator
 *     fallback for off-platform info.
 *   - No new action type added to ActionType enum — discovery dispatches
 *     via existing send_message. M2-3 high-stakes clamp + aiPermissions
 *     surface stays clean (no new entries needed).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { resolve } from 'path';

// Repo root: this test file is at packages/api/src/services/__tests__/<file>.test.ts
// → REPO_ROOT is 5 levels up.
const REPO_ROOT = resolve(__dirname, '../../../../../');

describe('M3-1a doctrine pin — no config UI for sub-objectives', () => {
  it('no /settings/sub-objectives or /settings/discovery or /settings/gap-state route exists', () => {
    const settingsDir = resolve(REPO_ROOT, 'apps/web/src/app/settings');
    if (!existsSync(settingsDir)) return; // settings dir absent → no config UI by construction
    const entries = readdirSync(settingsDir);
    const banned = entries.filter((e) =>
      ['sub-objectives', 'sub_objectives', 'discovery', 'gap-state', 'gap_state'].includes(e.toLowerCase()),
    );
    expect(banned).toEqual([]);
  });
});

describe('M3-1a doctrine pin — SubObjectiveSource has 4 entries (manual NOT alone)', () => {
  it('all 4 sources exist in the shared schema (decision_initialize, manual, extraction, enrichment)', () => {
    const sharedTypes = readFileSync(
      resolve(REPO_ROOT, 'packages/shared/src/sub-objective-types.ts'),
      'utf-8',
    );
    expect(sharedTypes).toMatch(/'decision_initialize'/);
    expect(sharedTypes).toMatch(/'manual'/);
    expect(sharedTypes).toMatch(/'extraction'/);
    expect(sharedTypes).toMatch(/'enrichment'/);
  });

  it('Prisma enum has same 4 sources', () => {
    const schema = readFileSync(resolve(REPO_ROOT, 'packages/db/prisma/schema.prisma'), 'utf-8');
    const enumBlock = schema.match(/enum SubObjectiveSource \{([\s\S]*?)\}/);
    expect(enumBlock).not.toBeNull();
    const body = enumBlock![1];
    expect(body).toMatch(/decision_initialize/);
    expect(body).toMatch(/manual/);
    expect(body).toMatch(/extraction/);
    expect(body).toMatch(/enrichment/);
  });
});

describe('M3-1a doctrine pin — no new ActionType added (discovery uses send_message)', () => {
  it('ActionType enum unchanged: 7 entries (send_message, schedule_follow_up, escalate_human, book_meeting, update_crm, close_objective, wait)', () => {
    const determiner = readFileSync(
      resolve(REPO_ROOT, 'packages/api/src/services/action-determiner.ts'),
      'utf-8',
    );
    const enumBlock = determiner.match(/export const ActionType = z\.enum\(\[([\s\S]*?)\]\)/);
    expect(enumBlock).not.toBeNull();
    const entries = enumBlock![1].match(/'[a-z_]+'/g) ?? [];
    expect(entries.length).toBe(7);
    expect(entries).toEqual(
      expect.arrayContaining([
        "'send_message'",
        "'schedule_follow_up'",
        "'escalate_human'",
        "'book_meeting'",
        "'update_crm'",
        "'close_objective'",
        "'wait'",
      ]),
    );
    // Specifically no 'discovery' / 'ask' / 'discover' type.
    expect(entries.every((e) => !/discov|ask/i.test(e))).toBe(true);
  });

  it('HIGH_STAKES_ACTION_TYPES is unchanged — no discovery entry added (clamp surface stays clean)', () => {
    const threshold = readFileSync(
      resolve(REPO_ROOT, 'packages/api/src/services/threshold-gate.ts'),
      'utf-8',
    );
    // discovery is not high-stakes; the entry should not appear in the clamp.
    expect(threshold).not.toMatch(/'discovery'/);
    expect(threshold).not.toMatch(/discovery_target/);
  });
});

describe('M3-1a doctrine pin — sub_objective_key is FREE-FORM text (not enum) in the DB', () => {
  it('schema.prisma: sub_objective_key is String, NOT a custom Prisma enum', () => {
    const schema = readFileSync(resolve(REPO_ROOT, 'packages/db/prisma/schema.prisma'), 'utf-8');
    // The field must be `String @map("sub_objective_key")` — no enum reference.
    // This guarantees future Blueprint loaders can ship per-vertical sub-objective
    // sets without an enum widening migration.
    expect(schema).toMatch(/subObjectiveKey\s+String\s+@map\("sub_objective_key"\)/);
    // No enum named SubObjectiveKey exists.
    expect(schema).not.toMatch(/enum SubObjectiveKey/);
  });
});
