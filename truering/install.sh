#!/usr/bin/env bash
# Puts the TrueRing side of the Recording Library worker into a TrueRing checkout, on a branch:
#   - copies every file in truering/FILES (migration + rollback + tests, the two edge functions and their
#     shared helpers, the curation page) to the same path in the checkout;
#   - applies truering/existing-files.patch (routes + nav, config.toml verify_jwt, integrity manifest,
#     ops-alert key, FLAGS §76, TR_PLAN) with a 3-way merge.
# It never commits, pushes, applies a migration or deploys: review the diff, run truering/check.sh, commit.
#
#   bash truering/install.sh /path/to/truering
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TR="${1:?usage: bash truering/install.sh /path/to/truering}"
TR="$(cd "$TR" && pwd)"
git -C "$TR" rev-parse --git-dir >/dev/null 2>&1 || { echo "$TR is not a git checkout"; exit 2; }
[ -f "$TR/supabase/migrations/20261012180000_training_library.sql" ] || { echo "$TR has no RL-1 migration (20261012180000_training_library): not TrueRing main, or too old"; exit 2; }
branch="$(git -C "$TR" rev-parse --abbrev-ref HEAD)"
case "$branch" in main|master) echo "on $branch: create a branch first (git -C $TR switch -c feat/sample-redaction)"; exit 2 ;; esac
[ -z "$(git -C "$TR" status --porcelain)" ] || { echo "$TR has uncommitted changes: commit or set them aside first"; exit 2; }

# RL-1 must be the one these files were built on
for f in supabase/migrations/20261012180000_training_library.sql docs/recording-library/SPEC.md; do
  cmp -s "$HERE/$f" "$TR/$f" || { echo "$f in $TR differs from the RL-1 this was built on (truering/$f): stop and re-check"; exit 2; }
done
# a migration version taken in the meantime would collide
if ls "$TR/supabase/migrations" | grep -q '^20261013090000_' && [ ! -f "$TR/supabase/migrations/20261013090000_sample_redaction_worker.sql" ]; then
  echo "migration version 20261013090000 is taken in $TR: renumber before installing"; exit 2
fi

n=0
while IFS= read -r f; do
  [ -n "$f" ] || continue
  mkdir -p "$TR/$(dirname "$f")"
  cp "$HERE/$f" "$TR/$f"
  n=$((n + 1))
done < "$HERE/FILES"
echo "copied $n files"

if git -C "$TR" apply --check "$HERE/existing-files.patch" 2>/dev/null; then
  git -C "$TR" apply "$HERE/existing-files.patch"
else
  git -C "$TR" apply --3way "$HERE/existing-files.patch" || { echo "the patch needs a hand merge: resolve the conflicts git lists, then run truering/check.sh"; exit 1; }
fi
echo "patched $(grep -c '^diff --git' "$HERE/existing-files.patch") existing files"
echo
git -C "$TR" status --short
echo
echo "next: bash $HERE/check.sh $TR   then review the diff and commit on $branch (nothing was committed, applied or deployed)"
