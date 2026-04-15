/**
 * Onboarding Wizard — Brain Service
 * KAN-29: Build onboarding wizard with AI business analysis
 *
 * Subtasks:
 *   KAN-134: Build AI business analysis with Sonnet
 *   KAN-135: Generate AI model proposal
 *   KAN-136: Build 5-question validation flow API
 *   KAN-137: Implement go-live confirmation endpoint
 *
 * Creates a 5-question validation flow where AI analyzes ingested contact data
 * and proposes a business model for customer review. The tenant admin validates
 * and adjusts the AI-generated business context before going live.
 */

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { PrismaClient } from '@prisma/client';
import { loadBlueprintForTenant, getBlueprintForTenant, GENERIC_BLUEPRINT } from './blueprint-loader';

const router = Router();
const prisma = new PrismaClient();

// ━━ Zod Schemas ━━

const OnboardingStepSchema = z.enum([
  'company_basics',
  'customer_profile',
  'revenue_model',
  'sales_process',
  'goals_and_metrics',
]);
type OnboardingStep = z.infer<typeof OnboardingStepSchema>;

const CompanyBasicsSchema = z.object({
  companyName: z.string().min(1).max(200),
  industry: z.string().min(1).max(100),
  subIndustry: z.string().max(100).optional(),
  companySize: z.enum(['solo', '2-10', '11-50', '51-200', '201-500', '500+']),
  website: z.string().url().optional().or(z.literal('')),
  description: z.string().max(2000).optional(),
  yearFounded: z.number().int().min(1900).max(2030).optional(),
  headquarters: z.string().max(200).optional(),
});

const CustomerProfileSchema = z.object({
  targetMarket: z.enum(['b2b', 'b2c', 'b2b2c', 'mixed']),
  primaryPersonas: z.array(z.object({
    title: z.string().min(1).max(100),
    description: z.string().max(500).optional(),
    decisionMaker: z.boolean().default(false),
  })).min(1).max(10),
  averageDealSize: z.enum(['under_1k', '1k_10k', '10k_50k', '50k_100k', '100k_500k', '500k_plus']).optional(),
  salesCycleLength: z.enum(['instant', 'days', 'weeks', 'months', 'quarters', 'years']).optional(),
  geographicFocus: z.array(z.string()).optional(),
});

const RevenueModelSchema = z.object({
  primaryModel: z.enum(['subscription', 'one_time', 'service', 'marketplace', 'hybrid']),
  secondaryModels: z.array(z.string()).optional(),
  pricingTiers: z.array(z.object({
    name: z.string(),
    priceRange: z.string().optional(),
    description: z.string().optional(),
  })).optional(),
  averageContractValue: z.string().optional(),
  billingCycle: z.enum(['monthly', 'annual', 'per_project', 'usage_based', 'mixed']).optional(),
});

const SalesProcessSchema = z.object({
  primaryChannels: z.array(z.enum([
    'email', 'phone', 'sms', 'whatsapp', 'social_media',
    'website', 'in_person', 'referral', 'partner', 'marketplace',
  ])).min(1),
  currentTools: z.array(z.string()).optional(),
  teamSize: z.enum(['solo', '2-5', '6-15', '16-50', '50+']).optional(),
  existingCRM: z.string().max(100).optional(),
  biggestChallenge: z.string().max(1000).optional(),
});

const GoalsAndMetricsSchema = z.object({
  primaryObjective: z.enum([
    'increase_revenue',
    'reduce_churn',
    'improve_conversion',
    'automate_outreach',
    'better_insights',
    'scale_operations',
  ]),
  secondaryObjectives: z.array(z.string()).optional(),
  currentMonthlyRevenue: z.enum([
    'pre_revenue', 'under_10k', '10k_50k', '50k_200k',
    '200k_1m', '1m_plus',
  ]).optional(),
  targetGrowthRate: z.enum(['10_percent', '25_percent', '50_percent', '100_percent', 'more']).optional(),
  timeframe: z.enum(['1_month', '3_months', '6_months', '12_months']).optional(),
  keyMetrics: z.array(z.string()).optional(),
});

// Combined onboarding data
const OnboardingDataSchema = z.object({
  companyBasics: CompanyBasicsSchema.optional(),
  customerProfile: CustomerProfileSchema.optional(),
  revenueModel: RevenueModelSchema.optional(),
  salesProcess: SalesProcessSchema.optional(),
  goalsAndMetrics: GoalsAndMetricsSchema.optional(),
});
type OnboardingData = z.infer<typeof OnboardingDataSchema>;

