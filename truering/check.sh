#!/usr/bin/env bash
# Checks for the TrueRing side of the Recording Library worker, run INSIDE a TrueRing checkout that has these
# files (truering/install.sh puts them there). Touches nothing live: no Supabase project, no deploy.
#
#   bash truering/check.sh /path/to/truering            # from the ai-redactor repo
#
# Checks: deno check (bridge, training-library-admin, ops-alert, shared helpers) · the migration on a throwaway
# Postgres on top of RL-1 (+ RL-1's own tests) · manifest / config.toml / rollback wiring · frontend typecheck,
# lint and vite build (no new errors vs main).
set -uo pipefail
TR="${1:?usage: bash truering/check.sh /path/to/truering}"
TR="$(cd "$TR" && pwd)"
cd "$TR"
[ -f supabase/functions/sample-redaction-bridge/index.ts ] || { echo "$TR has no sample-redaction-bridge: run truering/install.sh first"; exit 2; }

DENO=(npx -y deno@2.9.6)
FAILS=0
step() {  # name cmd...
  local name="$1"; shift
  local log; log="$(mktemp)"
  if "$@" >"$log" 2>&1; then printf 'PASS  %s\n' "$name"; else printf 'FAIL  %s\n' "$name"; tail -20 "$log" | sed 's/^/      /'; FAILS=$((FAILS + 1)); fi
  rm -f "$log"
}

echo "TrueRing-side checks · $(git rev-parse --abbrev-ref HEAD) @ $(git rev-parse --short HEAD)$( [ -n "$(git status --porcelain)" ] && echo ' (uncommitted changes)')"

step "edge functions: deno check" bash -c "cd supabase/functions && ${DENO[*]} check sample-redaction-bridge/index.ts training-library-admin/index.ts ops-alert/index.ts _shared/sampleSignature.ts _shared/telnyxRecording.ts"
step "migration on a throwaway Postgres on RL-1 (caps, race, guards, ingest, takedown, rollback)" bash supabase/tests/sample_redaction/run.sh
step "RL-1 migration tests (unchanged)" bash supabase/tests/training_library/run.sh

wiring() {
  node -e '
    const fs=require("fs"); const m=JSON.parse(fs.readFileSync("supabase/functions/integrity-audit/manifest.json","utf8"));
    const want=[["sample_redaction_jobs","sample_redaction_jobs_service_columns"],["training_library_calls","sample_redaction_takedown_guard"]];
    const t=JSON.stringify(m); for (const [tb,tr] of want) if(!t.includes(`"table":"${tb}","trigger":"${tr}"`)) { console.log("manifest missing", tb, tr); process.exit(1); }
    console.log("manifest", m.manifest_version, "has both new triggers");'
  for f in training-library-admin sample-redaction-bridge; do
    awk -v f="[functions.$f]" '$0==f{getline; if ($0 ~ /verify_jwt = false/) ok=1} END{exit !ok}' supabase/config.toml || { echo "config.toml: $f entry missing"; return 1; }
  done
  [ -f scripts/rollbacks/rollback_20261013090000_sample_redaction_worker.sql ] || { echo "rollback missing"; return 1; }
  local dup; dup="$(ls supabase/migrations | sed -n 's/^\([0-9]\{14\}\)_.*/\1/p' | sort | uniq -d)"
  [ -z "$dup" ] || { echo "duplicate migration versions: $dup"; return 1; }
  ! grep -qiE 'update +(public\.)?feature_flags|insert +into +(public\.)?feature_flags' supabase/migrations/20261013090000_sample_redaction_worker.sql
}
step "repo: manifest triggers, verify_jwt entries, rollback, unique migration versions, no flag flips" wiring

[ -d node_modules ] || step "frontend: npm ci" npm ci --no-audit --no-fund
OURS='src/pages/admin/RecordingLibrary.tsx|src/components/recording-library/|src/lib/recordingLibraryFlag.ts|src/App.tsx|src/components/AdminLayout.tsx|src/components/AMLayout.tsx'
fe_tsc() {
  local out; out="$(npx tsc -p tsconfig.app.json --noEmit 2>&1)"
  local ours; ours="$(echo "$out" | grep 'error TS' | grep -cE "$OURS")"
  echo "$out" | grep 'error TS'; echo "errors in this change's files: $ours"
  [ "$ours" = "0" ]
}
step "frontend: typecheck (no errors in this change's files)" fe_tsc
step "frontend: eslint on the new page + components" npx eslint src/pages/admin/RecordingLibrary.tsx src/components/recording-library src/lib/recordingLibraryFlag.ts
fe_lint_changed() {  # repo lint is not clean on main: edited files must not get worse
  local f now was bad=0
  for f in src/App.tsx src/components/AdminLayout.tsx src/components/AMLayout.tsx; do
    now="$(npx eslint -f json "$f" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].errorCount')"
    was="$(git show "origin/main:$f" | npx eslint -f json --stdin --stdin-filename "$f" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].errorCount')"
    echo "$f: $now errors (main: $was)"; [ "$now" -le "$was" ] || bad=1
  done
  return $bad
}
step "frontend: edited files no worse than main (eslint)" fe_lint_changed
step "frontend: vite production build" npm run build

echo
echo "$FAILS failed"
[ $FAILS = 0 ]
