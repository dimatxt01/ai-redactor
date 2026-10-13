#!/usr/bin/env bash
# Refreshes this REFERENCE COPY from a TrueRing checkout (Mahamadou2004/truering, branch feat/sample-redaction).
# One direction only: TrueRing → here. Nothing in truering/ is ever applied to TrueRing from this repo.
#
#   bash truering/refresh.sh /path/to/truering   # copies FILES + SPEC + TR_PLAN + RL-1 copies, regenerates the patch
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TR="$(cd "${1:?usage: bash truering/refresh.sh /path/to/truering}" && pwd)"
base="$(git -C "$TR" merge-base HEAD origin/main)"
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
echo "refreshed from $(git -C "$TR" rev-parse --abbrev-ref HEAD) @ $(git -C "$TR" rev-parse --short HEAD) (base $(git -C "$TR" rev-parse --short "$base")): $(wc -l < "$HERE/FILES" | tr -d ' ') new files, $(grep -c '^diff --git' "$HERE/existing-files.patch") edited"