// AI Proposal schema
const AIProposalSchema = z.object({
  companyTruth: z.object({
    industry: z.string(),
    subIndustry: z.string().optional(),
    companySize: z.string(),
    targetMarket: z.string(),
    valueProposition: z.string(),
    competitiveAdvantages: z.array(z.string()),
    products: z.array(z.object({
      name: z.string(),
      description: z.string(),
      priceRange: z.string().optional(),
    })),
    brandVoice: z.object({
      tone: z.string(),
      style: z.string(),
      keywords: z.array(z.string()),
    }),
  }),
  suggestedPersonas: z.array(z.object({
    name: z.string(),
    title: z.string(),
    description: z.string(),
    painPoints: z.array(z.string()),
    motivations: z.array(z.string()),
    preferredChannels: z.array(z.string()),
    decisionMaker: z.boolean(),
  })),
  suggestedObjectives: z.array(z.object({
    type: z.string(),
    name: z.string(),
    description: z.string(),
    successCondition: z.string(),
    suggestedStrategies: z.array(z.string()),
    estimatedImpact: z.enum(['low', 'medium', 'high']),
  })),
  suggestedChannels: z.array(z.object({
    channel: z.string(),
    priority: z.enum(['primary', 'secondary', 'experimental']),
    reasoning: z.string(),
  })),
  confidenceScore: z.number().min(0).max(100),
  reasoning: z.string(),
});
type AIProposal = z.infer<typeof AIProposalSchema>;

// ━━ AI Business Analysis (KAN-134) ━━

/**
 * Analyze business data using Claude Sonnet to understand the tenant's business.
 * Takes onboarding answers + any ingested contact data and produces analysis.
 */
async function analyzeBusinessWithAI(
  tenantId: string,
  onboardingData: OnboardingData
): Promise<{
  analysis: string;
  extractedInsights: Record<string, any>;
  confidence: number;
}> {
  // Gather any ingested contact data for richer analysis
  const contactCount = await prisma.contact.count({ where: { tenantId } });
  const recentContacts = await prisma.contact.findMany({
    where: { tenantId },
    take: 50,
    orderBy: { createdAt: 'desc' },
    select: {
      segment: true,
      lifecycleStage: true,
      dataQualityScore: true,
      metadata: true,
    },
  });

  // Build context for AI analysis
  const analysisContext = {
    onboarding: onboardingData,
    contactData: {
      totalContacts: contactCount,
      sampleContacts: recentContacts,
      segments: [...new Set(recentContacts.map((c) => c.segment).filter(Boolean))],
      lifecycleStages: [...new Set(recentContacts.map((c) => c.lifecycleStage).filter(Boolean))],
      avgDataQuality:
        recentContacts.length > 0
          ? recentContacts.reduce((sum, c) => sum + (c.dataQualityScore || 0), 0) / recentContacts.length
          : 0,
    },
  };

  // Build the analysis prompt
  const systemPrompt = `You are a business analyst AI for growth, an AI Revenue System.
Your job is to analyze a company's onboarding data and any existing contact data to produce
actionable business insights. Be specific, practical, and focused on revenue growth.

Respond in valid JSON with this structure:
{
  "analysis": "A comprehensive 2-3 paragraph analysis of the business",
  "extractedInsights": {
    "marketPosition": "string",
    "revenueOpportunities": ["string"],
    "riskFactors": ["string"],
    "quickWins": ["string"],
    "longTermPlays": ["string"],
    "competitiveInsights": "string",
    "channelRecommendations": {"channel": "reasoning"},
    "personaInsights": "string"
  },
  "confidence": number (0-100)
}`;

  const userPrompt = `Analyze this business data and provide strategic insights:

${JSON.stringify(analysisContext, null, 2)}

Focus on:
1. What revenue opportunities exist based on their market and model?
2. What are the most effective channels for their target market?
3. What quick wins can they achieve in the first 30 days?
4. What risks should the AI system watch for?`;

  try {
    // Call Claude Sonnet via Anthropic API
    const response = await callClaudeSonnet(systemPrompt, userPrompt);
    const parsed = JSON.parse(response);

    return {
      analysis: parsed.analysis || 'Analysis completed.',
      extractedInsights: parsed.extractedInsights || {},
      confidence: Math.min(100, Math.max(0, parsed.confidence || 60)),
    };
  } catch (error: any) {
    console.error('AI analysis error:', error);
    // Fallback: return basic analysis without AI
    return {
      analysis: `Business analysis for ${onboardingData.companyBasics?.companyName || 'this company'} in the ${onboardingData.companyBasics?.industry || 'general'} industry. ` +
        `Target market: ${onboardingData.customerProfile?.targetMarket || 'mixed'}. ` +
        `Primary revenue model: ${onboardingData.revenueModel?.primaryModel || 'subscription'}. ` +
        `AI analysis will improve as more data is ingested.`,
      extractedInsights: {
        marketPosition: 'To be determined with more data',
        revenueOpportunities: ['Optimize existing sales process', 'Expand channel reach'],
        riskFactors: ['Limited initial data for AI optimization'],
        quickWins: ['Set up automated welcome sequences', 'Configure lead scoring'],
        longTermPlays: ['Build comprehensive customer journey automation'],
      },
      confidence: 40,
    };
  }
}

