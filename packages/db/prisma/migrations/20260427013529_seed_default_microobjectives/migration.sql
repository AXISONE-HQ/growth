-- KAN-701: 5 platform-default MicroObjectives.
--
-- tenant_id is NULL = platform default (visible to every tenant). Tenant
-- onboarding clones these into per-tenant rows so customizations don't
-- mutate the platform defaults.
--
-- Idempotent via fixed UUIDs + ON CONFLICT (id) DO NOTHING. Re-running
-- this migration (or running the backfill script) is safe.
--
-- The completion_criteria JSON shape is documented in the seed module
-- packages/db/prisma/seeds/micro-objectives.ts. Sprint 3-4 agentic loop
-- will evaluate these criteria via LLM (intent / buying_timeframe /
-- competitor_mentioned types). The 'any_reply_received' + 'fields_present'
-- types are evaluable today by deterministic rules.

INSERT INTO micro_objectives (id, tenant_id, name, description, completion_criteria, is_default, "order", created_at, updated_at)
VALUES
  ('8df2c0d3-0001-4001-8001-000000000001', NULL, 'Consumer engagement',
   'Has the recipient replied to any message?',
   '{"type":"any_reply_received","lookback_days":30}'::jsonb,
   true, 1, NOW(), NOW()),
  ('8df2c0d3-0001-4001-8001-000000000002', NULL, 'Have all relevant contact info',
   'Name, email, phone, company, role',
   '{"type":"fields_present","fields":["firstName","lastName","email","phone","companyName","jobTitle"],"threshold":5}'::jsonb,
   true, 2, NOW(), NOW()),
  ('8df2c0d3-0001-4001-8001-000000000003', NULL, 'Understand what they''re trying to accomplish',
   'The use case / pain point',
   '{"type":"intent_extracted","min_confidence":0.7}'::jsonb,
   true, 3, NOW(), NOW()),
  ('8df2c0d3-0001-4001-8001-000000000004', NULL, 'Know when they want to buy',
   'Buying timeframe',
   '{"type":"buying_timeframe_extracted","min_confidence":0.6}'::jsonb,
   true, 4, NOW(), NOW()),
  ('8df2c0d3-0001-4001-8001-000000000005', NULL, 'Looking for similar products (competitors)',
   'Competitive awareness',
   '{"type":"competitor_mentioned","min_confidence":0.7}'::jsonb,
   true, 5, NOW(), NOW())
ON CONFLICT (id) DO NOTHING;
