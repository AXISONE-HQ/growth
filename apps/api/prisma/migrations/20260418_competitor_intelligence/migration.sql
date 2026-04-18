-- Competitor Intelligence Module Migration
-- Adds competitors, battle cards, and news tables

-- Create enums
CREATE TYPE "CompetitorStatus" AS ENUM ('active', 'inactive', 'archived');
CREATE TYPE "NewsSentiment" AS ENUM ('positive', 'negative', 'neutral');

-- Competitors table
CREATE TABLE "Competitor" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "tenantId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "website" TEXT NOT NULL,
    "description" TEXT,
    "logoUrl" TEXT,
    "employeeCount" INTEGER,
    "customerCount" INTEGER,
    "annualRevenue" TEXT,
    "segment" TEXT,
    "status" "CompetitorStatus" NOT NULL DEFAULT 'active',
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "lastAnalyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Competitor_pkey" PRIMARY KEY ("id")
);

-- Competitor Battle Cards table
CREATE TABLE "CompetitorBattleCard" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competitorId" UUID NOT NULL,
    "overview" TEXT NOT NULL,
    "strengths" JSONB NOT NULL DEFAULT '[]',
    "weaknesses" JSONB NOT NULL DEFAULT '[]',
    "differentiators" JSONB NOT NULL DEFAULT '[]',
    "objections" JSONB NOT NULL DEFAULT '[]',
    "talkingPoints" JSONB NOT NULL DEFAULT '[]',
    "version" INTEGER NOT NULL DEFAULT 1,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CompetitorBattleCard_pkey" PRIMARY KEY ("id")
);

-- Competitor News table
CREATE TABLE "CompetitorNews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "competitorId" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "sentiment" "NewsSentiment" NOT NULL DEFAULT 'neutral',
    "relevanceScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompetitorNews_pkey" PRIMARY KEY ("id")
);

-- Unique constraints
CREATE UNIQUE INDEX "Competitor_tenantId_website_key" ON "Competitor"("tenantId", "website");

-- Indexes for Competitor
CREATE INDEX "Competitor_tenantId_idx" ON "Competitor"("tenantId");
CREATE INDEX "Competitor_status_idx" ON "Competitor"("status");
CREATE INDEX "Competitor_createdAt_idx" ON "Competitor"("createdAt");

-- Indexes for CompetitorBattleCard
CREATE INDEX "CompetitorBattleCard_competitorId_idx" ON "CompetitorBattleCard"("competitorId");
CREATE INDEX "CompetitorBattleCard_version_idx" ON "CompetitorBattleCard"("version");
CREATE INDEX "CompetitorBattleCard_createdAt_idx" ON "CompetitorBattleCard"("createdAt");

-- Indexes for CompetitorNews
CREATE INDEX "CompetitorNews_competitorId_idx" ON "CompetitorNews"("competitorId");
CREATE INDEX "CompetitorNews_sentiment_idx" ON "CompetitorNews"("sentiment");
CREATE INDEX "CompetitorNews_publishedAt_idx" ON "CompetitorNews"("publishedAt");
CREATE INDEX "CompetitorNews_createdAt_idx" ON "CompetitorNews"("createdAt");

-- Foreign keys
ALTER TABLE "Competitor" ADD CONSTRAINT "Competitor_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompetitorBattleCard" ADD CONSTRAINT "CompetitorBattleCard_competitorId_fkey"
    FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "CompetitorNews" ADD CONSTRAINT "CompetitorNews_competitorId_fkey"
    FOREIGN KEY ("competitorId") REFERENCES "Competitor"("id") ON DELETE CASCADE ON UPDATE CASCADE;