// ━━ AI Model Proposal (KAN-135) ━━

/**
 * Generate an AI-powered business model proposal based on analysis.
 * This creates the initial Company Truth, suggested personas, objectives, and channels.
 */
async function generateAIProposal(
  tenantId: string,
  onboardingData: OnboardingData,
  analysisInsights: Record<string, any>
): Promise<AIProposal> {
  const systemPrompt = `You are a business strategist AI for growth, an AI Revenue System.
Based on the company's onboarding data and business analysis, generate a complete business model proposal.
This will become the foundation for the AI system's decision-making.

Respond in valid JSON matching this exact structure:
{
  "companyTruth": {
    "industry": "string",
    "subIndustry": "string (optional)",
    "companySize": "string",
    "targetMarket": "b2b|b2c|b2b2c|mixed",
    "valueProposition": "1-2 sentence value prop",
    "competitiveAdvantages": ["advantage1", "advantage2"],
    "products": [{"name": "string", "description": "string", "priceRange": "string"}],
    "brandVoice": {"tone": "string", "style": "string", "keywords": ["keyword1"]}
  },
  "suggestedPersonas": [
    {
      "name": "Persona Name",
      "title": "Job Title",
      "description": "2-3 sentence description",
      "painPoints": ["pain1", "pain2"],
      "motivations": ["motivation1"],
      "preferredChannels": ["email", "phone"],
      "decisionMaker": true|false
    }
  ],
  "suggestedObjectives": [
    {
      "type": "acquisition|retention|expansion|reactivation",
      "name": "Objective Name",
      "description": "What this achieves",
      "successCondition": "Measurable success criteria",
      "suggestedStrategies": ["strategy1", "strategy2"],
      "estimatedImpact": "low|medium|high"
    }
  ],
  "suggestedChannels": [
    {"channel": "email|sms|whatsapp|phone", "priority": "primary|secondary|experimental", "reasoning": "Why"}
  ],
  "confidenceScore": 75,
  "reasoning": "2-3 sentences explaining the proposal rationale"
}`;

  const userPrompt = `Generate a business model proposal for this company:

Onboarding Data:
${JSON.stringify(onboardingData, null, 2)}

Business Analysis Insights:
${JSON.stringify(analysisInsights, null, 2)}

Create a practical, actionable proposal that the AI Revenue System can immediately use.
Suggest 2-4 personas, 2-4 objectives, and 2-4 channels based on the data.`;

  try {
    const response = await callClaudeSonnet(systemPrompt, userPrompt);
    const parsed = JSON.parse(response);

    // Validate against schema
    return AIProposalSchema.parse(parsed);
  } catch (error: any) {
    console.error('AI proposal generation error:', error);
    // Fallback: generate a basic proposal from onboarding data
    return generateFallbackProposal(onboardingData);
  }
}

/**
 * Fallback proposal when AI is unavailable.
 */
