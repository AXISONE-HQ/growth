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
import type { PrismaClient } from "@prisma/client";
import {
  type DecisionPayload,
  TOOL_NAMES,
  TOOL_SCHEMAS,
  type ToolName,
} from "@growth/shared";

const SONNET_4_6_MODEL = "claude-sonnet-4-6";
const MAX_TOOL_USE_ITERATIONS = 8;
const DEFAULT_MAX_TOKENS = 2048;
const INPUT_SNIPPET_CAP = 500;

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
  message: "tool implementation requires prisma in RunAgenticInput (KAN-739)",
});

/**
 * Build ToolDescriptor[] from canonical TOOL_SCHEMAS in @growth/shared.
 * Pass `prisma` to wire real handlers (KAN-739); omit for stub handlers
 * (KAN-738 unit tests + dispatch sites without DB access).
 */
export function buildAgenticTools(prisma?: PrismaClient): ToolDescriptor[] {
  return TOOL_NAMES.map((name) => ({
    name,
    description: TOOL_SCHEMAS[name].description,
    input_schema: TOOL_SCHEMAS[name].input_schema as Record<string, unknown>,
    handler: prisma ? wrapRealHandler(name, prisma) : stubHandler,
  }));
}

/**
 * Backwards-compatible export — frozen stub surface for KAN-738 tests that
 * inject AGENTIC_TOOLS directly. New call sites should use buildAgenticTools(prisma).
 */
export const AGENTIC_TOOLS: ToolDescriptor[] = buildAgenticTools();

// ─────────────────────────────────────────────
// Real handler dispatch (KAN-739 — variable-specifier dynamic import keeps
// agentic-tools.ts out of apps/api static graph; same TS6059 hygiene pattern
// as run-decision-for-contact.ts:loadAgenticLoop).
// ─────────────────────────────────────────────

interface AgenticToolsModule {
  REAL_HANDLERS: Record<
    ToolName,
    (input: unknown, ctx: { prisma: PrismaClient; tenantId: string; contactId: string }) => Promise<unknown>
  >;
  writeToolCallAudit: (
    prisma: PrismaClient,
    row: {
      tenantId: string;
      contactId: string;
      toolName: string;
      latencyMs: number;
      resultBytes: number;
      inputSnippet: string;
    },
  ) => Promise<void>;
}

let _agenticToolsMod: AgenticToolsModule | null = null;
async function loadAgenticToolsModule(): Promise<AgenticToolsModule | null> {
  if (_agenticToolsMod) return _agenticToolsMod;
  try {
    const spec = "./agentic-tools.js";
    const mod = (await import(spec)) as AgenticToolsModule;
    if (mod.REAL_HANDLERS && typeof mod.writeToolCallAudit === "function") {
      _agenticToolsMod = mod;
      return _agenticToolsMod;
    }
  } catch (err) {
    console.error("[agentic-decision-runner] loadAgenticToolsModule failed:", err);
  }
  return null;
}

/** Test seam — bypass the dynamic loader. */
export function __setAgenticToolsModuleForTest(mod: AgenticToolsModule | null): void {
  _agenticToolsMod = mod;
}

function wrapRealHandler(
  name: ToolName,
  prisma: PrismaClient,
): (input: unknown, ctx: ToolHandlerContext) => Promise<unknown> {
  return async (input, ctx) => {
    const mod = await loadAgenticToolsModule();
    if (!mod) {
      return { error: "tool_module_unavailable" };
    }
    const handler = mod.REAL_HANDLERS[name];
    if (!handler) {
      return { error: `unknown tool: ${name}` };
    }
    return handler(input, { prisma, tenantId: ctx.tenantId, contactId: ctx.contactId });
  };
}

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
  /**
   * KAN-739: when set, runner builds tools with REAL_HANDLERS bound to this
   * Prisma client. When omitted, runner uses stub handlers (KAN-738 backward
   * compatibility for unit tests injecting AGENTIC_TOOLS directly).
   */
  prisma?: PrismaClient;
  /** Tools available to the agent. Defaults derived from TOOL_SCHEMAS + prisma (or stub). */
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
  const tools = input.tools ?? buildAgenticTools(input.prisma);
  const toolByName = new Map(tools.map((t) => [t.name, t]));
  const model = input.model ?? SONNET_4_6_MODEL;
  const prisma = input.prisma ?? null;

  const ctx: ToolHandlerContext = {
    tenantId: input.tenantId,
    contactId: input.contactId,
    recordToolCall: (toolName, latencyMs, resultBytes) => {
      // KAN-739 — best-effort audit row when prisma is wired. Never fails dispatch.
      if (!prisma) return;
      void (async () => {
        const mod = await loadAgenticToolsModule();
        if (!mod) return;
        await mod.writeToolCallAudit(prisma, {
          tenantId: input.tenantId,
          contactId: input.contactId,
          toolName,
          latencyMs,
          resultBytes,
          inputSnippet: "",
        });
      })();
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
        // Audit with input snippet (first 500 chars). Per-call best-effort —
        // see agentic-tools.ts top-of-file note on PII redaction posture (KAN-748).
        if (prisma) {
          const inputSnippet = JSON.stringify(block.input).slice(0, INPUT_SNIPPET_CAP);
          void (async () => {
            const mod = await loadAgenticToolsModule();
            if (!mod) return;
            await mod.writeToolCallAudit(prisma, {
              tenantId: input.tenantId,
              contactId: input.contactId,
              toolName: tool.name,
              latencyMs: Date.now() - callStart,
              resultBytes: json.length,
              inputSnippet,
            });
          })();
        } else {
          ctx.recordToolCall(tool.name, Date.now() - callStart, json.length);
        }
        // Detect tool-level errors (forbidden / truncated) and mark is_error
        // so the LLM knows to recover rather than treating the payload as success.
        const isToolError =
          typeof result === "object" &&
          result !== null &&
          "error" in (result as Record<string, unknown>);
        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: json,
          ...(isToolError ? { is_error: true } : {}),
        });
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
