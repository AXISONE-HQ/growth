/**
 * Blueprint Loader — Brain Service
 * KAN-28: Build Blueprint loader for generic B2B/B2C
 *
 * Provides:
 * - KAN-131: Blueprint JSON schema (TypeScript interfaces + Zod validation)
 * - KAN-132: Generic B2B/B2C Blueprint data file (industry-agnostic defaults)
 * - KAN-133: Blueprint loader at tenant creation (auto-load into brain_snapshots)
 *
 * The Blueprint is the foundational knowledge layer of the Business Brain.
 * It provides industry-agnostic customer models, buyer journeys, KPI definitions,
 * objection frameworks, revenue models, and strategy templates that every tenant
 * starts with. The Blueprint is READ-ONLY once loaded — tenant-specific learning
 * layers on top via Company Truth and Behavioral/Outcome models.
 */

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { randomUUID } from 'crypto';

const prisma = new PrismaClient();
const router = Router();

// ── KAN-131: Blueprint JSON Schema ─────────────────────────────────────────────

/**
 * Customer Model — defines the personas, segments, and ideal customer profiles
 * that the AI uses to understand WHO the tenant's customers are.
 */
const CustomerPersonaSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  demographics: z.object({
    role: z.string().optional(),
    industry: z.string().optional(),
    companySize: z.string().optional(),
    decisionLevel: z.enum(['individual', 'team', 'executive', 'c-suite']).optional(),
  }).optional(),
  painPoints: z.array(z.string()),
  goals: z.array(z.string()),
  preferredChannels: z.array(z.enum(['email', 'sms', 'whatsapp', 'phone', 'chat', 'social'])),
  buyingBehavior: z.object({
    researchStyle: z.enum(['self-service', 'guided', 'consultative', 'committee']).optional(),
    decisionSpeed: z.enum(['impulse', 'fast', 'moderate', 'slow', 'enterprise']).optional(),
    priceWeight: z.enum(['low', 'medium', 'high', 'dominant']).optional(),
  }).optional(),
});

const CustomerModelSchema = z.object({
  personas: z.array(CustomerPersonaSchema),
  segments: z.array(z.object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    criteria: z.record(z.string()).optional(),
    personaIds: z.array(z.string()),
  })),
  idealCustomerProfile: z.object({
    description: z.string(),
    qualifyingSignals: z.array(z.string()),
    disqualifyingSignals: z.array(z.string()),
  }).optional(),
});

/**
 * Buyer Journeys — defines the stages a contact moves through,
 * the triggers that advance them, and the actions appropriate at each stage.
 */
const JourneyStageSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  order: z.number(),
  entryConditions: z.array(z.string()),
  exitConditions: z.array(z.string()),
  typicalDuration: z.string().optional(),
  recommendedActions: z.array(z.string()),
  kpis: z.array(z.string()),
});

const BuyerJourneySchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum(['acquisition', 'retention', 'expansion', 'reactivation']),
  stages: z.array(JourneyStageSchema),
});

/**
 * KPI Definitions — the metrics the AI tracks and optimizes toward.
 */
const KpiDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  category: z.enum(['revenue', 'engagement', 'conversion', 'retention', 'efficiency', 'satisfaction']),
  calculationMethod: z.string(),
  unit: z.enum(['percentage', 'currency', 'count', 'ratio', 'days', 'score']),
  direction: z.enum(['higher_is_better', 'lower_is_better']),
  benchmarks: z.object({
    poor: z.number().optional(),
    average: z.number().optional(),
    good: z.number().optional(),
    excellent: z.number().optional(),
  }).optional(),
});

/**
 * Objection Framework — common objections and recommended handling strategies.
 */
const ObjectionSchema = z.object({
  id: z.string(),
  category: z.enum(['price', 'timing', 'need', 'trust', 'competition', 'authority', 'inertia']),
  objection: z.string(),
  severity: z.enum(['low', 'medium', 'high']),
  handlingStrategies: z.array(z.object({
    approach: z.string(),
    responseTemplate: z.string(),
    effectivenessScore: z.number().min(0).max(100).optional(),
  })),
});

/**
 * Revenue Models — how the tenant makes money, used by the AI to understand
 * which actions drive revenue.
 */
const RevenueModelSchema = z.object({
  id: z.string(),
  type: z.enum([
    'subscription', 'one_time', 'usage_based', 'freemium',
    'marketplace', 'advertising', 'licensing', 'service', 'hybrid',
  ]),
  description: z.string(),
  keyMetrics: z.array(z.string()),
  upsellOpportunities: z.array(z.string()),
  churnRiskFactors: z.array(z.string()),
});

/**
 * Strategy Templates — pre-built strategies the Decision Engine can select from.
 * Each strategy defines WHEN to use it, WHAT actions it takes, and HOW to measure success.
 */
const StrategyTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  type: z.enum([
    'direct_outreach', 'nurture_sequence', 'trust_building',
    'guided_discovery', 're_engagement', 'upsell_cross_sell',
    'retention_save', 'referral_ask', 'onboarding_activation',
  ]),
  applicableJourneyStages: z.array(z.string()),
  applicablePersonas: z.array(z.string()).optional(),
  steps: z.array(z.object({
    order: z.number(),
    action: z.string(),
    channel: z.enum(['email', 'sms', 'whatsapp', 'phone', 'chat', 'crm_task', 'webhook']),
    delayAfterPrevious: z.string().optional(),
    condition: z.string().optional(),
  })),
  successMetrics: z.array(z.string()),
  expectedConversionRate: z.number().min(0).max(100).optional(),
  cooldownPeriod: z.string().optional(),
});

/**
 * The complete Blueprint schema — the full knowledge package loaded per tenant.
 */
const BlueprintSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  version: z.string(),
  vertical: z.string(),
  description: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  customerModel: CustomerModelSchema,
  buyerJourneys: z.array(BuyerJourneySchema),
  kpis: z.array(KpiDefinitionSchema),
  objections: z.array(ObjectionSchema),
  revenueModels: z.array(RevenueModelSchema),
  strategyTemplates: z.array(StrategyTemplateSchema),
  metadata: z.object({
    author: z.string(),
    isDefault: z.boolean(),
    applicableIndustries: z.array(z.string()),
    tags: z.array(z.string()),
  }),
});