function generateFallbackProposal(data: OnboardingData): AIProposal {
  const basics = data.companyBasics;
  const customer = data.customerProfile;
  const revenue = data.revenueModel;
  const sales = data.salesProcess;
  const goals = data.goalsAndMetrics;

  return {
    companyTruth: {
      industry: basics?.industry || 'General',
      subIndustry: basics?.subIndustry,
      companySize: basics?.companySize || '2-10',
      targetMarket: customer?.targetMarket || 'b2b',
      valueProposition: `${basics?.companyName || 'This company'} provides solutions in the ${basics?.industry || 'general'} industry.`,
      competitiveAdvantages: ['To be refined with more data'],
      products: [{
        name: 'Primary Product/Service',
        description: 'To be refined during onboarding',
        priceRange: revenue?.averageContractValue || 'Varies',
      }],
      brandVoice: {
        tone: 'professional',
        style: 'consultative',
        keywords: [basics?.industry || 'business', 'growth', 'results'],
      },
    },
    suggestedPersonas: (customer?.primaryPersonas || [{ title: 'Decision Maker', decisionMaker: true }]).map(
      (p, i) => ({
        name: `Persona ${i + 1}`,
        title: p.title,
        description: p.description || `Key ${p.decisionMaker ? 'decision maker' : 'stakeholder'} in the buying process.`,
        painPoints: ['Time constraints', 'Budget concerns', 'ROI uncertainty'],
        motivations: ['Efficiency gains', 'Revenue growth', 'Competitive advantage'],
        preferredChannels: sales?.primaryChannels?.slice(0, 2) || ['email'],
        decisionMaker: p.decisionMaker,
      })
    ),
    suggestedObjectives: [
      {
        type: 'acquisition',
        name: 'New Customer Acquisition',
        description: 'Convert leads into paying customers',
        successCondition: 'Lead converts to customer within sales cycle',
        suggestedStrategies: ['welcome_nurture', 'direct_outreach'],
        estimatedImpact: 'high',
      },
      {
        type: 'retention',
        name: 'Customer Retention',
        description: 'Keep existing customers engaged and renewed',
        successCondition: 'Customer renews or maintains engagement',
        suggestedStrategies: ['value_reinforcement', 'check_in_sequence'],
        estimatedImpact: 'high',
      },
    ],
    suggestedChannels: (sales?.primaryChannels || ['email']).map((ch, i) => ({
      channel: ch,
      priority: i === 0 ? 'primary' as const : 'secondary' as const,
      reasoning: `Selected based on onboarding preferences.`,
    })),
    confidenceScore: 35,
    reasoning: 'Basic proposal generated from onboarding data. Confidence will improve with AI analysis and more data.',
  };
}

// ━━ Claude Sonnet API Call ━━

/**
 * Call Claude Sonnet for AI analysis.
 * Uses Anthropic Messages API via environment-configured endpoint.
 */
async function callClaudeSonnet(
  systemPrompt: string,
  userPrompt: string,
  maxTokens: number = 4096
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY not configured');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const textBlock = data.content?.find((b: any) => b.type === 'text');
  if (!textBlock?.text) {
    throw new Error('No text response from Claude');
  }

  // Extract JSON from response (handle markdown code blocks)
  let text = textBlock.text.trim();
  const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    text = jsonMatch[1].trim();
  }

  return text;
}

// ━━ Onboarding State Management ━━

/**
 * Get or create onboarding session for a tenant.
 */
async function getOrCreateOnboardingSession(tenantId: string) {
  // Check for existing active session
  let session = await prisma.onboardingSession.findFirst({
    where: { tenantId, status: 'active' },
    orderBy: { createdAt: 'desc' },
  });

  if (!session) {
    session = await prisma.onboardingSession.create({
      data: {
        tenantId,
        status: 'active',
        currentStep: 'company_basics',
        completedSteps: [],
        onboardingData: {},
        aiAnalysis: null,
        aiProposal: null,
      },
    });
  }

  return session;
}

// ━━ API Routes ━━

/**
 * GET /onboarding/status
 * Get current onboarding status for a tenant.
 */
router.get('/onboarding/status', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const session = await getOrCreateOnboardingSession(tenantId);

    // Calculate progress
    const steps: OnboardingStep[] = [
      'company_basics',
      'customer_profile',
      'revenue_model',
      'sales_process',
      'goals_and_metrics',
    ];
    const completedSteps = (session.completedSteps as string[]) || [];
    const progress = Math.round((completedSteps.length / steps.length) * 100);

    return res.json({
      sessionId: session.id,
      status: session.status,
      currentStep: session.currentStep,
      completedSteps,
      totalSteps: steps.length,
      progress,
      hasAIAnalysis: !!session.aiAnalysis,
      hasAIProposal: !!session.aiProposal,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    });
  } catch (error: any) {
    console.error('Onboarding status error:', error);
    return res.status(500).json({ error: 'Failed to get onboarding status', details: error.message });
  }
});

/**
 * GET /onboarding/step/:step
 * Get the questions/form config for a specific onboarding step.
 */
