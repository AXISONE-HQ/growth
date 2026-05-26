#!/usr/bin/env bash
# KAN-1017 — packages/api typecheck baseline gate.
#
# Third leg of the CI Gate Audit (KAN-1016), alongside KAN-1011 (web
# ignoreBuildErrors) and KAN-1013 (deploy Redis PING). The engine's core
# package was previously not typechecked in CI — four of the seven M1
# closing-smoke bugs (schema drift, `as any` cast bombs, Zod vocab +
# nullability mismatches) hid behind that gap.
#
# How it works:
#   1. Runs `tsc -p packages/api --noEmit`
#   2. Normalizes each error line by stripping (line,col) — so any code-
#      shuffle that moves an existing error around doesn't false-trip the
#      gate; only NEW error CLASSES (new file or new error-code+message
#      combo on an existing file) register
#   3. Sorts + de-dupes into signatures
#   4. Compares against the committed baseline at
#      packages/api/.tsc-baseline.txt
#   5. EXITS NON-ZERO if any new signatures exist (= new error introduced
#      by this PR). EXITS ZERO if signatures are a subset of baseline
#      (= existing cohort or improvement)
#
# Granularity note (deliberate): the gate catches CLASSES of error, not
# instance counts. A second copy of an already-known (file, TS-code,
# message) on a new line in an already-affected file does NOT trip the
# gate — that's the trade-off we accept to avoid line-number-shift false
# trips. Real drift almost always introduces a new file, a new TS error
# code, or a new message wording — all of which the gate catches. The
# Sprint-6 G1-G4 cohort cleanups are what actually shrink instance
# counts; the gate only stops the cohort from refilling with new shapes.
#
# To regenerate the baseline (only on intentional cohort change — Sprint-6
# G1-G4 cleanups, or after a Prisma client regeneration that morphs error
# shapes):
#   REPO_ROOT="$(git rev-parse --show-toplevel)"  # strip absolute paths
#   npx tsc -p packages/api --noEmit 2>&1 \
#     | grep -E "error TS" \
#     | sed "s|$REPO_ROOT/||g" \
#     | sed 's/([0-9][0-9]*,[0-9][0-9]*)//' \
#     | LC_ALL=C sort -u \
#     > packages/api/.tsc-baseline.txt
#   git add packages/api/.tsc-baseline.txt
#   git commit -m "chore(KAN-1017): refresh packages/api typecheck baseline (-N signatures)"
#
# LC_ALL=C is load-bearing: macOS default `sort` uses UTF-8 collation,
# Linux CI default uses C (byte-wise). Without LC_ALL=C on both sides,
# the baseline and the gate's current-snapshot can have identical
# CONTENT but different SORT ORDER, and `comm -23` produces false NEW
# signatures. The first CI run of this gate (PR #220) bit on this — the
# script now exports LC_ALL=C as the first line so every sort/comm in
# the script uses byte-wise collation.
set -uo pipefail
export LC_ALL=C

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PKG_DIR="$REPO_ROOT/packages/api"
BASELINE="$PKG_DIR/.tsc-baseline.txt"

if [ ! -f "$BASELINE" ]; then
  echo "FATAL: baseline file $BASELINE missing. To create it:" >&2
  echo "  npx tsc -p packages/api --noEmit 2>&1 | grep -E 'error TS' | sed 's/([0-9][0-9]*,[0-9][0-9]*)//' | LC_ALL=C sort -u > $BASELINE" >&2
  exit 2
fi

CURRENT="$(mktemp)"
trap 'rm -f "$CURRENT"' EXIT

cd "$REPO_ROOT"
# Don't propagate tsc's non-zero exit — we expect errors. The signature
# diff is the actual gate.
#
# Normalization (two passes):
#   1. `sed "s|$REPO_ROOT/||g"` — strip the absolute repo-root prefix
#      from error messages. Some TS errors (notably TS6059 rootDir
#      violations) embed absolute paths in the message itself. Locally
#      that's `/Users/fredericbinette/growth/...`; CI is
#      `/home/runner/work/growth/growth/...`. Without this strip, the
#      same semantic error has different signatures across runners. PR
#      #220's second CI run bit on this.
#   2. `sed 's/([0-9][0-9]*,[0-9][0-9]*)//'` — drop the (line,col) prefix
#      so code-shuffles don't drift the signature.
npx tsc -p packages/api --noEmit 2>&1 \
  | grep -E "error TS" \
  | sed "s|$REPO_ROOT/||g" \
  | sed 's/([0-9][0-9]*,[0-9][0-9]*)//' \
  | LC_ALL=C sort -u \
  > "$CURRENT" || true

baseline_count=$(wc -l < "$BASELINE" | tr -d ' ')
current_count=$(wc -l < "$CURRENT" | tr -d ' ')

# NEW signatures = in current but not in baseline
new_signatures=$(comm -23 "$CURRENT" "$BASELINE")
removed_signatures=$(comm -13 "$CURRENT" "$BASELINE")

removed_count=$(echo "$removed_signatures" | grep -c . || true)

echo "=== KAN-1017 packages/api typecheck baseline gate ==="
echo "baseline signatures: $baseline_count"
echo "current  signatures: $current_count"
echo "removed (good!):     $removed_count"

if [ -n "$new_signatures" ]; then
  new_count=$(echo "$new_signatures" | grep -c .)
  echo ""
  echo "FAIL: $new_count NEW error signature(s) — packages/api typecheck gate failed."
  echo ""
  echo "These errors are not in the committed baseline at packages/api/.tsc-baseline.txt:"
  echo ""
  echo "$new_signatures" | sed 's/^/  ✗ /'
  echo ""
  echo "Resolution options:"
  echo "  1. Fix the new error (preferred — this gate exists to stop drift)."
  echo "  2. If the change deliberately morphs an existing error's wording (e.g."
  echo "     a Prisma regeneration), regenerate the baseline per the header"
  echo "     comment of scripts/typecheck-baseline-gate.sh and commit it."
  echo "  3. If you believe this is a false positive (e.g. the normalization"
  echo "     missed a code-shuffle), open a ticket against KAN-1016 with the"
  echo "     signature diff."
  exit 1
fi

if [ "$removed_count" -gt 0 ]; then
  echo ""
  echo "✓ packages/api typecheck gate PASSED."
  echo "  NOTE: $removed_count baseline signature(s) no longer present —"
  echo "  someone fixed engine errors. Consider regenerating the baseline"
  echo "  (see scripts/typecheck-baseline-gate.sh header) so future PRs"
  echo "  can't re-introduce them."
  echo ""
  echo "  Removed signatures:"
  echo "$removed_signatures" | sed 's/^/    - /'
else
  echo ""
  echo "✓ packages/api typecheck gate PASSED (no drift)."
fi
exit 0