// Export types
type Blueprint = z.infer<typeof BlueprintSchema>;
type CustomerPersona = z.infer<typeof CustomerPersonaSchema>;
type BuyerJourney = z.infer<typeof BuyerJourneySchema>;
type JourneyStage = z.infer<typeof JourneyStageSchema>;
type KpiDefinition = z.infer<typeof KpiDefinitionSchema>;
type Objection = z.infer<typeof ObjectionSchema>;
type RevenueModel = z.infer<typeof RevenueModelSchema>;
type StrategyTemplate = z.infer<typeof StrategyTemplateSchema>;

// ── KAN-132: Generic B2B/B2C Blueprint Data ────────────────────────────────────

/**
 * The default, industry-agnostic Blueprint.
 * Covers common patterns for both B2B and B2C businesses.
 * Tenants can layer Company Truth on top to specialize.
 */
const GENERIC_BLUEPRINT: Blueprint = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Generic B2B/B2C Blueprint',
  version: '1.0.0',
  vertical: 'generic',
  description:
    'Industry-agnostic Blueprint providing universal customer models, buyer journeys, ' +
    'KPI definitions, and strategy templates. Serves as the foundation for any business type — ' +
    'B2B or B2C. Tenant-specific knowledge layers on top via Company Truth.',
  createdAt: '2025-01-01T00:00:00.000Z',
  updatedAt: '2025-01-01T00:00:00.000Z',

  // ── Customer Model ──
  customerModel: {
    personas: [
      {
        id: 'persona_decision_maker',
        name: 'Decision Maker',
        description:
          'The person with budget authority who makes the final purchase decision. ' +
          'Cares about ROI, risk, and strategic alignment.',
        demographics: {
          role: 'Manager / Director / VP / Owner',
          decisionLevel: 'executive',
        },
        painPoints: [
          'Needs clear ROI justification',
          'Risk-averse — wants proven solutions',
          'Time-constrained — needs concise information',
          'Overwhelmed by vendor noise',
        ],
        goals: [
          'Drive revenue growth',
          'Reduce operational costs',
          'Mitigate business risk',
          'Stay competitive',
        ],
        preferredChannels: ['email', 'phone'],
        buyingBehavior: {
          researchStyle: 'consultative',
          decisionSpeed: 'moderate',
          priceWeight: 'medium',
        },
      },
      {
        id: 'persona_end_user',
        name: 'End User / Champion',
        description:
          'The daily user who evaluates and champions the product internally. ' +
          'Cares about ease of use, features, and support quality.',
        demographics: {
          role: 'Individual Contributor / Team Lead',
          decisionLevel: 'team',
        },
        painPoints: [
          'Frustrated with current tools',
          'Needs faster workflows',
          'Wants better integrations',
          'Lacks visibility into metrics',
        ],
        goals: [
          'Simplify daily work',
          'Get better results with less effort',
          'Look good to leadership',
          'Solve a specific operational pain',
        ],
        preferredChannels: ['email', 'chat', 'sms'],
        buyingBehavior: {
          researchStyle: 'self-service',
          decisionSpeed: 'fast',
          priceWeight: 'low',
        },
      },
      {
        id: 'persona_consumer',
        name: 'Consumer Buyer',
        description:
          'Individual purchasing for personal use. Driven by emotion, convenience, ' +
          'social proof, and perceived value.',
        demographics: {
          decisionLevel: 'individual',
        },
        painPoints: [
          'Too many choices — decision fatigue',
          'Uncertain about quality or fit',
          'Price-sensitive but wants value',
          'Needs trust before committing',
        ],
        goals: [
          'Solve an immediate need',
          'Get the best deal',
          'Feel confident in the purchase',
          'Have a great customer experience',
        ],
        preferredChannels: ['email', 'sms', 'whatsapp', 'social'],
        buyingBehavior: {
          researchStyle: 'self-service',
          decisionSpeed: 'fast',
          priceWeight: 'high',
        },
      },
      {
        id: 'persona_influencer',
        name: 'Influencer / Evaluator',
        description:
          'Researches options and provides recommendations to the decision maker. ' +
          'Highly detail-oriented and comparison-focused.',
        demographics: {
          role: 'Analyst / Specialist / Consultant',
          decisionLevel: 'team',
        },
        painPoints: [
          'Needs detailed specs and comparisons',
          'Held accountable for recommendations',
          'Needs to justify choices with data',
          'Often evaluates multiple vendors',
        ],
        goals: [
          'Find the best solution objectively',
          'Build a strong business case',
          'Reduce implementation risk',
          'Get peer validation',
        ],
        preferredChannels: ['email', 'chat'],
        buyingBehavior: {
          researchStyle: 'guided',
          decisionSpeed: 'slow',
          priceWeight: 'medium',
        },
      },
    ],

    segments: [
      {
        id: 'segment_new_lead',
        name: 'New Lead',
        description: 'Recently captured contact with no purchase history.',
        personaIds: ['persona_decision_maker', 'persona_end_user', 'persona_consumer'],
      },
      {
        id: 'segment_engaged_prospect',
        name: 'Engaged Prospect',
        description: 'Lead who has shown active interest — opened emails, visited site, requested info.',
        personaIds: ['persona_decision_maker', 'persona_end_user', 'persona_consumer', 'persona_influencer'],
      },
      {
        id: 'segment_active_customer',
        name: 'Active Customer',
        description: 'Has made at least one purchase and is actively using the product/service.',
        personaIds: ['persona_decision_maker', 'persona_end_user', 'persona_consumer'],
      },
      {
        id: 'segment_at_risk',
        name: 'At-Risk Customer',
        description: 'Customer showing signs of disengagement — declining usage, missed renewals, complaints.',
        personaIds: ['persona_decision_maker', 'persona_end_user', 'persona_consumer'],
      },
      {
        id: 'segment_churned',
        name: 'Churned / Inactive',
        description: 'Former customer or lead who has gone silent for extended period.',
        personaIds: ['persona_decision_maker', 'persona_consumer'],
      },
    ],

    idealCustomerProfile: {
      description:
        'A business or individual with a clear need that our product/service addresses, ' +
        'sufficient budget to purchase, and a reasonable timeline for decision-making.',
      qualifyingSignals: [
        'Expressed interest via form, demo request, or inquiry',
        'Matches target company size or demographic',
        'Has budget authority or access to decision maker',
        'Active in evaluating solutions (multiple touchpoints)',
        'Existing pain that our product directly solves',
      ],
      disqualifyingSignals: [
        'No budget or unrealistic budget expectations',
        'Need doesn\'t match our offering',
        'Competitor\'s employee or partner (intelligence gathering)',
        'Geographic or regulatory exclusion',
        'Spam or invalid contact information',
      ],
    },
  },

  // ── Buyer Journeys ──
  buyerJourneys: [
    {
      id: 'journey_acquisition',
      name: 'New Customer Acquisition',
      description: 'From first touch to first purchase — the core conversion journey.',
      type: 'acquisition',
      stages: [
        {
          id: 'stage_awareness',
          name: 'Awareness',
          description: 'Contact knows we exist but hasn\'t engaged meaningfully.',
          order: 1,
          entryConditions: ['Lead captured via any channel'],
          exitConditions: ['Opened email or clicked link', 'Visited website', 'Responded to outreach'],
          typicalDuration: '1-7 days',
          recommendedActions: [
            'Welcome email with value proposition',
            'Educational content delivery',
            'Brand introduction sequence',
          ],
          kpis: ['open_rate', 'click_rate'],
        },
        {
          id: 'stage_interest',
          name: 'Interest',
          description: 'Contact is actively engaging — reading content, exploring offerings.',
          order: 2,
          entryConditions: ['Has engaged with at least one touchpoint'],
          exitConditions: ['Requested demo or pricing', 'Started trial', 'Asked a question'],
          typicalDuration: '3-14 days',
          recommendedActions: [
            'Case study or social proof delivery',
            'Targeted content based on interests',
            'Soft call-to-action for next step',
          ],
          kpis: ['engagement_score', 'content_consumption'],
        },
        {
          id: 'stage_consideration',
          name: 'Consideration',
          description: 'Contact is evaluating our solution against alternatives.',
          order: 3,
          entryConditions: ['Requested specific information', 'Demo or trial active'],
          exitConditions: ['Received proposal or quote', 'Stated intent to buy'],
          typicalDuration: '7-30 days',
          recommendedActions: [
            'Personalized proposal or quote',
            'Competitor comparison points',
            'ROI calculator or business case',
            'Reference customer introduction',
          ],
          kpis: ['proposal_sent_rate', 'response_rate'],
        },
        {
          id: 'stage_decision',
          name: 'Decision',
          description: 'Contact is ready to buy — final objections and negotiation.',
          order: 4,
          entryConditions: ['Proposal reviewed', 'Pricing discussed'],
          exitConditions: ['Purchase completed', 'Deal lost'],
          typicalDuration: '1-14 days',
          recommendedActions: [
            'Address final objections',
            'Create urgency (limited offer, deadline)',
            'Simplify purchase process',
            'Executive sponsor outreach if needed',
          ],
          kpis: ['close_rate', 'time_to_close', 'deal_value'],
        },
      ],
    },
    {
      id: 'journey_retention',
      name: 'Customer Retention',
      description: 'Keep existing customers engaged, satisfied, and renewing.',
      type: 'retention',
      stages: [
        {
          id: 'stage_onboarding',
          name: 'Onboarding',
          description: 'New customer getting started with the product/service.',
          order: 1,
          entryConditions: ['First purchase completed'],
          exitConditions: ['Completed setup', 'First value milestone achieved'],
          typicalDuration: '1-30 days',
          recommendedActions: [
            'Welcome and setup guide',
            'Onboarding check-in sequence',
            'First success milestone celebration',
          ],
          kpis: ['activation_rate', 'time_to_first_value'],
        },
        {
          id: 'stage_active_use',
          name: 'Active Use',
          description: 'Customer is regularly using and getting value.',
          order: 2,
          entryConditions: ['Regular usage pattern established'],
          exitConditions: ['Usage declining', 'Renewal approaching'],
          typicalDuration: 'Ongoing',
          recommendedActions: [
            'Usage tips and best practices',
            'Feature adoption nudges',
            'Satisfaction check-ins',
            'Community engagement',
          ],
          kpis: ['usage_frequency', 'feature_adoption', 'nps_score'],
        },
        {
          id: 'stage_renewal',
          name: 'Renewal / Repeat',
          description: 'Approaching renewal date or opportunity for repeat purchase.',
          order: 3,
          entryConditions: ['Renewal window opened', 'Repeat purchase opportunity'],
          exitConditions: ['Renewed / repurchased', 'Churned'],
          typicalDuration: '14-30 days before expiry',
          recommendedActions: [
            'Renewal reminder with value recap',
            'Special renewal offer if at risk',
            'Usage report highlighting ROI',
            'Upgrade opportunity presentation',
          ],
          kpis: ['renewal_rate', 'expansion_revenue', 'churn_rate'],
        },
      ],
    },
    {
      id: 'journey_reactivation',
      name: 'Re-engagement',
      description: 'Win back churned customers or re-engage dormant leads.',
      type: 'reactivation',
      stages: [
        {
          id: 'stage_dormant',
          name: 'Dormant',
          description: 'No engagement for extended period.',
          order: 1,
          entryConditions: ['No activity for 30+ days (leads) or 60+ days (customers)'],
          exitConditions: ['Responded to re-engagement', 'Marked as permanently lost'],
          typicalDuration: '14-60 days',
          recommendedActions: [
            'Re-engagement email with new value',
            '"We miss you" campaign',
            'Special comeback offer',
            'Survey: what went wrong?',
          ],
          kpis: ['reactivation_rate', 'response_rate'],
        },
        {
          id: 'stage_reactivated',
          name: 'Reactivated',
          description: 'Previously dormant contact has re-engaged.',
          order: 2,
          entryConditions: ['Responded to re-engagement campaign'],
          exitConditions: ['Converted to active', 'Went dormant again'],
          typicalDuration: '7-30 days',
          recommendedActions: [
            'Accelerated nurture sequence',
            'Personalized offer based on history',
            'Direct outreach from account owner',
          ],
          kpis: ['reconversion_rate', 'time_to_reconvert'],
        },
      ],
    },
  ],

  // ── KPI Definitions ──
  kpis: [
    {
      id: 'kpi_lead_conversion_rate',
      name: 'Lead Conversion Rate',
      description: 'Percentage of leads that convert to customers.',
      category: 'conversion',
      calculationMethod: '(customers_acquired / total_leads) * 100',
      unit: 'percentage',
      direction: 'higher_is_better',
      benchmarks: { poor: 1, average: 3, good: 5, excellent: 10 },
    },
    {
      id: 'kpi_response_rate',
      name: 'Response Rate',
      description: 'Percentage of outreach messages that receive a reply.',
      category: 'engagement',
      calculationMethod: '(replies_received / messages_sent) * 100',
      unit: 'percentage',
      direction: 'higher_is_better',
      benchmarks: { poor: 2, average: 8, good: 15, excellent: 25 },
    },
    {
      id: 'kpi_open_rate',
      name: 'Email Open Rate',
      description: 'Percentage of emails that are opened.',
      category: 'engagement',
      calculationMethod: '(emails_opened / emails_delivered) * 100',
      unit: 'percentage',
      direction: 'higher_is_better',
      benchmarks: { poor: 10, average: 22, good: 35, excellent: 50 },
    },
    {
      id: 'kpi_click_rate',
      name: 'Click-Through Rate',
      description: 'Percentage of opened emails where a link was clicked.',
      category: 'engagement',
      calculationMethod: '(links_clicked / emails_opened) * 100',
      unit: 'percentage',
      direction: 'higher_is_better',
      benchmarks: { poor: 1, average: 3, good: 5, excellent: 10 },
    },
    {
      id: 'kpi_time_to_close',
      name: 'Average Time to Close',
      description: 'Average days from first touch to purchase.',
      category: 'efficiency',
      calculationMethod: 'avg(close_date - first_touch_date)',
      unit: 'days',
      direction: 'lower_is_better',
      benchmarks: { excellent: 7, good: 14, average: 30, poor: 60 },
    },
    {
      id: 'kpi_customer_lifetime_value',
      name: 'Customer Lifetime Value (LTV)',
      description: 'Total revenue expected from a customer over their lifetime.',
      category: 'revenue',
      calculationMethod: 'avg_order_value * purchase_frequency * avg_customer_lifespan',
      unit: 'currency',
      direction: 'higher_is_better',
    },
    {
      id: 'kpi_churn_rate',
      name: 'Churn Rate',
      description: 'Percentage of customers lost in a given period.',
      category: 'retention',
      calculationMethod: '(customers_lost / total_customers_start) * 100',
      unit: 'percentage',
      direction: 'lower_is_better',
      benchmarks: { excellent: 1, good: 3, average: 5, poor: 10 },
    },
    {
      id: 'kpi_nps_score',
      name: 'Net Promoter Score',
      description: 'Customer likelihood to recommend (−100 to +100).',
      category: 'satisfaction',
      calculationMethod: '% promoters - % detractors',
      unit: 'score',
      direction: 'higher_is_better',
      benchmarks: { poor: 0, average: 30, good: 50, excellent: 70 },
    },
    {
      id: 'kpi_engagement_score',
      name: 'Contact Engagement Score',
      description: 'Composite score based on opens, clicks, site visits, and responses.',
      category: 'engagement',
      calculationMethod: 'weighted_sum(opens, clicks, visits, replies)',
      unit: 'score',
      direction: 'higher_is_better',
    },
    {
      id: 'kpi_reactivation_rate',
      name: 'Reactivation Rate',
      description: 'Percentage of dormant contacts successfully re-engaged.',
      category: 'retention',
      calculationMethod: '(reactivated_contacts / dormant_contacts_targeted) * 100',
      unit: 'percentage',
      direction: 'higher_is_better',
      benchmarks: { poor: 2, average: 8, good: 15, excellent: 25 },
    },
  ],

  // ── Objection Framework ──
  objections: [
    {
      id: 'obj_too_expensive',
      category: 'price',
      objection: 'It\'s too expensive / I can\'t afford it.',
      severity: 'high',
      handlingStrategies: [
        {
          approach: 'Value reframe',
          responseTemplate:
            'I understand budget is important. Let me show you the ROI our customers typically see — ' +
            'most find the investment pays for itself within {timeframe}.',
          effectivenessScore: 70,
        },
        {
          approach: 'Payment flexibility',
          responseTemplate:
            'We have flexible payment options that can make this work within your budget. ' +
            'Would you like to explore what that looks like?',
          effectivenessScore: 60,
        },
      ],
    },
    {
      id: 'obj_bad_timing',
      category: 'timing',
      objection: 'Not the right time / We\'re too busy right now.',
      severity: 'medium',
      handlingStrategies: [
        {
          approach: 'Cost of delay',
          responseTemplate:
            'I completely understand. Quick question — what\'s the cost of waiting another ' +
            '{period}? Many of our customers wished they\'d started sooner.',
          effectivenessScore: 55,
        },
        {
          approach: 'Future commitment',
          responseTemplate:
            'No problem at all. When would be a better time? I\'ll make sure to follow up ' +
            'with some relevant info so you\'re ready when the timing is right.',
          effectivenessScore: 65,
        },
      ],
    },
    {
      id: 'obj_no_need',
      category: 'need',
      objection: 'We don\'t need this / Our current solution works fine.',
      severity: 'high',
      handlingStrategies: [
        {
          approach: 'Discovery question',
          responseTemplate:
            'That\'s great that things are working! Out of curiosity, if you could improve one thing ' +
            'about your current {area}, what would it be?',
          effectivenessScore: 60,
        },
        {
          approach: 'Competitive insight',
          responseTemplate:
            'Many of our customers felt the same way before they saw how {specific_benefit} ' +
            'could save them {time/money}. Would a quick comparison be helpful?',
          effectivenessScore: 50,
        },
      ],
    },
    {
      id: 'obj_trust',
      category: 'trust',
      objection: 'I\'ve never heard of you / How do I know this works?',
      severity: 'medium',
      handlingStrategies: [
        {
          approach: 'Social proof',
          responseTemplate:
            'Great question! We work with {number} businesses similar to yours. ' +
            'Here\'s a quick case study from {similar_company} that shows their results.',
          effectivenessScore: 75,
        },
        {
          approach: 'Risk reversal',
          responseTemplate:
            'We\'re confident you\'ll see results, which is why we offer {guarantee/trial}. ' +
            'You can try it risk-free and see for yourself.',
          effectivenessScore: 70,
        },
      ],
    },
    {
      id: 'obj_competition',
      category: 'competition',
      objection: 'We\'re already working with / evaluating {competitor}.',
      severity: 'medium',
      handlingStrategies: [
        {
          approach: 'Differentiation',
          responseTemplate:
            '{Competitor} is a solid choice. Where we differ is {key_differentiator}. ' +
            'Our customers often find that {unique_value} makes a significant difference.',
          effectivenessScore: 60,
        },
        {
          approach: 'Complementary positioning',
          responseTemplate:
            'That\'s great! Many of our customers actually use both — we complement {competitor} ' +
            'by handling {specific_area} where they don\'t focus.',
          effectivenessScore: 55,
        },
      ],
    },
    {
      id: 'obj_authority',
      category: 'authority',
      objection: 'I need to check with my team / boss / partner.',
      severity: 'low',
      handlingStrategies: [
        {
          approach: 'Enable the champion',
          responseTemplate:
            'Absolutely! I can put together a summary that makes it easy to share. ' +
            'What are the key things your {decision_maker} would want to know?',
          effectivenessScore: 70,
        },
        {
          approach: 'Group meeting',
          responseTemplate:
            'Would it be helpful if I joined a quick call with you and your team? ' +
            'I can address any questions directly — saves you time.',
          effectivenessScore: 65,
        },
      ],
    },
    {
      id: 'obj_inertia',
      category: 'inertia',
      objection: 'Switching seems like too much work.',
      severity: 'medium',
      handlingStrategies: [
        {
          approach: 'Easy transition',
          responseTemplate:
            'We\'ve made switching really simple. Our team handles {migration_details} and ' +
            'most customers are fully up and running within {timeframe}.',
          effectivenessScore: 65,
        },
        {
          approach: 'Incremental approach',
          responseTemplate:
            'You don\'t have to switch everything at once. Many customers start with just ' +
            '{one_area} and expand from there. No disruption to your current workflow.',
          effectivenessScore: 60,
        },
      ],
    },
  ],

  // ── Revenue Models ──
  revenueModels: [
    {
      id: 'rev_subscription',
      type: 'subscription',
      description: 'Recurring revenue from monthly or annual subscriptions.',
      keyMetrics: ['MRR', 'ARR', 'churn_rate', 'expansion_revenue', 'LTV'],
      upsellOpportunities: [
        'Tier upgrade (more features)',
        'Seat expansion (more users)',
        'Add-on modules',
        'Premium support',
      ],
      churnRiskFactors: [
        'Low usage in first 30 days',
        'No logins for 14+ days',
        'Support tickets increasing',
        'Failed payment retry',
        'Competitor evaluation signals',
      ],
    },
    {
      id: 'rev_one_time',
      type: 'one_time',
      description: 'Single purchase transactions — products, services, or projects.',
      keyMetrics: ['average_order_value', 'purchase_frequency', 'repeat_purchase_rate', 'LTV'],
      upsellOpportunities: [
        'Complementary products',
        'Extended warranty or service',
        'Premium version or upgrade',
        'Bundles and packages',
      ],
      churnRiskFactors: [
        'No repeat purchase within expected window',
        'Negative review or return',
        'No engagement after purchase',
        'Competitor purchase detected',
      ],
    },
    {
      id: 'rev_service',
      type: 'service',
      description: 'Revenue from professional services, consulting, or managed services.',
      keyMetrics: ['project_value', 'utilization_rate', 'client_retention', 'expansion_rate'],
      upsellOpportunities: [
        'Additional service lines',
        'Retainer or ongoing engagement',
        'Training and enablement',
        'Strategic advisory',
      ],
      churnRiskFactors: [
        'Project completion without follow-on',
        'Scope creep without value alignment',
        'Key stakeholder departure',
        'Budget cycle changes',
      ],
    },
  ],

  // ── Strategy Templates ──
  strategyTemplates: [
    {
      id: 'strategy_welcome_nurture',
      name: 'Welcome & Nurture',
      description: 'Warm welcome sequence for new leads — build trust and educate.',
      type: 'nurture_sequence',
      applicableJourneyStages: ['stage_awareness', 'stage_interest'],
      steps: [
        { order: 1, action: 'Send welcome email with brand introduction', channel: 'email' },
        { order: 2, action: 'Send educational content (value prop)', channel: 'email', delayAfterPrevious: '2 days' },
        { order: 3, action: 'Send social proof / case study', channel: 'email', delayAfterPrevious: '3 days' },
        { order: 4, action: 'Soft CTA — book a call or try demo', channel: 'email', delayAfterPrevious: '2 days', condition: 'No response to previous emails' },
      ],
      successMetrics: ['open_rate > 30%', 'click_rate > 5%', 'reply_rate > 3%'],
      expectedConversionRate: 8,
      cooldownPeriod: '14 days',
    },
    {
      id: 'strategy_direct_outreach',
      name: 'Direct Outreach',
      description: 'Proactive outreach to high-intent or high-value leads.',
      type: 'direct_outreach',
      applicableJourneyStages: ['stage_interest', 'stage_consideration'],
      steps: [
        { order: 1, action: 'Personalized intro email referencing their specific need', channel: 'email' },
        { order: 2, action: 'Follow-up SMS with brief value hook', channel: 'sms', delayAfterPrevious: '1 day', condition: 'Email opened but no reply' },
        { order: 3, action: 'Direct call or voicemail', channel: 'phone', delayAfterPrevious: '2 days', condition: 'No response to email or SMS' },
        { order: 4, action: 'Final follow-up with urgency element', channel: 'email', delayAfterPrevious: '3 days', condition: 'No response to any channel' },
      ],
      successMetrics: ['response_rate > 15%', 'meeting_booked_rate > 5%'],
      expectedConversionRate: 12,
      cooldownPeriod: '21 days',
    },
    {
      id: 'strategy_trust_building',
      name: 'Trust Building',
      description: 'For leads who need more confidence before engaging. Focus on proof and credibility.',
      type: 'trust_building',
      applicableJourneyStages: ['stage_consideration'],
      applicablePersonas: ['persona_decision_maker', 'persona_influencer'],
      steps: [
        { order: 1, action: 'Send industry-specific case study', channel: 'email' },
        { order: 2, action: 'Share customer testimonial video or quote', channel: 'email', delayAfterPrevious: '3 days' },
        { order: 3, action: 'Offer reference call with similar customer', channel: 'email', delayAfterPrevious: '4 days' },
        { order: 4, action: 'Send ROI calculator or business case template', channel: 'email', delayAfterPrevious: '3 days' },
      ],
      successMetrics: ['engagement_score_increase > 20', 'moved_to_decision_stage'],
      expectedConversionRate: 15,
      cooldownPeriod: '30 days',
    },
    {
      id: 'strategy_guided_discovery',
      name: 'Guided Discovery',
      description: 'Help leads explore and understand the product through guided experience.',
      type: 'guided_discovery',
      applicableJourneyStages: ['stage_interest', 'stage_consideration'],
      applicablePersonas: ['persona_end_user', 'persona_consumer'],
      steps: [
        { order: 1, action: 'Send personalized product walkthrough', channel: 'email' },
        { order: 2, action: 'Trigger in-app onboarding guide', channel: 'webhook', delayAfterPrevious: '1 day', condition: 'Trial or demo active' },
        { order: 3, action: 'Check-in message asking about experience', channel: 'sms', delayAfterPrevious: '3 days' },
        { order: 4, action: 'Offer live demo or Q&A session', channel: 'email', delayAfterPrevious: '2 days', condition: 'Low engagement with self-service' },
      ],
      successMetrics: ['trial_activation > 50%', 'feature_adoption > 3 features'],
      expectedConversionRate: 20,
      cooldownPeriod: '14 days',
    },
    {
      id: 'strategy_re_engagement',
      name: 'Re-engagement Campaign',
      description: 'Win back dormant leads or churned customers.',
      type: 're_engagement',
      applicableJourneyStages: ['stage_dormant'],
      steps: [
        { order: 1, action: 'Re-engagement email — what\'s new + special offer', channel: 'email' },
        { order: 2, action: 'SMS nudge with compelling reason to return', channel: 'sms', delayAfterPrevious: '3 days', condition: 'Email not opened' },
        { order: 3, action: 'Personalized win-back offer', channel: 'email', delayAfterPrevious: '5 days' },
        { order: 4, action: 'Final outreach or mark as permanently dormant', channel: 'email', delayAfterPrevious: '7 days', condition: 'No engagement with any previous step' },
      ],
      successMetrics: ['reactivation_rate > 10%', 'response_rate > 5%'],
      expectedConversionRate: 8,
      cooldownPeriod: '60 days',
    },
    {
      id: 'strategy_upsell',
      name: 'Upsell / Cross-Sell',
      description: 'Expand revenue from existing happy customers.',
      type: 'upsell_cross_sell',
      applicableJourneyStages: ['stage_active_use'],
      steps: [
        { order: 1, action: 'Usage insight email — show value delivered', channel: 'email' },
        { order: 2, action: 'Introduce complementary product/feature', channel: 'email', delayAfterPrevious: '3 days' },
        { order: 3, action: 'Personalized upgrade offer based on usage', channel: 'email', delayAfterPrevious: '5 days', condition: 'Clicked on feature info' },
        { order: 4, action: 'Direct call to discuss expansion', channel: 'phone', delayAfterPrevious: '3 days', condition: 'High engagement but no conversion' },
      ],
      successMetrics: ['upsell_conversion > 10%', 'expansion_revenue_increase'],
      expectedConversionRate: 15,
      cooldownPeriod: '30 days',
    },
    {
      id: 'strategy_retention_save',
      name: 'Retention Save',
      description: 'Prevent at-risk customers from churning.',
      type: 'retention_save',
      applicableJourneyStages: ['stage_renewal'],
      steps: [
        { order: 1, action: 'Proactive check-in acknowledging low engagement', channel: 'email' },
        { order: 2, action: 'Personalized usage tips to re-derive value', channel: 'email', delayAfterPrevious: '2 days' },
        { order: 3, action: 'Special retention offer (discount or added value)', channel: 'email', delayAfterPrevious: '3 days', condition: 'Still at risk' },
        { order: 4, action: 'Escalate to human — account manager call', channel: 'crm_task', delayAfterPrevious: '2 days', condition: 'No improvement in engagement' },
      ],
      successMetrics: ['save_rate > 30%', 'usage_increase_after_intervention'],
      expectedConversionRate: 25,
      cooldownPeriod: '90 days',
    },
    {
      id: 'strategy_onboarding',
      name: 'Onboarding Activation',
      description: 'Guide new customers to their first value milestone.',
      type: 'onboarding_activation',
      applicableJourneyStages: ['stage_onboarding'],
      steps: [
        { order: 1, action: 'Welcome message with getting-started guide', channel: 'email' },
        { order: 2, action: 'Day 3 check-in — any questions?', channel: 'sms', delayAfterPrevious: '3 days' },
        { order: 3, action: 'Feature highlight based on stated goals', channel: 'email', delayAfterPrevious: '4 days' },
        { order: 4, action: 'Celebration of first milestone + next steps', channel: 'email', delayAfterPrevious: '7 days', condition: 'First value milestone reached' },
        { order: 5, action: 'Offer setup help if milestone not reached', channel: 'email', delayAfterPrevious: '7 days', condition: 'First value milestone NOT reached' },
      ],
      successMetrics: ['activation_rate > 60%', 'time_to_first_value < 7 days'],
      expectedConversionRate: 70,
      cooldownPeriod: '0 days',
    },
  ],

  // ── Metadata ──
  metadata: {
    author: 'growth by AxisOne',
    isDefault: true,
    applicableIndustries: ['*'],
    tags: ['generic', 'b2b', 'b2c', 'universal', 'starter'],
  },
};