router.get('/onboarding/step/:step', async (req: Request, res: Response) => {
  try {
    const step = OnboardingStepSchema.parse(req.params.step);
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const session = await getOrCreateOnboardingSession(tenantId);
    const existingData = (session.onboardingData as any)?.[step] || null;

    // Return step configuration with any existing data
    const stepConfig = getStepConfig(step);

    return res.json({
      step,
      config: stepConfig,
      existingData,
      isCompleted: ((session.completedSteps as string[]) || []).includes(step),
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Invalid step', validSteps: OnboardingStepSchema.options });
    }
    console.error('Onboarding step error:', error);
    return res.status(500).json({ error: 'Failed to get step config', details: error.message });
  }
});

/**
 * POST /onboarding/step/:step (KAN-136)
 * Submit answers for a specific onboarding step.
 * Validates input, stores data, advances to next step.
 */
router.post('/onboarding/step/:step', async (req: Request, res: Response) => {
  try {
    const step = OnboardingStepSchema.parse(req.params.step);
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    // Validate step data based on step type
    let validatedData: any;
    switch (step) {
      case 'company_basics':
        validatedData = CompanyBasicsSchema.parse(req.body);
        break;
      case 'customer_profile':
        validatedData = CustomerProfileSchema.parse(req.body);
        break;
      case 'revenue_model':
        validatedData = RevenueModelSchema.parse(req.body);
        break;
      case 'sales_process':
        validatedData = SalesProcessSchema.parse(req.body);
        break;
      case 'goals_and_metrics':
        validatedData = GoalsAndMetricsSchema.parse(req.body);
        break;
    }

    const session = await getOrCreateOnboardingSession(tenantId);
    const onboardingData = (session.onboardingData as any) || {};
    const completedSteps = (session.completedSteps as string[]) || [];

    // Update onboarding data
    onboardingData[step] = validatedData;
    if (!completedSteps.includes(step)) {
      completedSteps.push(step);
    }

    // Determine next step
    const steps: OnboardingStep[] = [
      'company_basics',
      'customer_profile',
      'revenue_model',
      'sales_process',
      'goals_and_metrics',
    ];
    const currentIndex = steps.indexOf(step);
    const nextStep = currentIndex < steps.length - 1 ? steps[currentIndex + 1] : null;
    const allComplete = completedSteps.length >= steps.length;

    // Update session
    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: {
        onboardingData,
        completedSteps,
        currentStep: nextStep || step,
        status: allComplete ? 'analysis_pending' : 'active',
      },
    });

    // If all steps complete, trigger AI analysis automatically
    let aiTriggered = false;
    if (allComplete) {
      // Fire and forget — AI analysis runs async
      triggerAIAnalysis(tenantId, session.id, onboardingData as OnboardingData).catch((err) =>
        console.error('Background AI analysis error:', err)
      );
      aiTriggered = true;
    }

    return res.json({
      step,
      status: 'saved',
      nextStep,
      allComplete,
      aiTriggered,
      progress: Math.round((completedSteps.length / steps.length) * 100),
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Onboarding step submit error:', error);
    return res.status(500).json({ error: 'Failed to save step', details: error.message });
  }
});

/**
 * POST /onboarding/analyze
 * Trigger AI analysis on current onboarding data (KAN-134 + KAN-135).
 * Can be called manually or automatically after all 5 steps complete.
 */
router.post('/onboarding/analyze', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const session = await getOrCreateOnboardingSession(tenantId);
    const onboardingData = session.onboardingData as OnboardingData;

    if (!onboardingData?.companyBasics) {
      return res.status(400).json({
        error: 'At least company basics must be completed before analysis',
      });
    }

    // Update status
    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: { status: 'analyzing' },
    });

    // Run AI analysis
    const analysis = await analyzeBusinessWithAI(tenantId, onboardingData);

    // Generate AI proposal
    const proposal = await generateAIProposal(tenantId, onboardingData, analysis.extractedInsights);

    // Store results
    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: {
        aiAnalysis: analysis as any,
        aiProposal: proposal as any,
        status: 'proposal_ready',
      },
    });

    // Audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'system',
        actionType: 'onboarding.ai_analysis_completed',
        payload: {
          sessionId: session.id,
          confidence: analysis.confidence,
          proposalConfidence: proposal.confidenceScore,
        },
        reasoning: 'AI business analysis and proposal generated from onboarding data',
      },
    });

    return res.json({
      status: 'proposal_ready',
      analysis: {
        summary: analysis.analysis,
        confidence: analysis.confidence,
        insights: analysis.extractedInsights,
      },
      proposal: {
        companyTruth: proposal.companyTruth,
        suggestedPersonas: proposal.suggestedPersonas,
        suggestedObjectives: proposal.suggestedObjectives,
        suggestedChannels: proposal.suggestedChannels,
        confidenceScore: proposal.confidenceScore,
        reasoning: proposal.reasoning,
      },
    });
  } catch (error: any) {
    console.error('AI analysis error:', error);
    return res.status(500).json({ error: 'Failed to run AI analysis', details: error.message });
  }
});

