-- AlterTable
ALTER TABLE "tenants" ADD COLUMN     "auto_approve_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "daily_action_limit" INTEGER NOT NULL DEFAULT 100,
ADD COLUMN     "guardrail_settings" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "strategy_permissions" JSONB NOT NULL DEFAULT '{}';

