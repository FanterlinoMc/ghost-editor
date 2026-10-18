#!/usr/bin/env bash
# The engine gate. Every engine change must pass it before it is merged or pinned.
#   bash scripts/gate.sh            run from the fork's root (any OS: Windows Git Bash, macOS, Linux)
# 1. byte-identity: the 4 synthetic reels build identically to scripts/lib/golden-build-hashes.json.
#    NEVER run `node scripts/byte-identity.mjs --record`: that rewrites the reference and hides a regression.
# 2. every scripts/*.test.mjs and scripts/lib/*.test.mjs passes.
# 3. fork-only features are still there (token counts in build.mjs may not drop below the baseline).
# Exit 1 on any failure; the last line is "GATE: PASS" or "GATE: FAIL".
cd "$(dirname "$0")/.." || exit 1
# macOS has no `timeout` by default (Homebrew coreutils installs it as gtimeout).
if command -v timeout >/dev/null; then T=timeout; elif command -v gtimeout >/dev/null; then T=gtimeout; else T=""; fi
run() { local s=$1; shift; if [ -n "$T" ]; then $T "$s" "$@"; else "$@"; fi; }
fail=0
echo "== byte-identity"
out=$(run 900 node scripts/byte-identity.mjs 2>&1); echo "$out" | tail -3
echo "$out" | grep -q "identical to the golden" || fail=1
echo "== tests"
for t in scripts/*.test.mjs scripts/lib/*.test.mjs; do
  [ -e "$t" ] || continue
  out=$(run 600 node --test "$t" 2>&1); f=$(echo "$out" | grep -E "ℹ fail " | awk '{print $3}')
  [ "$f" = "0" ] || { echo "FAIL $t"; echo "$out" | tail -20; fail=1; }
done
echo "== fork-only tokens in build.mjs (must not drop below baseline)"
B=scripts/build.mjs
for pair in edit_truth:12 SECTION_:33 SOURCES:25 takeEndAt:2 layers:24 room:31 joins:12; do
  tok=${pair%%:*}; min=${pair##*:}; n=$(grep -c "$tok" $B)
  printf "  %-12s %s (min %s)\n" "$tok" "$n" "$min"; [ "$n" -ge "$min" ] || fail=1
done
[ $fail = 0 ] && echo "GATE: PASS" || { echo "GATE: FAIL"; exit 1; }