// ── KAN-133: Blueprint Loader at Tenant Creation ───────────────────────────────

/**
 * Load a Blueprint into the brain_snapshots table for a new tenant.
 * This is called during tenant provisioning to seed the Business Brain
 * with foundational industry knowledge.
 *
 * The Blueprint layer is READ-ONLY — tenant-specific data layers on top
 * via Company Truth, Behavioral Learning, and Outcome Learning.
 */
async function loadBlueprintForTenant(
  tenantId: string,
  blueprintId?: string
): Promise<{ snapshotId: string; blueprintName: string }> {
  // For MVP, always use the generic Blueprint
  // Future: look up blueprintId from a blueprints catalog table
  const blueprint = GENERIC_BLUEPRINT;

  // Validate Blueprint data integrity
  const parsed = BlueprintSchema.safeParse(blueprint);
  if (!parsed.success) {
    throw new Error(`Blueprint validation failed: ${parsed.error.message}`);
  }

  const snapshotId = randomUUID();

  // Create the initial brain snapshot with Blueprint as the foundation
  await prisma.brainSnapshot.create({
    data: {
      id: snapshotId,
      tenantId,
      version: 1,
      blueprintId: blueprint.id,
      blueprintData: blueprint as any,
      companyTruth: {}, // Empty — populated during onboarding
      behavioralModel: {}, // Empty — populated by Learning Service
      outcomeModel: {}, // Empty — populated by Learning Service
      status: 'active',
      metadata: {
        blueprintName: blueprint.name,
        blueprintVersion: blueprint.version,
        loadedAt: new Date().toISOString(),
        source: 'tenant_creation',
      },
    },
  });

  // Store the Blueprint reference on the tenant record
  await prisma.tenant.update({
    where: { id: tenantId },
    data: {
      blueprintId: blueprint.id,
      brainStatus: 'blueprint_loaded',
    },
  });

  // Audit log
  await prisma.auditLog.create({
    data: {
      tenantId,
      actor: 'system',
      actionType: 'brain.blueprint_loaded',
      payload: {
        blueprintId: blueprint.id,
        blueprintName: blueprint.name,
        blueprintVersion: blueprint.version,
        snapshotId,
      },
      reasoning: 'Blueprint loaded automatically during tenant creation',
    },
  });

  return { snapshotId, blueprintName: blueprint.name };
}

