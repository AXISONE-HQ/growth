import Anthropic from "@anthropic-ai/sdk";

// Initialize Anthropic client — uses ANTHROPIC_API_KEY env var
const anthropic = new Anthropic();

const SONNET_MODEL = "claude-sonnet-4-20250514";
const HAIKU_MODEL = "claude-haiku-4-5-20251001";

// ============================================================================
// SALES OBJECTION RESPONSE GENERATION
// ============================================================================

interface GenerateObjectionResponseInput {
  objectionText: string;
  category: string;
  companyContext?: {
    vision?: string;
    mission?: string;
    products?: Array<{ name: string; description?: string; price?: string }>;
  };
}

interface ObjectionResponseOutput {
  recommendedResponse: string;
  talkTrack: string;
  keyDifferentiators: string;
}

export async function generateObjectionResponses(
  input: GenerateObjectionResponseInput
): Promise<ObjectionResponseOutput> {
  const { objectionText, category, companyContext } = input;

  // Build context block from company data if available
  let contextBlock = "";
  if (companyContext) {
    const parts: string[] = [];
    if (companyContext.vision) parts.push(`Vision: ${companyContext.vision}`);
    if (companyContext.mission) parts.push(`Mission: ${companyContext.mission}`);
    if (companyContext.products?.length) {
      const productList = companyContext.products
        .map((p) => `- ${p.name}${p.price ? ` ($${p.price})` : ""}${p.description ? `: ${p.description}` : ""}`)
        .join("\n");
      parts.push(`Products:\n${productList}`);
    }
    if (parts.length > 0) {
      contextBlock = `\n\nCompany Context:\n${parts.join("\n")}`;
    }
  }

  const systemPrompt = `You are a senior sales enablement AI for an AI Revenue System platform called growth. Your job is to generate high-quality sales objection handling content that helps sales teams win deals.

You must respond with ONLY valid JSON in the exact format specified. No markdown, no code fences, no extra text.`;

  const userPrompt = `Generate three pieces of content to help handle the following sales objection:

Objection: "${objectionText}"
Category: ${category}${contextBlock}

Respond with a JSON object containing these three fields:

1. "recommendedResponse" — A natural, empathetic AI-recommended response (2-4 sentences). Acknowledge the concern, reframe the value, and provide a concrete proof point or next step. Sound human, not scripted.

2. "talkTrack" — A numbered step-by-step talk track (5 steps). Each step should be a concise action: e.g., "1) Acknowledge the concern genuinely. 2) Shift from price to value...". Keep it practical and actionable.

3. "keyDifferentiators" — 3-5 bullet points that directly counter this objection. Each should highlight a specific competitive advantage. Format as a single string with bullet points separated by newlines, each starting with "•".

Return ONLY the JSON object, no markdown formatting.`;

  const message = await anthropic.messages.create({
    model: SONNET_MODEL,
    max_tokens: 1024,
    messages: [
      {
        role: "user",
        content: userPrompt,
      },
    ],
    system: systemPrompt,
  });

  // Extract text content
  const textContent = message.content.find((c) => c.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from LLM");
  }

  // Parse JSON response — strip any accidental markdown fences
  let jsonStr = textContent.text.trim();
  if (jsonStr.startsWith("```")) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
  }

  try {
    const parsed = JSON.parse(jsonStr) as ObjectionResponseOutput;

    // Validate required fields
    if (!parsed.recommendedResponse || !parsed.talkTrack || !parsed.keyDifferentiators) {
      throw new Error("Missing required fields in LLM response");
    }

    return parsed;
  } catch (e) {
    console.error("Failed to parse LLM response:", jsonStr);
    throw new Error(`Failed to parse LLM response: ${(e as Error).message}`);
  }
}

// ============================================================================
// SINGLE FIELD REGENERATION
// ============================================================================

export async function regenerateSingleField(
  objectionText: string,
  category: string,
  fieldName: string,
  currentContent?: string
): Promise<string> {
  const fieldDescriptions: Record<string, string> = {
    recommendedResponse:
      "A natural, empathetic AI-recommended response (2-4 sentences). Acknowledge the concern, reframe the value, and provide a concrete proof point or next step.",
    talkTrack:
      "A numbered step-by-step talk track (5 steps). Each step should be a concise action.",
    keyDifferentiators:
      "3-5 bullet points that directly counter this objection. Each should highlight a specific competitive advantage. Format with bullet points starting with '•'.",
  };

  const fieldDesc = fieldDescriptions[fieldName] || "Generate appropriate content for this field.";

  const systemPrompt = `You are a senior sales enablement AI. Generate ONLY the requested content, no JSON wrapping, no markdown formatting, just the plain text content.`;

  const userPrompt = `Regenerate the "${fieldName}" content for handling this sales objection:

Objection: "${objectionText}"
Category: ${category}
${currentContent ? `\nPrevious version (generate something different and better):\n${currentContent}` : ""}

Requirements: ${fieldDesc}

Respond with ONLY the content text, nothing else.`;

  const message = await anthropic.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 512,
    messages: [{ role: "user", content: userPrompt }],
    system: systemPrompt,
  });

  const textContent = message.content.find((c) => c.type === "text");
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from LLM");
  }

  return textContent.text.trim();
}