/**
 * GET /onboarding/proposal
 * Get the current AI-generated proposal for review.
 */
router.get('/onboarding/proposal', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const session = await getOrCreateOnboardingSession(tenantId);

    if (!session.aiProposal) {
      return res.status(404).json({
        error: 'No AI proposal available',
        message: 'Complete the onboarding steps and trigger analysis first.',
      });
    }

    return res.json({
      status: session.status,
      analysis: session.aiAnalysis,
      proposal: session.aiProposal,
    });
  } catch (error: any) {
    console.error('Proposal fetch error:', error);
    return res.status(500).json({ error: 'Failed to get proposal', details: error.message });
  }
});

/**
 * PUT /onboarding/proposal
 * Update/adjust the AI proposal before confirming.
 * Allows the admin to refine the AI's suggestions.
 */
router.put('/onboarding/proposal', async (req: Request, res: Response) => {
  try {
    const tenantId = req.query.tenantId as string;
    if (!tenantId) {
      return res.status(400).json({ error: 'tenantId query parameter required' });
    }

    const session = await getOrCreateOnboardingSession(tenantId);
    if (!session.aiProposal) {
      return res.status(404).json({ error: 'No proposal to update. Run analysis first.' });
    }

    // Merge updates into existing proposal
    const currentProposal = session.aiProposal as any;
    const updates = req.body;

    // Deep merge specific sections
    if (updates.companyTruth) {
      currentProposal.companyTruth = { ...currentProposal.companyTruth, ...updates.companyTruth };
    }
    if (updates.suggestedPersonas) {
      currentProposal.suggestedPersonas = updates.suggestedPersonas;
    }
    if (updates.suggestedObjectives) {
      currentProposal.suggestedObjectives = updates.suggestedObjectives;
    }
    if (updates.suggestedChannels) {
      currentProposal.suggestedChannels = updates.suggestedChannels;
    }

    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: { aiProposal: currentProposal },
    });

    // Audit the adjustment
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'admin',
        actionType: 'onboarding.proposal_adjusted',
        payload: { sessionId: session.id, adjustedFields: Object.keys(updates) },
        reasoning: 'Admin adjusted AI-generated proposal before go-live',
      },
    });

    return res.json({ status: 'updated', proposal: currentProposal });
  } catch (error: any) {
    console.error('Proposal update error:', error);
    return res.status(500).json({ error: 'Failed to update proposal', details: error.message });
  }
});

/**
 * POST /onboarding/go-live (KAN-137)
 * Confirm the proposal and activate the tenant's Brain.
 * This is the final onboarding step — it:
 * 1. Loads the Blueprint for the tenant
 * 2. Creates the initial Brain Snapshot with Company Truth
 * 3. Sets up initial objectives
 * 4. Marks tenant as onboarded
 * 5. Fires the brain.updated event
 */