/**
 * Get the currently loaded Blueprint for a tenant.
 */
async function getBlueprintForTenant(tenantId: string): Promise<Blueprint | null> {
  const snapshot = await prisma.brainSnapshot.findFirst({
    where: {
      tenantId,
      status: 'active',
    },
    orderBy: { version: 'desc' },
  });

  if (!snapshot?.blueprintData) return null;
  return snapshot.blueprintData as unknown as Blueprint;
}

// ── API Routes ─────────────────────────────────────────────────────────────────

/**
 * GET /brain/blueprint
 * Get the loaded Blueprint for a tenant.
 */
router.get('/brain/blueprint', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const blueprint = await getBlueprintForTenant(tenantId);
    if (!blueprint) {
      return res.status(404).json({
        error: 'No Blueprint loaded for this tenant',
        message: 'Blueprint is loaded during tenant creation. Contact support if missing.',
      });
    }

    return res.json({
      blueprint: {
        id: blueprint.id,
        name: blueprint.name,
        version: blueprint.version,
        vertical: blueprint.vertical,
        description: blueprint.description,
        personaCount: blueprint.customerModel.personas.length,
        segmentCount: blueprint.customerModel.segments.length,
        journeyCount: blueprint.buyerJourneys.length,
        kpiCount: blueprint.kpis.length,
        objectionCount: blueprint.objections.length,
        strategyCount: blueprint.strategyTemplates.length,
      },
    });
  } catch (error: any) {
    console.error('Blueprint fetch error:', error);
    return res.status(500).json({
      error: 'Failed to get Blueprint',
      details: error.message,
    });
  }
});

