/**
 * KAN-1187 X1 — Builder UI shared constants.
 *
 * Centralizes operator-facing copy that's doctrinally load-bearing.
 * BUILDER_EMPTY_STATE_MESSAGE primes the operator on the 4-dimension flow
 * before their first message. Editing this copy changes the conversational
 * frame the orchestrator inherits — treat as substrate, not text.
 */

/** Empty-state AI message shown before operator's first message at /campaigns/new.
 *  Operator-direct voice; example-anchored; honest about the back-and-forth. */
export const BUILDER_EMPTY_STATE_MESSAGE =
  "Tell me about the campaign you want to create. For example: \"I want to sell 50 units of Product ABC by end of Q3.\" I'll work with you to define the audience, objectives, and timeline — then build an Action Plan you can edit.";