router.post('/onboarding/go-live', async (req: Request, res: Response) => {
  try {
    const { tenantId } = z
      .object({ tenantId: z.string().uuid() })
      .parse(req.body);

    // Get onboarding session
    const session = await prisma.onboardingSession.findFirst({
      where: { tenantId, status: { in: ['proposal_ready', 'analyzing', 'analysis_pending'] } },
      orderBy: { createdAt: 'desc' },
    });

    if (!session) {
      return res.status(400).json({
        error: 'No ready onboarding session found',
        message: 'Complete onboarding steps and AI analysis before going live.',
      });
    }

    const proposal = session.aiProposal as any;
    if (!proposal) {
      return res.status(400).json({
        error: 'No AI proposal found. Run analysis first.',
      });
    }

    // 1. Load Blueprint for tenant (if not already loaded)
    let blueprint = await getBlueprintForTenant(tenantId);
    if (!blueprint) {
      await loadBlueprintForTenant(tenantId);
      blueprint = await getBlueprintForTenant(tenantId);
    }

    // 2. Update Brain Snapshot with Company Truth from proposal
    const activeSnapshot = await prisma.brainSnapshot.findFirst({
      where: { tenantId, status: 'active' },
      orderBy: { version: 'desc' },
    });

    if (activeSnapshot) {
      await prisma.brainSnapshot.update({
        where: { id: activeSnapshot.id },
        data: {
          companyTruth: proposal.companyTruth,
          metadata: {
            ...(activeSnapshot.metadata as any || {}),
            onboardingCompleted: true,
            onboardingSessionId: session.id,
            onboardingCompletedAt: new Date().toISOString(),
            proposalConfidence: proposal.confidenceScore,
          },
        },
      });
    }

    // 3. Create initial objectives from proposal
    const createdObjectives: string[] = [];
    for (const obj of proposal.suggestedObjectives || []) {
      const created = await prisma.objective.create({
        data: {
          tenantId,
          type: obj.type,
          name: obj.name,
          description: obj.description,
          successCondition: { condition: obj.successCondition },
          subObjectives: obj.suggestedStrategies.map((s: string, i: number) => ({
            id: `sub_${i}`,
            name: s,
            status: 'active',
          })),
          status: 'active',
        },
      });
      createdObjectives.push(created.id);
    }

    // 4. Mark tenant as onboarded
    await prisma.tenant.update({
      where: { id: tenantId },
      data: {
        onboardingCompleted: true,
        onboardingCompletedAt: new Date(),
      },
    });

    // 5. Mark onboarding session as complete
    await prisma.onboardingSession.update({
      where: { id: session.id },
      data: { status: 'completed' },
    });

    // 6. Audit log
    await prisma.auditLog.create({
      data: {
        tenantId,
        actor: 'admin',
        actionType: 'onboarding.go_live',
        payload: {
          sessionId: session.id,
          objectivesCreated: createdObjectives.length,
          proposalConfidence: proposal.confidenceScore,
          channelsConfigured: proposal.suggestedChannels?.length || 0,
        },
        reasoning: 'Tenant confirmed AI proposal and went live. Brain activated.',
      },
    });

    // 7. Publish brain.updated event (Pub/Sub integration point)
    // TODO: Publish to Pub/Sub topic 'brain.updated' when Pub/Sub is configured
    console.log(`[Pub/Sub Placeholder] brain.updated for tenant ${tenantId}`);

    return res.json({
      status: 'live',
      message: 'Onboarding complete. Your AI Revenue System is now active.',
      summary: {
        companyTruth: !!proposal.companyTruth,
        personasConfigured: proposal.suggestedPersonas?.length || 0,
        objectivesCreated: createdObjectives.length,
        channelsConfigured: proposal.suggestedChannels?.length || 0,
        blueprintLoaded: !!blueprint,
        brainActivated: true,
      },
    });
  } catch (error: any) {
    if (error instanceof z.ZodError) {
      return res.status(400).json({ error: 'Validation failed', details: error.errors });
    }
    console.error('Go-live error:', error);
    return res.status(500).json({ error: 'Failed to go live', details: error.message });
  }
});

// ━━ Helper: Background AI Analysis ━━

async function triggerAIAnalysis(
  tenantId: string,
  sessionId: string,
  onboardingData: OnboardingData
): Promise<void> {
  try {
    await prisma.onboardingSession.update({
      where: { id: sessionId },
      data: { status: 'analyzing' },
    });

    const analysis = await analyzeBusinessWithAI(tenantId, onboardingData);
    const proposal = await generateAIProposal(tenantId, onboardingData, analysis.extractedInsights);

    await prisma.onboardingSession.update({
      where: { id: sessionId },
      data: {
        aiAnalysis: analysis as any,
        aiProposal: proposal as any,
        status: 'proposal_ready',
      },
    });

    console.log(`AI analysis completed for tenant ${tenantId}, confidence: ${analysis.confidence}`);
  } catch (error) {
    console.error(`Background AI analysis failed for tenant ${tenantId}:`, error);
    await prisma.onboardingSession.update({
      where: { id: sessionId },
      data: { status: 'analysis_failed' },
    });
  }
}

// ━━ Helper: Step Configuration ━━