/**
 * GET /brain/blueprint/full
 * Get the full Blueprint data for a tenant (used by Decision Engine).
 */
router.get('/brain/blueprint/full', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const blueprint = await getBlueprintForTenant(tenantId);
    if (!blueprint) {
      return res.status(404).json({ error: 'No Blueprint loaded for this tenant' });
    }

    return res.json({ blueprint });
  } catch (error: any) {
    console.error('Blueprint full fetch error:', error);
    return res.status(500).json({
      error: 'Failed to get full Blueprint',
      details: error.message,
    });
  }
});

/**
 * GET /brain/blueprint/personas
 * Get customer personas from the Blueprint.
 */
router.get('/brain/blueprint/personas', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const blueprint = await getBlueprintForTenant(tenantId);
    if (!blueprint) {
      return res.status(404).json({ error: 'No Blueprint loaded for this tenant' });
    }

    return res.json({
      personas: blueprint.customerModel.personas,
      segments: blueprint.customerModel.segments,
      idealCustomerProfile: blueprint.customerModel.idealCustomerProfile,
    });
  } catch (error: any) {
    console.error('Personas fetch error:', error);
    return res.status(500).json({ error: 'Failed to get personas', details: error.message });
  }
});

/**
 * GET /brain/blueprint/journeys
 * Get buyer journeys from the Blueprint.
 */
