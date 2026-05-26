-- KAN-1005 M2-2 — Send-policy on the engine dispatch path.
--
-- Two additive changes to `deferred_sends` so the same table can carry
-- both Lead Inbox defers (KAN-814) and engine-path defers (this PR):
--
--   1. ALTER COLUMN deal_id DROP NOT NULL
--      Engine-path defers may not have a Deal anchor (autonomous actions
--      can be objective-driven without a current Deal). Lead Inbox
--      writes still always carry a Deal — the relaxation is permissive
--      for the new writer without affecting the old one.
--
--   2. ADD COLUMN replay_via TEXT NOT NULL DEFAULT 'action_send'
--      Discriminator on the row so the cron evaluator switches
--      deterministically between the two replay paths:
--        - 'action_send'    → publishActionSend (Lead Inbox: message
--          shaped at T1, replayed verbatim; cron skips re-compose)
--        - 'action_decided' → publishActionDecided (engine: cron
--          re-publishes the ActionDecidedEvent so the full chain —
--          compose + guardrail + dispatch — reruns post-defer)
--      Default 'action_send' preserves back-compat for pre-M2-2 rows.
--
-- Migration shape: purely additive.
--   - DROP NOT NULL is a metadata-only change in PostgreSQL (no table
--     rewrite, no row scan).
--   - ADD COLUMN with constant DEFAULT is a metadata-only change in
--     PG 11+ (DEFAULT applied at read time for existing rows; no
--     backfill scan).
--   Both safe under concurrent writes; no advisory lock required.
--
-- Consumers:
--   - apps/api/src/subscribers/action-decided-push.ts (this PR — writes
--     defer rows with replay_via='action_decided')
--   - packages/api/src/services/deferred-send-evaluator.ts (this PR —
--     reads replay_via, switches publish path)
--   - apps/api/src/subscribers/lead-received-push.ts (unchanged on the
--     write side; default 'action_send' from the column covers it)

ALTER TABLE "deferred_sends" ALTER COLUMN "deal_id" DROP NOT NULL;

ALTER TABLE "deferred_sends" ADD COLUMN "replay_via" TEXT NOT NULL DEFAULT 'action_send';