function getStepConfig(step: OnboardingStep) {
  const configs: Record<OnboardingStep, any> = {
    company_basics: {
      title: 'Tell us about your company',
      description: 'Basic information to help the AI understand your business context.',
      fields: [
        { name: 'companyName', label: 'Company Name', type: 'text', required: true },
        { name: 'industry', label: 'Industry', type: 'text', required: true },
        { name: 'subIndustry', label: 'Sub-Industry', type: 'text', required: false },
        {
          name: 'companySize',
          label: 'Company Size',
          type: 'select',
          required: true,
          options: ['solo', '2-10', '11-50', '51-200', '201-500', '500+'],
        },
        { name: 'website', label: 'Website URL', type: 'url', required: false },
        { name: 'description', label: 'Brief Description', type: 'textarea', required: false },
      ],
    },
    customer_profile: {
      title: 'Who are your customers?',
      description: 'Help the AI understand who you sell to and how they buy.',
      fields: [
        {
          name: 'targetMarket',
          label: 'Target Market',
          type: 'select',
          required: true,
          options: ['b2b', 'b2c', 'b2b2c', 'mixed'],
        },
        {
          name: 'primaryPersonas',
          label: 'Key Customer Personas',
          type: 'persona_list',
          required: true,
          description: 'Add the main types of people you sell to.',
        },
        {
          name: 'averageDealSize',
          label: 'Average Deal Size',
          type: 'select',
          required: false,
          options: ['under_1k', '1k_10k', '10k_50k', '50k_100k', '100k_500k', '500k_plus'],
        },
        {
          name: 'salesCycleLength',
          label: 'Typical Sales Cycle',
          type: 'select',
          required: false,
          options: ['instant', 'days', 'weeks', 'months', 'quarters', 'years'],
        },
      ],
    },
    revenue_model: {
      title: 'How do you make money?',
      description: 'Your revenue model shapes how the AI optimizes for growth.',
      fields: [
        {
          name: 'primaryModel',
          label: 'Primary Revenue Model',
          type: 'select',
          required: true,
          options: ['subscription', 'one_time', 'service', 'marketplace', 'hybrid'],
        },
        { name: 'averageContractValue', label: 'Average Contract Value', type: 'text', required: false },
        {
          name: 'billingCycle',
          label: 'Billing Cycle',
          type: 'select',
          required: false,
          options: ['monthly', 'annual', 'per_project', 'usage_based', 'mixed'],
        },
        {
          name: 'pricingTiers',
          label: 'Pricing Tiers',
          type: 'tier_list',
          required: false,
          description: 'Add your pricing tiers if applicable.',
        },
      ],
    },
    sales_process: {
      title: 'How do you sell today?',
      description: 'Current tools and channels help the AI integrate seamlessly.',
      fields: [
        {
          name: 'primaryChannels',
          label: 'Communication Channels',
          type: 'multi_select',
          required: true,
          options: [
            'email', 'phone', 'sms', 'whatsapp', 'social_media',
            'website', 'in_person', 'referral', 'partner', 'marketplace',
          ],
        },
        { name: 'existingCRM', label: 'Current CRM', type: 'text', required: false },
        {
          name: 'teamSize',
          label: 'Sales Team Size',
          type: 'select',
          required: false,
          options: ['solo', '2-5', '6-15', '16-50', '50+'],
        },
        { name: 'biggestChallenge', label: 'Biggest Sales Challenge', type: 'textarea', required: false },
      ],
    },
    goals_and_metrics: {
      title: 'What do you want to achieve?',
      description: 'Your goals define what the AI optimizes for.',
      fields: [
        {
          name: 'primaryObjective',
          label: 'Primary Goal',
          type: 'select',
          required: true,
          options: [
            'increase_revenue', 'reduce_churn', 'improve_conversion',
            'automate_outreach', 'better_insights', 'scale_operations',
          ],
        },
        {
          name: 'currentMonthlyRevenue',
          label: 'Current Monthly Revenue',
          type: 'select',
          required: false,
          options: ['pre_revenue', 'under_10k', '10k_50k', '50k_200k', '200k_1m', '1m_plus'],
        },
        {
          name: 'targetGrowthRate',
          label: 'Target Growth Rate',
          type: 'select',
          required: false,
          options: ['10_percent', '25_percent', '50_percent', '100_percent', 'more'],
        },
        {
          name: 'timeframe',
          label: 'Timeframe',
          type: 'select',
          required: false,
          options: ['1_month', '3_months', '6_months', '12_months'],
        },
      ],
    },
  };

  return configs[step];
}

export default router;
export {
  analyzeBusinessWithAI,
  generateAIProposal,
  generateFallbackProposal,
  callClaudeSonnet,
  getOrCreateOnboardingSession,
};
export {
  OnboardingStepSchema,
  CompanyBasicsSchema,
  CustomerProfileSchema,
  RevenueModelSchema,
  SalesProcessSchema,
  GoalsAndMetricsSchema,
  OnboardingDataSchema,
  AIProposalSchema,
};
export type { OnboardingStep, OnboardingData, AIProposal };
