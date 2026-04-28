/**
 * KAN-738 — Sprint 3 / S3.1 agentic loop seam.
 *
 * Third option (after playbook + rules-based free-form) in the Decision Engine
 * dispatch. Runs an Anthropic tool-use loop with Sonnet 4.6 reasoning tier
 * and a 5-tool stub surface. KAN-739 (S3.2) will replace the stub handlers
 * with real tenant-scoped + audit-logged implementations — the dispatch loop
 * itself stays in this file unchanged.
 *
 * Today (S3.1): tools dispatch returns `{ stub: true }`. That's enough to
 * exercise the multi-turn tool-use loop end-to-end without leaking real
 * tenant data into the LLM context yet.
 *
 * Cost-tracking: each Anthropic call publishes one llm.call event via the
 * existing setLLMCostPublisher wiring in llm-client.ts. KAN-745 (filed at
 * KAN-738 PR open) tracks the observability layer that will alert on
 * cost-doubling under shadow mode.
 */
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import type { DecisionPayload } from "@growth/shared";

const SONNET_4_6_MODEL = "claude-sonnet-4-6";
const MAX_TOOL_USE_ITERATIONS = 8;
const DEFAULT_MAX_TOKENS = 2048;

// ─────────────────────────────────────────────
// Stub tool surface (KAN-739 swaps handlers; schemas + names freeze here)
// ─────────────────────────────────────────────

export interface ToolDescriptor {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /** KAN-739 replaces this with the real handler. */
  handler: (input: unknown, ctx: ToolHandlerContext) => Promise<unknown>;
}

export interface ToolHandlerContext {
  tenantId: string;
  contactId: string;
  /**
   * Records a tool call for KAN-739 audit logging. KAN-738 stub leaves this
   * as a no-op; KAN-739 wires it to AuditLog inserts.
   */
  recordToolCall: (toolName: string, latencyMs: number, resultBytes: number) => void;
}

const stubHandler = async (
  _input: unknown,
  _ctx: ToolHandlerContext,
): Promise<{ stub: true; message: string }> => ({
  stub: true,
  message: "tool implementation lands in KAN-739",
});

export const AGENTIC_TOOLS: ToolDescriptor[] = [
  {
    name: "get_contact_context",
    description:
      "Read the full context for a contact: profile, pipeline state, recent decisions, outcomes, micro-objective progress.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", format: "uuid" },
      },
      required: ["contactId"],
    },
    handler: stubHandler,
  },
  {
    name: "retrieve_knowledge",
    description:
      "Retrieve top-K relevant knowledge chunks for a query. Optional pipelineId filters via the per-pipeline knowledge filter.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pipelineId: { type: "string", format: "uuid" },
      },
      required: ["query"],
    },
    handler: stubHandler,
  },
  {
    name: "get_pipeline_state",
    description: "Read pipeline configuration: name, objective, stages, targets vs progress, micro-objectives.",
    input_schema: {
      type: "object",
      properties: { pipelineId: { type: "string", format: "uuid" } },
      required: ["pipelineId"],
    },
    handler: stubHandler,
  },
  {
    name: "get_recent_actions",
    description:
      "Last N (default 10, max 50) actions for a contact, ordered most-recent-first. Returns action type, channel, outcome, createdAt.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", format: "uuid" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["contactId"],
    },
    handler: stubHandler,
  },
  {
    name: "get_objective_progress",
    description: "Per-contact micro-objective completion state: list of (microObjectiveId, name, isCompleted, completedAt).",
    input_schema: {
      type: "object",
      properties: { contactId: { type: "string", format: "uuid" } },
      required: ["contactId"],
    },
    handler: stubHandler,
  },
];

// ─────────────────────────────────────────────
// Anthropic client (lazy + test-injectable)
// ─────────────────────────────────────────────

let _anthropic: Anthropic | null = null;
function anthropicClient(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic();
  return _anthropic;
}

/** Test seam — replace SDK with a mock. */
export function __setAnthropicClientForTest(client: Anthropic | null): void {
  _anthropic = client;
}

// ─────────────────────────────────────────────
// Runner
// ─────────────────────────────────────────────

export interface RunAgenticInput {
  tenantId: string;
  contactId: string;
  /** Tools available to the agent. Defaults to AGENTIC_TOOLS. KAN-739 pre-PR can pass real tools here. */
  tools?: ToolDescriptor[];
  /** Optional override — defaults to Sonnet 4.6 reasoning tier. */
  model?: string;
}

export interface RunAgenticResult {
  payload: DecisionPayload;
  /** Number of tool-use iterations the agent went through. */
  iterations: number;
  latencyMs: number;
}

/**
 * Run the agentic loop. Returns a DecisionPayload matching the shape
 * runFreeform produces, so divergence comparison is a structural diff.
 *
 * Throws on Anthropic API errors — caller (runShadow / runAgentic dispatch)
 * is responsible for catching and recording 'agentic_error' divergence.
 */
