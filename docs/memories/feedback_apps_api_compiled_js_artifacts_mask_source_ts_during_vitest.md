---
name: apps/api compiled .js artifacts mask source .ts during vitest
description: KAN-1098 2026-06-05. apps/api/src/**/*.js compiled artifacts are load-bearing for vitest at runtime (mirroring known packages/api pattern but in a different rootDir). After editing apps/api source TS, vitest can load STALE .js. Forced regen via `tsc -p apps/api --noEmit false --outDir apps/api/src --rootDir apps/api/src --noEmitOnError false` before vitest.
type: feedback
---

**KAN-1098 fixup verification 2026-06-05**: After editing `apps/api/src/subscribers/lead-received-push.ts` to add KAN-1098 Step 0 deal-find, local vitest ran the test assertion expecting `toHaveBeenCalledTimes(2)` and got `1` — the test was reading the STALE `apps/api/src/subscribers/lead-received-push.js` artifact (mtime predating my edit) that didn't have the Step 0 code.

This is the apps/api sibling to the known `packages/api` pattern memoed at `feedback_packages_api_js_artifacts_load_bearing_for_vitest_mocks`. Both rootDirs maintain compiled .js next to .ts source; vitest resolution via cross-workspace bridges (apps/connectors → apps/api/src/__tests__/*.test.ts) can prefer .js over .ts depending on import-spec.

## The recovery command

```bash
npx tsc -p apps/api --noEmit false --outDir apps/api/src --rootDir apps/api/src --noEmitOnError false
```

The `--noEmitOnError false` flag is critical — apps/api has 169+ pre-existing KAN-689 cohort errors that would otherwise block emission. Force-emit alongside the errors; the new .js artifacts incorporate the edited source.

## Symptom shape

- Source `.ts` shows new code ✓
- `grep -c 'newSymbol' apps/api/src/path/file.js` returns `0` → stale artifact
- Vitest assertion result reflects old behavior, not source behavior
- CI passes/fails differently from local because CI builds fresh

## Symptom catch

`grep -c '<distinguishing-symbol>' apps/api/src/<path>/<file>.js` is the canonical fast check. Diff `.js` mtime against `.ts` mtime as backup.

## Forward discipline

When fixup-verifying KAN-1098-class changes locally:

1. Make source TS edits
2. **Regen apps/api .js artifacts** via the above tsc command
3. THEN run vitest

OR add a pre-vitest npm script that clears stale `.js` artifacts before vitest runs:
```json
"test:safe": "find apps/api/src -name '*.js' -delete && npx vitest run"
```

(Trade-off: forces vitest to transform .ts directly each run; slightly slower but always accurate.)

## Sibling memo

- `feedback_packages_api_js_artifacts_load_bearing_for_vitest_mocks` — packages/api version (same pattern, different rootDir)

## Anti-pattern (what we did in KAN-1098 fixup)

Forgot the apps/api artifact regen step between source edit + local vitest run. Lost ~5 minutes chasing why the test failed locally when the assertion semantics looked correct. The CI run that surfaced the original bug was using fresh-built artifacts; my local was using day-old artifacts emitted before my edits.

## Why this matters now

Cluster IV-B PR III (KAN-1098) had THREE iterations of CI fix-forward (test mocks → variable-specifier imports). Each iteration required local vitest verification. Each verification needed fresh .js artifacts. Without explicit regen, local would show false-PASS or false-FAIL.

5-second `tsc` step prevents 5-minute chase.
