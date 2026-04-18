import Anthropic from "@anthropic-ai/sdk";

// ============================================================================
// MODEL CONSTANTS — per growth architecture spec
// ============================================================================
export const MODELS = {
  // Strategy selection, message generation, Brain synthesis — quality-critical
  SONNET: "claude-sonnet-4-20250514",
  // Intent classification, confidence scoring, field mapping — fast + cheap
  HAIKU: "claude-haiku-4-5-20251001",
} as const;

// ============================================================================
// CLIENT SINGLETON — lazy init, reads ANTHROPIC_API_KEY from env
// ============================================================================
let _client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY environment variable is not set. " +
        "Mount it from GCP Secret Manager via Cloud Run --set-secrets."
      );
    }
    _client = new Anthropic({ apiKey });
  }
  return _client;
}

// ============================================================================
// CORE AI METHODS
// ============================================================================

/**
 * Generate a customer-facing message (Communication Agent)
 * Uses Sonnet — quality is non-negotiable for outbound comms.
 */
export async function generateMessage(opts: {
  contactName: string;
  objective: string;
  context: string;
  channel: "email" | "sms" | "whatsapp";
  tone?: string;
}): Promise<{
  message: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const client = getClient();

  const channelConstraint =
    opts.channel === "sms"
      ? "Keep the message under 160 characters."
      : opts.channel === "whatsapp"
      ? "Keep the message concise, under 500 characters."
      : "Keep the message concise but complete. Use a professional email format.";

  const response = await client.messages.create({
    model: MODELS.SONNET,
    max_tokens: 1024,
    system: [
      "You are an AI sales assistant for a revenue automation platform.",
      `Generate a ${opts.channel} message for the contact.`,
      `Tone: ${opts.tone || "professional and friendly"}.`,
      channelConstraint,
      "Output ONLY the message text — no subject lines, no metadata, no quotes.",
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: `Contact: ${opts.contactName}\nObjective: ${opts.objective}\nContext: ${opts.context}\n\nGenerate the message.`,
      },
    ],
  });

  const text =
    response.content[0].type === "text" ? response.content[0].text : "";

  return {
    message: text.trim(),
    model: MODELS.SONNET,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

/**
 * Classify inbound message intent (Ingestion Service)
 * Uses Haiku — high-volume, low-latency.
 */
export async function classifyIntent(
  text: string
): Promise<{
  intent: string;
  confidence: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const client = getClient();

  const response = await client.messages.create({
    model: MODELS.HAIKU,
    max_tokens: 256,
    system: [
      "Classify the intent of the following message.",
      "Respond in valid JSON only, no markdown:",
      '{"intent": "<one of: inquiry, purchase, support, complaint, scheduling, referral, unsubscribe, other>", "confidence": <0.0-1.0>}',
    ].join("\n"),
    messages: [{ role: "user", content: text }],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "{}";

  try {
    const parsed = JSON.parse(raw);
    return {
      intent: parsed.intent || "other",
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0,
      model: MODELS.HAIKU,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch {
    return {
      intent: "other",
      confidence: 0,
      model: MODELS.HAIKU,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

/**
 * Score confidence for a proposed action (Decision Engine)
 * Uses Haiku — scalar output, needs to be fast.
 */
export async function scoreConfidence(opts: {
  contactData: string;
  objective: string;
  proposedAction: string;
}): Promise<{
  score: number;
  reasoning: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const client = getClient();

  const response = await client.messages.create({
    model: MODELS.HAIKU,
    max_tokens: 256,
    system: [
      "Score the confidence (0-100) that the proposed action will achieve the objective for this contact.",
      "Respond in valid JSON only, no markdown:",
      '{"score": <0-100>, "reasoning": "<brief one-sentence explanation>"}',
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: `Contact data: ${opts.contactData}\nObjective: ${opts.objective}\nProposed action: ${opts.proposedAction}`,
      },
    ],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "{}";

  try {
    const parsed = JSON.parse(raw);
    return {
      score: typeof parsed.score === "number" ? parsed.score : 0,
      reasoning: parsed.reasoning || "",
      model: MODELS.HAIKU,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch {
    return {
      score: 0,
      reasoning: "Failed to parse AI response",
      model: MODELS.HAIKU,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

/**
 * Select the best strategy for a contact (Decision Engine)
 * Uses Sonnet — deep reasoning over complex context.
 */
export async function selectStrategy(opts: {
  contactContext: string;
  objectiveGap: string;
  availableStrategies: string[];
}): Promise<{
  strategy: string;
  reasoning: string;
  nextAction: string;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}> {
  const client = getClient();

  const response = await client.messages.create({
    model: MODELS.SONNET,
    max_tokens: 512,
    system: [
      "You are the Decision Engine for an AI Revenue System.",
      "Given a contact's context and objective gap, select the best strategy and determine the single best next action.",
      "Respond in valid JSON only, no markdown:",
      '{"strategy": "<selected strategy>", "reasoning": "<why this strategy fits>", "nextAction": "<specific next action to take>"}',
    ].join("\n"),
    messages: [
      {
        role: "user",
        content: `Contact context: ${opts.contactContext}\nObjective gap: ${opts.objectiveGap}\nAvailable strategies: ${opts.availableStrategies.join(", ")}`,
      },
    ],
  });

  const raw =
    response.content[0].type === "text" ? response.content[0].text : "{}";

  try {
    const parsed = JSON.parse(raw);
    return {
      strategy: parsed.strategy || "",
      reasoning: parsed.reasoning || "",
      nextAction: parsed.nextAction || "",
      model: MODELS.SONNET,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  } catch {
    return {
      strategy: "",
      reasoning: "Failed to parse AI response",
      nextAction: "",
      model: MODELS.SONNET,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}

/**
 * Health check — lightweight ping to verify API key and connectivity.
 */
export async function healthCheck(): Promise<{
  status: "ok" | "error";
  model: string;
  latencyMs: number;
  error?: string;
}> {
  const start = Date.now();
  try {
    const client = getClient();
    await client.messages.create({
      model: MODELS.HAIKU,
      max_tokens: 16,
      messages: [{ role: "user", content: "Respond with exactly: ok" }],
    });
    return {
      status: "ok",
      model: MODELS.HAIKU,
      latencyMs: Date.now() - start,
    };
  } catch (err: any) {
    return {
      status: "error",
      model: MODELS.HAIKU,
      latencyMs: Date.now() - start,
      error: err.message || String(err),
    };
  }
}
