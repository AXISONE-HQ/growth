# KAN-1192 LLM fixture-replay snapshots

JSON snapshots of LLM responses recorded by the KAN-1192 fixture-replay
integration tests. Each file mirrors the `text` field returned by
`llmComplete()` for ONE LLM call, plus tier + model metadata for forensic
trace.

## Layer

These fixtures live at the **service-call boundary**: the orchestrator /
generator / refiner sees them via `LLMCompleteFn` injection. The real
`@anthropic-ai/sdk` is never hit at fixture-replay time. The single live
smoke scenario in `kan-1192-end-to-end-smoke.test.ts` is the drift detector
(L4 living-snapshot lock — Phase 1 trace).

## Living-snapshot protocol (Phase 1 L4 lock)

If the live Haiku smoke flakes or the orchestrator/generator/refiner LLM
prompts evolve, fixture replay may diverge from real LLM behavior. The
protocol:

1. Run `KAN_1192_RECORD_FIXTURES=1 KAN_1192_LIVE_SMOKE=1 npx vitest run \
   --config apps/connectors/vitest.config.integration.ts \
   apps/api/src/__tests__/integration/kan-1192-*.test.ts` with a valid
   `ANTHROPIC_API_KEY` in the env.
2. The harness will overwrite fixture files with fresh real-LLM responses.
3. Inspect the diff — if the schema shape is unchanged, commit the new
   fixtures. If the shape changed, the assertion contract is the live truth;
   update the test to match.
4. NEVER hand-edit fixture JSON to make a test pass — that bakes in the
   bug. Always re-record from a real LLM call.

Per `tests_encoding_current_bug_anti_pattern` memo: a green test with a
hand-edited fixture is worse than a red test because it claims regression
protection that isn't there.

## File naming

`<scenario-name>.<call-index>.json` — call-index = 0-based position in the
LLM call sequence within ONE scenario (orchestrator may call N times per
turn; generator calls 1× per pipeline; refiner calls 1× per refinement).
