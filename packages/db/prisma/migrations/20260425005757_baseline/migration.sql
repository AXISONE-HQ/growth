-- CreateEnum
CREATE TYPE "channel_type" AS ENUM ('SMS', 'EMAIL', 'MESSENGER', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "connection_status" AS ENUM ('PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'ERROR');

-- CreateTable
CREATE TABLE "tenants" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "plan_tier" TEXT NOT NULL DEFAULT 'free',
    "blueprint_id" TEXT,
    "ai_permissions" JSONB NOT NULL DEFAULT '{}',
    "confidence_threshold" INTEGER NOT NULL DEFAULT 70,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenants_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" TEXT NOT NULL DEFAULT 'member',
    "tenant_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blueprints" (
    "id" TEXT NOT NULL,
    "vertical" TEXT NOT NULL,
    "customer_model" JSONB NOT NULL,
    "journeys" JSONB NOT NULL,
    "strategy_templates" JSONB NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "blueprints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "brain_snapshots" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "company_truth" JSONB NOT NULL,
    "behavioral_model" JSONB NOT NULL,
    "outcome_model" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "brain_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "first_name" TEXT,
    "last_name" TEXT,
    "external_ids" JSONB NOT NULL DEFAULT '{}',
    "data_quality_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "segment" TEXT,
    "lifecycle_stage" TEXT NOT NULL DEFAULT 'new',
    "source" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contact_states" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "objective_id" TEXT NOT NULL,
    "sub_objectives" JSONB NOT NULL DEFAULT '[]',
    "strategy_current" TEXT,
    "confidence_score" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "contact_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "objectives" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "success_condition" JSONB NOT NULL,
    "sub_objectives" JSONB NOT NULL DEFAULT '[]',
    "blueprint_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "objectives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "decisions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "strategy_selected" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "confidence" DOUBLE PRECISION NOT NULL,
    "reasoning" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "actions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "decision_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "agent_type" TEXT NOT NULL,
    "channel" TEXT,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "sent_at" TIMESTAMP(3),
    "delivered_at" TIMESTAMP(3),
    "failed_at" TIMESTAMP(3),
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outcomes" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "objective_id" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "reason_category" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outcomes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_weights" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "strategy_type" TEXT NOT NULL,
    "segment" TEXT,
    "win_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sample_size" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "strategy_weights_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action_type" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "reasoning" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipelines" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "color" TEXT NOT NULL DEFAULT '#6366F1',
    "source_type" TEXT,
    "audience_conditions" JSONB NOT NULL DEFAULT '[]',
    "stages" JSONB NOT NULL DEFAULT '[]',
    "sales_target" DOUBLE PRECISION,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipelines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pipeline_cards" (
    "id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "deal_amount" DOUBLE PRECISION,
    "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "entered_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pipeline_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "plan" TEXT,
    "mrr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ltv" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "health_score" DOUBLE PRECISION NOT NULL DEFAULT 50,
    "status" TEXT NOT NULL DEFAULT 'active',
    "since" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "ai_tagged" BOOLEAN NOT NULL DEFAULT false,
    "last_message_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "escalations" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "contact_id" TEXT NOT NULL,
    "severity" TEXT NOT NULL DEFAULT 'medium',
    "trigger_type" TEXT NOT NULL,
    "trigger_reason" TEXT,
    "ai_suggestion" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "resolved_by" TEXT,
    "resolved_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "escalations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_base" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "fields" JSONB NOT NULL DEFAULT '{}',
    "ai_trained" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_base_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_agent_config" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "agent_name" TEXT NOT NULL DEFAULT 'AI Agent',
    "tone" TEXT NOT NULL DEFAULT 'professional',
    "writing_style" TEXT NOT NULL DEFAULT 'concise',
    "emoji_usage" BOOLEAN NOT NULL DEFAULT false,
    "language" TEXT NOT NULL DEFAULT 'en',
    "guardrails" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_agent_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_connections" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "channel_type" "channel_type" NOT NULL,
    "provider" TEXT NOT NULL,
    "provider_account_id" TEXT NOT NULL,
    "status" "connection_status" NOT NULL DEFAULT 'PENDING',
    "label" TEXT,
    "credentials_ref" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "compliance_status" JSONB,
    "connected_at" TIMESTAMP(3),
    "last_health_check" TIMESTAMP(3),
    "health_status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_connections_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_suppressions" (
    "id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tenants_slug_key" ON "tenants"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "users_tenant_id_idx" ON "users"("tenant_id");

-- CreateIndex
CREATE INDEX "brain_snapshots_tenant_id_idx" ON "brain_snapshots"("tenant_id");

-- CreateIndex
CREATE INDEX "brain_snapshots_tenant_id_version_idx" ON "brain_snapshots"("tenant_id", "version");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_idx" ON "contacts"("tenant_id");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_email_idx" ON "contacts"("tenant_id", "email");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_lifecycle_stage_idx" ON "contacts"("tenant_id", "lifecycle_stage");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_segment_idx" ON "contacts"("tenant_id", "segment");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_data_quality_score_idx" ON "contacts"("tenant_id", "data_quality_score");

-- CreateIndex
CREATE INDEX "contacts_tenant_id_source_idx" ON "contacts"("tenant_id", "source");

-- CreateIndex
CREATE INDEX "contact_states_tenant_id_idx" ON "contact_states"("tenant_id");

-- CreateIndex
CREATE INDEX "contact_states_contact_id_idx" ON "contact_states"("contact_id");

-- CreateIndex
CREATE UNIQUE INDEX "contact_states_contact_id_objective_id_key" ON "contact_states"("contact_id", "objective_id");

-- CreateIndex
CREATE INDEX "objectives_tenant_id_idx" ON "objectives"("tenant_id");

-- CreateIndex
CREATE INDEX "objectives_tenant_id_type_idx" ON "objectives"("tenant_id", "type");

-- CreateIndex
CREATE INDEX "decisions_tenant_id_idx" ON "decisions"("tenant_id");

-- CreateIndex
CREATE INDEX "decisions_tenant_id_contact_id_idx" ON "decisions"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "decisions_tenant_id_created_at_idx" ON "decisions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "actions_tenant_id_idx" ON "actions"("tenant_id");

-- CreateIndex
CREATE INDEX "actions_tenant_id_status_idx" ON "actions"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "actions_tenant_id_created_at_idx" ON "actions"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "actions_decision_id_idx" ON "actions"("decision_id");

-- CreateIndex
CREATE INDEX "outcomes_tenant_id_idx" ON "outcomes"("tenant_id");

-- CreateIndex
CREATE INDEX "outcomes_tenant_id_objective_id_idx" ON "outcomes"("tenant_id", "objective_id");

-- CreateIndex
CREATE INDEX "outcomes_tenant_id_result_idx" ON "outcomes"("tenant_id", "result");

-- CreateIndex
CREATE INDEX "strategy_weights_tenant_id_idx" ON "strategy_weights"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_weights_tenant_id_strategy_type_segment_key" ON "strategy_weights"("tenant_id", "strategy_type", "segment");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_idx" ON "audit_log"("tenant_id");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_action_type_idx" ON "audit_log"("tenant_id", "action_type");

-- CreateIndex
CREATE INDEX "audit_log_tenant_id_created_at_idx" ON "audit_log"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "pipelines_tenant_id_idx" ON "pipelines"("tenant_id");

-- CreateIndex
CREATE INDEX "pipeline_cards_pipeline_id_idx" ON "pipeline_cards"("pipeline_id");

-- CreateIndex
CREATE INDEX "pipeline_cards_contact_id_idx" ON "pipeline_cards"("contact_id");

-- CreateIndex
CREATE INDEX "pipeline_cards_pipeline_id_stage_idx" ON "pipeline_cards"("pipeline_id", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "customers_contact_id_key" ON "customers"("contact_id");

-- CreateIndex
CREATE INDEX "customers_tenant_id_idx" ON "customers"("tenant_id");

-- CreateIndex
CREATE INDEX "customers_tenant_id_status_idx" ON "customers"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "customers_tenant_id_health_score_idx" ON "customers"("tenant_id", "health_score");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_idx" ON "conversations"("tenant_id");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_contact_id_idx" ON "conversations"("tenant_id", "contact_id");

-- CreateIndex
CREATE INDEX "conversations_tenant_id_last_message_at_idx" ON "conversations"("tenant_id", "last_message_at");

-- CreateIndex
CREATE INDEX "escalations_tenant_id_idx" ON "escalations"("tenant_id");

-- CreateIndex
CREATE INDEX "escalations_tenant_id_status_idx" ON "escalations"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "escalations_tenant_id_severity_idx" ON "escalations"("tenant_id", "severity");

-- CreateIndex
CREATE INDEX "knowledge_base_tenant_id_idx" ON "knowledge_base"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_base_tenant_id_category_key" ON "knowledge_base"("tenant_id", "category");

-- CreateIndex
CREATE INDEX "ai_agent_config_tenant_id_idx" ON "ai_agent_config"("tenant_id");

-- CreateIndex
CREATE INDEX "channel_connections_tenant_id_idx" ON "channel_connections"("tenant_id");

-- CreateIndex
CREATE INDEX "channel_connections_tenant_id_status_idx" ON "channel_connections"("tenant_id", "status");

-- CreateIndex
CREATE INDEX "channel_connections_tenant_id_channel_type_idx" ON "channel_connections"("tenant_id", "channel_type");

-- CreateIndex
CREATE UNIQUE INDEX "channel_connections_tenant_id_channel_type_provider_account_key" ON "channel_connections"("tenant_id", "channel_type", "provider_account_id");

-- CreateIndex
CREATE INDEX "email_suppressions_tenant_id_idx" ON "email_suppressions"("tenant_id");

-- CreateIndex
CREATE UNIQUE INDEX "email_suppressions_tenant_id_email_key" ON "email_suppressions"("tenant_id", "email");

-- AddForeignKey
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brain_snapshots" ADD CONSTRAINT "brain_snapshots_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_states" ADD CONSTRAINT "contact_states_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_states" ADD CONSTRAINT "contact_states_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contact_states" ADD CONSTRAINT "contact_states_objective_id_fkey" FOREIGN KEY ("objective_id") REFERENCES "objectives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "objectives" ADD CONSTRAINT "objectives_blueprint_id_fkey" FOREIGN KEY ("blueprint_id") REFERENCES "blueprints"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_decision_id_fkey" FOREIGN KEY ("decision_id") REFERENCES "decisions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "actions" ADD CONSTRAINT "actions_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outcomes" ADD CONSTRAINT "outcomes_objective_id_fkey" FOREIGN KEY ("objective_id") REFERENCES "objectives"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_weights" ADD CONSTRAINT "strategy_weights_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipelines" ADD CONSTRAINT "pipelines_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_pipeline_id_fkey" FOREIGN KEY ("pipeline_id") REFERENCES "pipelines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pipeline_cards" ADD CONSTRAINT "pipeline_cards_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_resolved_by_fkey" FOREIGN KEY ("resolved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_base" ADD CONSTRAINT "knowledge_base_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ai_agent_config" ADD CONSTRAINT "ai_agent_config_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_connections" ADD CONSTRAINT "channel_connections_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