router.get('/brain/blueprint/journeys', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const blueprint = await getBlueprintForTenant(tenantId);
    if (!blueprint) {
      return res.status(404).json({ error: 'No Blueprint loaded for this tenant' });
    }

    return res.json({ journeys: blueprint.buyerJourneys });
  } catch (error: any) {
    console.error('Journeys fetch error:', error);
    return res.status(500).json({ error: 'Failed to get journeys', details: error.message });
  }
});

/**
 * GET /brain/blueprint/strategies
 * Get strategy templates from the Blueprint.
 */
router.get('/brain/blueprint/strategies', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const blueprint = await getBlueprintForTenant(tenantId);
    if (!blueprint) {
      return res.status(404).json({ error: 'No Blueprint loaded for this tenant' });
    }

    // Optionally filter by journey stage
    const journeyStage = req.query.journeyStage as string;
    let strategies = blueprint.strategyTemplates;

    if (journeyStage) {
      strategies = strategies.filter((s) =>
        s.applicableJourneyStages.includes(journeyStage)
      );
    }

    return res.json({ strategies, total: strategies.length });
  } catch (error: any) {
    console.error('Strategies fetch error:', error);
    return res.status(500).json({ error: 'Failed to get strategies', details: error.message });
  }
});

/**
 * GET /brain/blueprint/kpis
 * Get KPI definitions from the Blueprint.
 */
