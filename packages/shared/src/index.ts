export * from "./enums.js";
export * from "./knowledge-ingest.js";
// KAN-827 — Sprint 11a ingestion pipeline schemas. Exports take precedence
// over the legacy KAN-707 `knowledge-ingest.js` module (which only exports
// orphaned types after KAN-826 dropped the consumers). Legacy module
// decommissioned by KAN-841 follow-up.
export * from "./knowledge-source-ingest.js";
export * from "./knowledge-validation.js";
export * from "./decision-payload.js";
// KAN-1005 M2-4 follow-up — canonical run-decision input types.
// Single source of truth for RunForContactInput + BreakerStateInput +
// PlaybookStepContext so the apps/api dynamic-import boundary can't
// silently drop fields (the M2-4 breaker plumbing was a sibling of the
// cast-loose Prisma + synthetic decisionId drift class).
export * from "./run-decision-types.js";
// M3-1 Sub-Objective Framework MVP — single source of truth for gap-state types + Generic-B2B default set + score-scale constants.
export * from "./sub-objective-types.js";
// KAN-1064 (Cluster II PR II) — EnginePhase canonical types + DEFAULT_ENGINE_PHASES_GENERIC_B2B.
// Shared so packages/api (resolveEnginePhases + computeCurrentEnginePhase + brain-eval rendering) and
// apps/* (operator UI surfaces for phase focus — Cluster III/IV downstream consumers) consume one source.
export * from "./engine-phase-types.js";
// KAN-1080 (Cluster III PR I) — EnginePhase → PipelineStage mapping types +
// empty DEFAULT_ENGINE_PHASE_STAGE_MAP_GENERIC_B2B (per Phase 1.5 audit:
// PROD stage naming too idiosyncratic for useful Blueprint defaults).
export * from "./engine-phase-stage-map-types.js";
// KAN-1093 (Cluster IV-B PR I) — Persona canonical types + DEFAULT_PERSONA_GENERIC_B2B
// (empty toneDefaults + brandAttributes + voiceExamples per discipline-pin-1; cognitive
// defaults stay unopinionated, populate per-tenant during onboarding).
export * from "./persona-types.js";
// KAN-1094 (Cluster IV-B PR II) — Scenario tuple registry types + DEFAULT_SCENARIOS_GENERIC_B2B
// (8 canonical tuples for send_follow_up × {4 phases} × {initial_inbound, reply} per Phase 1 Q5 lock).
// Other tuples (operator_initiated + no_touch_followup, or other actionTypes) fall back to composer
// free-form path until activated. Q2 (ii) lock: generic "concrete proof point" phrasing in PROOF
// scenarios until KAN-828 corpus seeded (KAN-1095 deferred-activation ticket).
export * from "./scenario-types.js";
// M3-2.5a Inbound Reply Correlation — known email providers + soft validator + sidecar shape.
export * from "./email-providers.js";
// M3-2.5b Inbound Reply Correlation — RFC 5322 Message-ID/References normalization, shared between webhook publish + consumer lookup.
export * from "./email-headers.js";
// KAN-1140 Phase 3 PR 7 — parse-fingerprint hash derivation, shared
// between webhook capture (apps/connectors), consumer escalation hook
// (apps/api), and reclassify service (packages/api). Hoist to shared
// eliminates algorithm-drift risk across workspaces (single source of
// truth for the dedup hash).
export * from "./parse-fingerprint.js";
export * from "./agentic-tool-schemas.js";
export * from "./action-types.js";
export * from "./lead-received.js";
// KAN-1037-PR3 — M3-2.5c contact.replied event contract. Shared between
// the publisher (lead-received-push.ts on inbound_correlated) and the
// PR3-skeleton subscriber (contact-replied-push.ts Redis-gated audit).
// PR4 wires real engine invocation; PR5 surfaces the reply panel UI.
export * from "./contact-replied.js";
export * from "./account-field-updated.js";
export * from "./account-validation.js";
// KAN-866 — canonical AuditLog payload contract for account.* events.
// Single source of truth for both Cohort 6 producer sites + the KAN-830
// AIActionCard consumer.
export * from "./account-audit-payload.js";
// KAN-913 — Cohort 2.7 commit fanout event. Topic constant + zod
// payload schema + builder. Publisher is env-gated (IMPORT_EVENTS_ENABLED).
export * from "./import-row-committed.js";
// KAN-959 — Objective Stack shared types (slice 1 of Objectives → AI Pipeline)
export * from "./objective-stack.js";
// KAN-962 — Objective + Pipeline proposer shared types (slice 2a)
export * from "./objective-proposal.js";
// KAN-997 — Campaign Layer Slice 1 — audience targeting jsonb shape +
// UTC-anchored relative-date util. Shared so the LLM extractor in
// packages/api/services/audience-router.ts + the count-side Prisma
// where-tree + any future renderer (Slice 2 preview card, etc.) all
// consume the same contract.
export * from "./audience-conditions.js";
export * from "./relative-dates.js";
// KAN-1000 — Campaign Layer Slice 2 — full proposal shape (audience +
// objective + strategy + stages + first-actions). Read-only — no
// Campaign DB model corresponds. Slice 3 wires persistence.
export * from "./campaign-proposal.js";
// KAN-1005 M2-5 — human-review sampling markers + DecisionSource
// discriminator. Shared between apps/api (sampling fork at
// action-decided-push.ts) and packages/api (recommendations.ts guard
// + queue filter). Single source of truth for SAMPLED_TRIGGER_TYPE.
export * from "./sampling-markers.js";
