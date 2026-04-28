/**
 * Generalized enum-drift prevention test for the schema.prisma ↔ apps/api
 * zod-mirror pair list.
 *
 * Replaces objective-type-drift.test.ts (PR #53), which was scoped to a single
 * enum and missed 3 in-flight drift instances (TargetMetric, TargetPeriod,
 * KnowledgeCategory) — surfaced in PR #54's audit.
 *
 * RCA documented in memory: feedback_class_fix_not_instance_fix.md.
 *
 * Pattern:
 *   - PAIRS is the explicit list of every Prisma enum + its zod mirror
 *   - Adding a new Prisma enum FORCES the next person to add a PAIRS entry
 *     (the list itself is the tripwire)
 *   - Each pair becomes its own test case for failure-isolation clarity
 *
 * The frontend ↔ backend bridge is NOT tested here (apps/web can't import
 * apps/api due to KAN-689 cross-rootDir cascade). KAN-719 (High, Sprint 2)
 * extracts shared types to close that gap.
 */
import { describe, it, expect } from 'vitest';
import {
  ObjectiveType,
  TargetMetric,
  TargetPeriod,
  KnowledgeCategory,
  LeadAssignmentPosture,
  KnowledgeSourceType,
  KnowledgeSourceStatus,
} from '@prisma/client';

interface EnumPair {
  name: string;
  prismaValues: readonly string[];
  zodImport: () => Promise<readonly string[]>;
}

// Each Prisma enum that has a zod mirror in apps/api/src/router.ts. Add new
// pairs here when introducing a new Prisma enum + its zod input. Drift in any
// pair fails its own assertion (good failure-isolation).
const PAIRS: EnumPair[] = [
  {
    name: 'ObjectiveType',
    prismaValues: Object.values(ObjectiveType),
    zodImport: async () => (await import('../router.js')).ObjectiveTypeEnum.options,
  },
  {
    name: 'TargetMetric',
    prismaValues: Object.values(TargetMetric),
    zodImport: async () => (await import('../router.js')).TargetMetricEnum.options,
  },
  {
    name: 'TargetPeriod',
    prismaValues: Object.values(TargetPeriod),
    zodImport: async () => (await import('../router.js')).TargetPeriodEnum.options,
  },
  {
    name: 'KnowledgeCategory',
    prismaValues: Object.values(KnowledgeCategory),
    zodImport: async () => (await import('../router.js')).KnowledgeCategoryEnum.options,
  },
  {
    name: 'LeadAssignmentPosture',
    prismaValues: Object.values(LeadAssignmentPosture),
    zodImport: async () => (await import('../router.js')).LeadAssignmentPostureEnum.options,
  },
  {
    name: 'KnowledgeSourceType',
    prismaValues: Object.values(KnowledgeSourceType),
    zodImport: async () => (await import('../router.js')).KnowledgeSourceTypeEnum.options,
  },
  {
    name: 'KnowledgeSourceStatus',
    prismaValues: Object.values(KnowledgeSourceStatus),
    zodImport: async () => (await import('../router.js')).KnowledgeSourceStatusEnum.options,
  },
];

describe('enum drift (schema.prisma ↔ apps/api zod mirrors)', () => {
  for (const pair of PAIRS) {
    it(`${pair.name}: zod mirror options exactly match Prisma enum values`, async () => {
      const zodValues = [...(await pair.zodImport())].sort();
      const prismaValues = [...pair.prismaValues].sort();
      expect(zodValues).toEqual(prismaValues);
    });
  }
});