router.get('/brain/blueprint/kpis', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const blueprint = await getBlueprintForTenant(tenantId);
    if (!blueprint) {
      return res.status(404).json({ error: 'No Blueprint loaded for this tenant' });
    }

    // Optionally filter by category
    const category = req.query.category as string;
    let kpis = blueprint.kpis;

    if (category) {
      kpis = kpis.filter((k) => k.category === category);
    }

    return res.json({ kpis, total: kpis.length });
  } catch (error: any) {
    console.error('KPIs fetch error:', error);
    return res.status(500).json({ error: 'Failed to get KPIs', details: error.message });
  }
});

/**
 * GET /brain/blueprint/objections
 * Get objection framework from the Blueprint.
 */
router.get('/brain/blueprint/objections', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const blueprint = await getBlueprintForTenant(tenantId);
    if (!blueprint) {
      return res.status(404).json({ error: 'No Blueprint loaded for this tenant' });
    }

    // Optionally filter by category
    const category = req.query.category as string;
    let objections = blueprint.objections;

    if (category) {
      objections = objections.filter((o) => o.category === category);
    }

    return res.json({ objections, total: objections.length });
  } catch (error: any) {
    console.error('Objections fetch error:', error);
    return res.status(500).json({ error: 'Failed to get objections', details: error.message });
  }
});

