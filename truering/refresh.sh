#!/usr/bin/env bash
# Refreshes this MIRROR from a TrueRing checkout of Mahamadou2004/truering branch prb/rl-worker (later: main).
# One direction only: TrueRing → here. Nothing in truering/ is ever applied or deployed from this repo.
#
#   git -C /path/to/truering fetch origin prb/rl-worker && git -C /path/to/truering checkout --detach origin/prb/rl-worker
#   bash truering/refresh.sh /path/to/truering [label] [base]   # copies FILES + SPEC + TR_PLAN + RL-1 copies, regenerates the patch
# base: where the RL worker work starts. Default: merge-base with origin/main (a branch). Once merged, pass main
# before the merge, e.g. `bash truering/refresh.sh ~/truering main@d7671d64 d7671d64^1`.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TR="$(cd "${1:?usage: bash truering/refresh.sh /path/to/truering}" && pwd)"
base="$(git -C "$TR" rev-parse "${3:-$(git -C "$TR" merge-base HEAD origin/main)}")"
git -C "$TR" diff --name-only --diff-filter=A "$base" HEAD > "$HERE/FILES"
copy() { mkdir -p "$HERE/$(dirname "$1")"; git -C "$TR" show "HEAD:$1" > "$HERE/$1"; }
while IFS= read -r f; do copy "$f"; done < "$HERE/FILES"
for f in docs/recording-library/SPEC.md docs/recording-library/TR_PLAN.md \
         supabase/migrations/20261012180000_training_library.sql supabase/tests/training_library/_fixture.sql \
         supabase/tests/training_library/run.sh supabase/tests/training_library/test.sql \
         scripts/rollbacks/rollback_20261012180000_training_library.sql scripts/verify/verify_20261012180000_training_library.sql; do
  copy "$f"
done
git -C "$TR" diff "$base" HEAD -- $(git -C "$TR" diff --name-only --diff-filter=M "$base" HEAD) > "$HERE/existing-files.patch"
label="${2:-$(git -C "$TR" rev-parse --abbrev-ref HEAD)}"
printf 'Mahamadou2004/truering %s @ %s (base main %s), refreshed %s\n' "$label" "$(git -C "$TR" rev-parse HEAD)" "$(git -C "$TR" rev-parse "$base")" "$(date -u +%Y-%m-%dT%H:%MZ)" > "$HERE/SOURCE"
echo "refreshed from $(git -C "$TR" rev-parse --abbrev-ref HEAD) @ $(git -C "$TR" rev-parse --short HEAD) (base $(git -C "$TR" rev-parse --short "$base")): $(wc -l < "$HERE/FILES" | tr -d ' ') new files, $(grep -c '^diff --git' "$HERE/existing-files.patch") edited"
