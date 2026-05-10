/**
 * KAN-862 — Account Page Cohort 5: extractor unit tests.
 *
 * Mocks the LLM client + asserts:
 *   - Valid Sonnet tool_use response → validProposals[] with JSON-stringified
 *     proposedValue
 *   - Per-field Zod validation: invalid values land in invalidProposals
 *   - Confidence floor (0.5) drops sub-threshold suggestions
 *   - Unknown fieldName lands in invalidProposals
 *   - Empty tool_use → empty validProposals (not an error)
 *   - No tool_use block at all → empty result (Sonnet declined to call)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
  extractAccountFieldsFromPages,
  __setLLMModuleForTest,
} from "../services/account-detect-extractor.js";

interface MockToolUseInput {
  fields: Array<{
    fieldName: string;
    value: unknown;
    confidence: number;
    sourceUrl: string;
    sourceSnippet: string;
  }>;
}

function buildLLMResponse(opts: {
  toolUseInput?: MockToolUseInput;
  noToolUse?: boolean;
}): Awaited<
  ReturnType<
    NonNullable<Parameters<typeof __setLLMModuleForTest>[0]>["complete"]
  >
> {
  const content = opts.noToolUse
    ? [{ type: "text" as const, text: "no extraction available" }]
    : [
        {
          type: "tool_use" as const,
          id: "toolu_x",
          name: "submit_account_fields",
          input: opts.toolUseInput as unknown as Record<string, unknown>,
        },
      ];
  return {
    text: opts.noToolUse ? "no extraction available" : "",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    inputTokens: 5000,
    outputTokens: 200,
    latencyMs: 1234,
    fallbackUsed: false,
    anthropicRaw: {
      content,
      stop_reason: "tool_use",
      usage: { input_tokens: 5000, output_tokens: 200 },
    },
  };
}

const completeMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  __setLLMModuleForTest({
    complete: completeMock,
  });
});

describe("KAN-862 — extractor: valid extraction", () => {
  it("legalName + primaryPhone passes Zod, lands in validProposals with JSON-stringified values", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "legalName",
              value: "Acme Inc",
              confidence: 0.95,
              sourceUrl: "https://acme.example.com",
              sourceSnippet: "Welcome to Acme Inc",
            },
            {
              fieldName: "primaryPhone",
              value: "+15551234567",
              confidence: 0.9,
              sourceUrl: "https://acme.example.com/contact",
              sourceSnippet: "Call us at +15551234567",
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(2);
    expect(result.invalidProposals).toHaveLength(0);
    const byField = Object.fromEntries(
      result.validProposals.map((p) => [p.fieldName, p]),
    );
    expect(byField.legalName.proposedValue).toBe(JSON.stringify("Acme Inc"));
    expect(byField.legalName.confidence).toBe(0.95);
    expect(byField.legalName.sourceUrl).toBe("https://acme.example.com");
    expect(byField.primaryPhone.proposedValue).toBe(JSON.stringify("+15551234567"));
  });

  it("acceptedPaymentMethods array passes Zod when values match enum", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "acceptedPaymentMethods",
              value: ["card", "stripe"],
              confidence: 0.85,
              sourceUrl: "https://acme.example.com/contact",
              sourceSnippet: "We accept Visa, Mastercard, and Stripe",
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(1);
    expect(result.validProposals[0].proposedValue).toBe(
      JSON.stringify(["card", "stripe"]),
    );
  });
});

describe("KAN-862 — extractor: invalid-value drops", () => {
  it("invalid E.164 phone → invalidProposals (Zod error message threaded through)", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "primaryPhone",
              value: "555-1234", // missing country code, not E.164
              confidence: 0.9,
              sourceUrl: "u",
              sourceSnippet: "s",
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals).toHaveLength(1);
    expect(result.invalidProposals[0].fieldName).toBe("primaryPhone");
  });

  it("invalid email format → invalidProposals", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "primaryEmail",
              value: "not-an-email",
              confidence: 0.9,
              sourceUrl: "u",
              sourceSnippet: "s",
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals[0].fieldName).toBe("primaryEmail");
  });

  it("acceptedPaymentMethods with invalid enum value → invalidProposals", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "acceptedPaymentMethods",
              value: ["card", "venmo"], // venmo not in enum
              confidence: 0.9,
              sourceUrl: "u",
              sourceSnippet: "s",
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals[0].fieldName).toBe("acceptedPaymentMethods");
  });
});

describe("KAN-862 — extractor: confidence + fieldName guards", () => {
  it("confidence < 0.5 → invalidProposals (out-of-range), per spec safe-extraction posture", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "legalName",
              value: "Maybe Acme",
              confidence: 0.4,
              sourceUrl: "u",
              sourceSnippet: "s",
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals[0].reason).toMatch(/confidence/i);
  });

  it("confidence > 1 → invalidProposals (Sonnet over-shoots range)", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "legalName",
              value: "Acme",
              confidence: 1.1,
              sourceUrl: "u",
              sourceSnippet: "s",
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals[0].reason).toMatch(/confidence/i);
  });

  it("unknown fieldName → invalidProposals (not in ACCOUNT_DETECT_FIELD_NAMES)", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "ceoName",
              value: "Jane Doe",
              confidence: 0.9,
              sourceUrl: "u",
              sourceSnippet: "s",
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals[0].fieldName).toBe("ceoName");
    expect(result.invalidProposals[0].reason).toMatch(
      /not in ACCOUNT_DETECT_FIELD_NAMES/,
    );
  });

  it("sourceSnippet truncated to 200 chars (Sonnet over-shoots length)", async () => {
    const long = "x".repeat(500);
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({
        toolUseInput: {
          fields: [
            {
              fieldName: "legalName",
              value: "Acme",
              confidence: 0.9,
              sourceUrl: "u",
              sourceSnippet: long,
            },
          ],
        },
      }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals[0].sourceSnippet.length).toBe(200);
  });
});

describe("KAN-862 — extractor: edge cases", () => {
  it("empty fields[] in tool_use → empty validProposals (not an error)", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({ toolUseInput: { fields: [] } }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals).toHaveLength(0);
  });

  it("no tool_use block at all → empty result (Sonnet declined to call tool)", async () => {
    completeMock.mockResolvedValueOnce(buildLLMResponse({ noToolUse: true }));
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals).toHaveLength(0);
  });

  it("tool_use with non-array fields → root-level invalidProposals entry", async () => {
    completeMock.mockResolvedValueOnce({
      ...buildLLMResponse({ toolUseInput: { fields: [] } }),
      anthropicRaw: {
        content: [
          {
            type: "tool_use" as const,
            id: "toolu_x",
            name: "submit_account_fields",
            input: { fields: "not-an-array" } as unknown as Record<string, unknown>,
          },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 5000, output_tokens: 200 },
      },
    });
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.validProposals).toHaveLength(0);
    expect(result.invalidProposals).toHaveLength(1);
    expect(result.invalidProposals[0].fieldName).toBe("<root>");
  });

  it("threads token counts + model + latency through to result", async () => {
    completeMock.mockResolvedValueOnce(
      buildLLMResponse({ toolUseInput: { fields: [] } }),
    );
    const result = await extractAccountFieldsFromPages({
      tenantId: "t1",
      combinedPageText: "...",
    });
    expect(result.inputTokens).toBe(5000);
    expect(result.outputTokens).toBe(200);
    expect(result.model).toBe("claude-sonnet-4-6");
    expect(result.latencyMs).toBe(1234);
  });
});
