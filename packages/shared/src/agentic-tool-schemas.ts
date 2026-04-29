/**
 * KAN-739 — Sprint 3 / S3.2 — agentic tool surface schemas.
 *
 * Single source of truth for the 5 read-only tools the agentic loop exposes.
 * KAN-738 froze the contract here (stub handlers); KAN-739 swaps real
 * handlers without touching this surface.
 *
 * Frontend admin UI (Sprint 4) reads from these to render "what the agent
 * can see" — pulling from @growth/shared keeps the description copy in one
 * place across api + web.
 */

export const TOOL_NAMES = [
  "get_contact_context",
  "retrieve_knowledge",
  "get_pipeline_state",
  "get_recent_actions",
  "get_objective_progress",
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export interface ToolSchema {
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
  };
}

export const TOOL_SCHEMAS: Record<ToolName, ToolSchema> = {
  get_contact_context: {
    description:
      "Read the full context for a contact: profile, current pipeline + stage, recent decisions, recent outcomes, micro-objective progress. Tenant-scoped.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", format: "uuid" },
      },
      required: ["contactId"],
    },
  },
  retrieve_knowledge: {
    description:
      "Retrieve top-K relevant knowledge chunks for a query via pgvector similarity. Optional pipelineId filters via the per-pipeline knowledge category filter (KAN-708). Tenant-scoped.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        pipelineId: { type: "string", format: "uuid" },
        limit: { type: "integer", minimum: 1, maximum: 10, default: 5 },
      },
      required: ["query"],
    },
  },
  get_pipeline_state: {
    description:
      "Read pipeline configuration: name, objective, stages (with order + isInitial/isTerminal flags), targets vs current progress, attached micro-objectives. Tenant-scoped.",
    input_schema: {
      type: "object",
      properties: {
        pipelineId: { type: "string", format: "uuid" },
      },
      required: ["pipelineId"],
    },
  },
  get_recent_actions: {
    description:
      "Last N actions for a contact (default 10, max 50), ordered most-recent-first. Returns action type, channel, status, sentAt, deliveredAt, failedAt. Tenant-scoped.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", format: "uuid" },
        limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      },
      required: ["contactId"],
    },
  },
  get_objective_progress: {
    description:
      "Per-contact micro-objective completion state. Returns list of (microObjectiveId, name, isCompleted, completedAt). Tenant-scoped.",
    input_schema: {
      type: "object",
      properties: {
        contactId: { type: "string", format: "uuid" },
      },
      required: ["contactId"],
    },
  },
};

/**
 * Neutral cross-tenant rejection messages. Returned to the LLM via tool_result
 * with is_error=true. MUST NOT include tenantId or contactId of the resource
 * the caller attempted to access — would leak existence of cross-tenant data.
 */
export const NEUTRAL_FORBIDDEN_MESSAGES = {
  contact: "Contact not accessible to this tenant",
  pipeline: "Pipeline not accessible to this tenant",
} as const;

/**
 * Defensive cap for tool result payloads returned to the LLM. Tools that
 * return arbitrarily-large data (retrieve_knowledge with large chunks,
 * get_contact_context with deep history) wrap their output in capResult.
 */
export const TOOL_RESULT_CAP_BYTES = 50 * 1024;