export async function runAgenticLoop(
  input: RunAgenticInput,
): Promise<RunAgenticResult> {
  const started = Date.now();
  const tools = input.tools ?? AGENTIC_TOOLS;
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const model = input.model ?? SONNET_4_6_MODEL;

  const ctx: ToolHandlerContext = {
    tenantId: input.tenantId,
    contactId: input.contactId,
    recordToolCall: () => {
      // KAN-739 wires AuditLog persistence here.
    },
  };

  const systemPrompt = buildSystemPrompt(input);
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Decide the next action for contact ${input.contactId} in tenant ${input.tenantId}. Use the tools to read context, then output your final decision as JSON matching this schema: { "strategy": string, "action": { "type": string, "channel": string | null, "payload": object }, "confidence": number (0..1), "outcome": "EXECUTED" | "ESCALATED", "reasoning": string }.`,
    },
  ];

  let iterations = 0;
  for (let i = 0; i < MAX_TOOL_USE_ITERATIONS; i++) {
    iterations++;
    const resp = await anthropicClient().messages.create({
      model,
      max_tokens: DEFAULT_MAX_TOKENS,
      system: systemPrompt,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.input_schema as Anthropic.Tool.InputSchema,
      })),
      messages,
    });

    if (resp.stop_reason === "end_turn" || resp.stop_reason === "stop_sequence") {
      const textBlock = resp.content.find((b) => b.type === "text");
      if (!textBlock || textBlock.type !== "text") {
        throw new Error(`agentic loop ended without text payload (stop_reason=${resp.stop_reason})`);
      }
      const payload = parseFinalDecision(textBlock.text);
      return { payload, iterations, latencyMs: Date.now() - started };
    }

    if (resp.stop_reason !== "tool_use") {
      throw new Error(`agentic loop unexpected stop_reason=${resp.stop_reason}`);
    }

    // Append assistant turn (with tool_use blocks) and a user turn with tool_result blocks.
    messages.push({ role: "assistant", content: resp.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of resp.content) {
      if (block.type !== "tool_use") continue;
      const tool = toolByName.get(block.name);
      if (!tool) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ error: `unknown tool: ${block.name}` }),
          is_error: true,
        });
        continue;
      }
      const callStart = Date.now();
      try {
        const result = await tool.handler(block.input, ctx);
        const json = JSON.stringify(result);
        ctx.recordToolCall(tool.name, Date.now() - callStart, json.length);
        toolResults.push({ type: "tool_result", tool_use_id: block.id, content: json });
      } catch (err) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify({ error: (err as Error)?.message ?? "tool handler failed" }),
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: toolResults });
  }

  throw new Error(`agentic loop exceeded ${MAX_TOOL_USE_ITERATIONS} iterations without final decision`);
}

function buildSystemPrompt(_input: RunAgenticInput): string {
  return [
    "You are the agentic decision engine for the AxisOne growth platform.",
    "Your job: decide the next best action for a contact based on their pipeline, recent activity, and tenant knowledge.",
    "You have access to read-only tools — call them as needed to gather context.",
    "All decisions are tenant-scoped: only consider data from the calling tenant.",
    "Output your final decision as a single JSON object matching the schema in the user message. Do not include any other prose in your final turn.",
  ].join(" ");
}

function parseFinalDecision(text: string): DecisionPayload {
  // The model may wrap JSON in code fences or include a brief preamble. Be
  // tolerant — extract the first balanced JSON object.
  const trimmed = text.trim();
  const jsonStart = trimmed.indexOf("{");
  const jsonEnd = trimmed.lastIndexOf("}");
  if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
    throw new Error(`agentic final turn did not contain JSON object: ${trimmed.slice(0, 200)}`);
  }
  const raw = trimmed.slice(jsonStart, jsonEnd + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`agentic final turn JSON parse failed: ${(err as Error).message}`);
  }
  const obj = parsed as Record<string, unknown>;
  // Loose validation — the LLM is generally well-behaved on Sonnet 4.6 with
  // explicit schema in the prompt. Strict zod parse would also be reasonable;
  // KAN-739 adds it once the contract stabilizes.
  return {
    strategy: typeof obj.strategy === "string" ? obj.strategy : "agentic_loop",
    action: {
      type: ((obj.action as Record<string, unknown>)?.type ?? "no_op") as string,
      channel: ((obj.action as Record<string, unknown>)?.channel ?? null) as string | null,
      payload: ((obj.action as Record<string, unknown>)?.payload ?? {}) as Record<string, unknown>,
    },
    confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
    outcome: obj.outcome === "ESCALATED" ? "ESCALATED" : "EXECUTED",
    reasoning: typeof obj.reasoning === "string" ? obj.reasoning : "",
  };
}

/** Helper for callers that need to coerce the final decision UUID-side reasoning string. */
export function uniqueAgenticEventId(): string {
  return `agentic_${randomUUID()}`;
}