/**
 * POST /brain/blueprint/reload
 * Force reload the Blueprint for a tenant (admin operation).
 * Useful if the Blueprint data has been updated and needs to be re-applied.
 */
router.post('/brain/blueprint/reload', async (req: Request, res: Response) => {
  try {
    const { tenantId } = z
      .object({ tenantId: z.string().uuid() })
      .parse(req.body);

    // Deactivate current snapshot
    await prisma.brainSnapshot.updateMany({
      where: { tenantId, status: 'active' },
      data: { status: 'archived' },
    });

    // Reload with latest Blueprint
    const result = await loadBlueprintForTenant(tenantId);

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'admin',
        actionType: 'brain.blueprint_reloaded',
        payload: {
          snapshotId: result.snapshotId,
          blueprintName: result.blueprintName,
        },
        reasoning: 'Admin triggered Blueprint reload',
      },
    });

    return res.json({
      status: 'reloaded',
      snapshotId: result.snapshotId,
      blueprintName: result.blueprintName,
      message: 'Blueprint reloaded. Previous snapshot archived.',
    });
  } catch (error: any) {
    console.error('Blueprint reload error:', error);
    return res.status(500).json({
      error: 'Failed to reload Blueprint',
      details: error.message,
    });
  }
});

/**
 * GET /brain/snapshot
 * Get the current brain snapshot for a tenant (used by Decision Engine).
 */
router.get('/brain/snapshot', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const snapshot = await prisma.brainSnapshot.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { version: 'desc' },
    });

    if (!snapshot) {
      return res.status(404).json({
        error: 'No active brain snapshot found',
        message: 'Brain snapshot is created during tenant provisioning.',
      });
    }

    return res.json({
      snapshot: {
        id: snapshot.id,
        version: snapshot.version,
        blueprintId: snapshot.blueprintId,
        status: snapshot.status,
        hasCompanyTruth: Object.keys(snapshot.companyTruth as any || {}).length > 0,
        hasBehavioralModel: Object.keys(snapshot.behavioralModel as any || {}).length > 0,
        hasOutcomeModel: Object.keys(snapshot.outcomeModel as any || {}).length > 0,
        metadata: snapshot.metadata,
        createdAt: snapshot.createdAt,
        updatedAt: snapshot.updatedAt,
      },
    });
  } catch (error: any) {
    console.error('Brain snapshot error:', error);
    return res.status(500).json({
      error: 'Failed to get brain snapshot',
      details: error.message,
    });
  }
});

export default router;
export { loadBlueprintForTenant, getBlueprintForTenant, GENERIC_BLUEPRINT };
export {
  BlueprintSchema,
  CustomerModelSchema,
  BuyerJourneySchema,
  KpiDefinitionSchema,
  ObjectionSchema,
  RevenueModelSchema,
  StrategyTemplateSchema,
};
export type {
  Blueprint,
  CustomerPersona,
  BuyerJourney,
  JourneyStage,
  KpiDefinition,
  Objection,
  RevenueModel,
  StrategyTemplate,
};
