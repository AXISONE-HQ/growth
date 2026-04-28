/**
 * Generalized enum-drift prevention test for the schema.prisma ↔ @growth/shared
 * zod-mirror pair list.
 *
 * Relocated from apps/api/src/__tests__/enum-drift.test.ts as part of KAN-737:
 * canonical zod mirrors now live in @growth/shared/src/enums.ts so the
 * assertion belongs alongside the canonical types it guards.
 *
 * RCA documented in memory: feedback_class_fix_not_instance_fix.md.
 *
 * Pattern:
 *   - PAIRS is the explicit list of every Prisma enum + its zod mirror
 *   - Adding a new Prisma enum FORCES the next person to add a PAIRS entry
 *   - Each pair becomes its own test case for failure-isolation clarity
 */
import { describe, it, expect } from "vitest";
import {
  ObjectiveType,
  TargetMetric,
  TargetPeriod,
  KnowledgeCategory,
  LeadAssignmentPosture,
  KnowledgeSourceType,
  KnowledgeSourceStatus,
} from "@prisma/client";
import {
  ObjectiveTypeEnum,
  TargetMetricEnum,
  TargetPeriodEnum,
  KnowledgeCategoryEnum,
  LeadAssignmentPostureEnum,
  KnowledgeSourceTypeEnum,
  KnowledgeSourceStatusEnum,
} from "../enums.js";

interface EnumPair {
  name: string;
  prismaValues: readonly string[];
  zodValues: readonly string[];
}

const PAIRS: EnumPair[] = [
  {
    name: "ObjectiveType",
    prismaValues: Object.values(ObjectiveType),
    zodValues: ObjectiveTypeEnum.options,
  },
  {
    name: "TargetMetric",
    prismaValues: Object.values(TargetMetric),
    zodValues: TargetMetricEnum.options,
  },
  {
    name: "TargetPeriod",
    prismaValues: Object.values(TargetPeriod),
    zodValues: TargetPeriodEnum.options,
  },
  {
    name: "KnowledgeCategory",
    prismaValues: Object.values(KnowledgeCategory),
    zodValues: KnowledgeCategoryEnum.options,
  },
  {
    name: "LeadAssignmentPosture",
    prismaValues: Object.values(LeadAssignmentPosture),
    zodValues: LeadAssignmentPostureEnum.options,
  },
  {
    name: "KnowledgeSourceType",
    prismaValues: Object.values(KnowledgeSourceType),
    zodValues: KnowledgeSourceTypeEnum.options,
  },
  {
    name: "KnowledgeSourceStatus",
    prismaValues: Object.values(KnowledgeSourceStatus),
    zodValues: KnowledgeSourceStatusEnum.options,
  },
];

describe("enum drift (schema.prisma ↔ @growth/shared zod mirrors)", () => {
  for (const pair of PAIRS) {
    it(`${pair.name}: zod mirror options exactly match Prisma enum values`, () => {
      const zodValues = [...pair.zodValues].sort();
      const prismaValues = [...pair.prismaValues].sort();
      expect(zodValues).toEqual(prismaValues);
    });
  }
});
