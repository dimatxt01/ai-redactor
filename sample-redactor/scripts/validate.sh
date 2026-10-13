#!/usr/bin/env bash
# First validation of the sample-redaction branch, on this machine only.
# Touches NOTHING live: no Supabase project, no Vercel, no deploy. The only
# network calls are npm/deno downloads and, when keys are set, AssemblyAI +
# OpenRouter on the four synthetic test calls (every value in them is fictional).
#
#   cd sample-redactor && npm run validate              # everything; vendors if keys are set
#   npm run validate -- --offline                       # never call the vendors
#   npm run validate -- --fresh                         # clean npm ci for worker + frontend first
#   npm run validate -- --skip-long                     # vendor eval without the 47-min call (~$1 of the ~$1.6)
#
# Keys: export ASSEMBLYAI_API_KEY / OPENROUTER_API_KEY, or put them in
# sample-redactor/.env.local (gitignored). They are never printed or written out.
# Report: fixtures/out/validation-<time>.md (gitignored) — send that file back.
set -uo pipefail

W="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$(cd "$W/.." && pwd)"
OUT="$W/fixtures/out"
mkdir -p "$OUT"
STAMP="$(date +%Y%m%d-%H%M%S)"
REPORT="$OUT/validation-$STAMP.md"
LOGDIR="$OUT/validation-$STAMP.logs"
mkdir -p "$LOGDIR"
OFFLINE=0; FRESH=0; SKIP_LONG=0
for a in "$@"; do
  case "$a" in
    --offline) OFFLINE=1 ;;
    --fresh) FRESH=1 ;;
    --skip-long) SKIP_LONG=1 ;;
    *) echo "unknown option: $a"; exit 2 ;;
  esac
done

if [ -f "$W/.env.local" ]; then set -a; . "$W/.env.local"; set +a; fi

DENO=(npx -y deno@2.9.6)
PORT=3199
RESULTS=()
FAILS=0
n=0

record() {  # status name seconds detail
  RESULTS+=("| $1 | $2 | ${3}s | $4 |")
  [ "$1" = "FAIL" ] && FAILS=$((FAILS + 1))
  printf '%-5s %-44s %4ss  %s\n' "$1" "$2" "$3" "$4"
}

step() {  # name detail-on-pass cmd...
  local name="$1" pass="$2"; shift 2
  n=$((n + 1))
  local log="$LOGDIR/$(printf '%02d' $n)-$(echo "$name" | tr -c 'a-zA-Z0-9' '-' | tr -s '-' | sed 's/-$//').log"
  local t0=$SECONDS
  if "$@" >"$log" 2>&1; then
    record PASS "$name" $((SECONDS - t0)) "$pass"
  else
    record FAIL "$name" $((SECONDS - t0)) "see $(basename "$LOGDIR")/$(basename "$log")"
    echo "      ── last lines ──"; tail -15 "$log" | sed 's/^/      /'
  fi
}

skip() { n=$((n + 1)); record SKIP "$1" 0 "$2"; }

echo "sample-redaction validation · $STAMP"
echo "branch $(git -C "$ROOT" rev-parse --abbrev-ref HEAD) @ $(git -C "$ROOT" rev-parse --short HEAD)$( [ -n "$(git -C "$ROOT" status --porcelain)" ] && echo ' (uncommitted changes)')"
echo

# ── 1. prerequisites ──────────────────────────────────────────────────────────
prereqs() {
  local major; major="$(node -p 'process.versions.node.split(".")[0]')"
  echo "node $(node -v), npm $(npm -v), $(uname -sm)"
  [ "$major" -ge 22 ] || { echo "need node >= 22"; return 1; }
  command -v git >/dev/null
}
step "prerequisites (node >= 22, npm, git)" "node $(node -v 2>/dev/null)" prereqs

# ── 2. worker ─────────────────────────────────────────────────────────────────
cd "$W"
if [ $FRESH = 1 ] || [ ! -d node_modules ]; then
  step "worker: npm ci" "exact-pinned deps installed" npm ci --no-audit --no-fund
else
  skip "worker: npm ci" "node_modules present (use --fresh to reinstall)"
fi
# not incremental: two incremental runs on one tsbuildinfo can block each other
step "worker: typecheck" "tsc clean" node node_modules/.bin/tsc --noEmit --incremental false
step "worker: unit tests (detectors, DSP, HMAC, logs)" "all passed" npx vitest run
step "worker: production build (next + workflow)" "build ok" npx next build

FFMPEG="$(node -p 'require("ffmpeg-static")' 2>/dev/null)"
RB="$("$FFMPEG" -hide_banner -filters 2>/dev/null | grep -q rubberband && echo yes || echo 'no (resample fallback here; Vercel reports its own in /api/health)')"

# ── 3. synthetic test calls ───────────────────────────────────────────────────
if command -v say >/dev/null; then
  step "test calls: generate (macOS say, 2 voices)" "12 dual-channel mp3s (incl. crosstalk, 47-min call)" npm run make-test-calls
elif ls "$OUT"/0*-*.mp3 >/dev/null 2>&1; then
  skip "test calls: generate" "no macOS say; using the mp3s already in fixtures/out"
else
  n=$((n + 1)); record FAIL "test calls: generate" 0 "needs macOS say (or copy fixtures/out/*.mp3 from a Mac)"
fi
callfmt() {
  local bad=0 f info
  for f in "$OUT"/[0-9][0-9]-*.mp3; do
    case "$f" in *.redacted.mp3) continue ;; esac
    info="$("$FFMPEG" -hide_banner -i "$f" 2>&1 | grep 'Audio:')"
    echo "$(basename "$f"): $info"
    echo "$info" | grep -qE 'stereo|2 channels' || bad=1
    [ -f "${f%.mp3}.planted.json" ] || { echo "missing planted.json for $f"; bad=1; }
  done
  return $bad
}
step "test calls: two channels + planted manifest" "every call stereo, manifest present" callfmt

# ── 4. local worker: auth fails closed ────────────────────────────────────────
smoke() {
  local secret; secret="local-$(node -p 'crypto.randomUUID()')"
  env -u ASSEMBLYAI_API_KEY -u OPENROUTER_API_KEY \
    SAMPLE_REDACTOR_START_SECRET="$secret" SAMPLE_REDACTOR_BRIDGE_SECRET="local-bridge-$secret" \
    TR_BRIDGE_URL="http://127.0.0.1:9/functions/v1/sample-redaction-bridge" \
    node node_modules/next/dist/bin/next start -p $PORT >"$LOGDIR/next-start.log" 2>&1 &
  local pid=$!
  trap "kill $pid 2>/dev/null" RETURN
  local i; for i in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/api/health" >/dev/null && break; sleep 1; done
  local h; h="$(curl -sf "http://127.0.0.1:$PORT/api/health")" || { echo "health never came up"; return 1; }
  echo "health: $h"
  echo "$h" | grep -q '"ok":true' && echo "$h" | grep -q '"pipeline_version":"sr-' || return 1
  sign() { SECRET="$1" BODY="$2" SKEW="${3:-0}" node -e '
    const c=require("crypto"); const t=Math.floor(Date.now()/1000)-Number(process.env.SKEW);
    console.log(`t=${t},v1=${c.createHmac("sha256",process.env.SECRET).update(`${t}.${process.env.BODY}`).digest("hex")}`)'; }
  code() { curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT$1" -H 'content-type: application/json' ${3:+-H "x-tr-signature: $3"} --data "$2"; }
  local body='{"job_id":"not-a-uuid","idempotency_key":"validate"}' fails=0
  expect() { local got; got="$(code "$2" "$3" "${4:-}")"; echo "$1: $got (want $5)"; [ "$got" = "$5" ] || fails=1; }
  expect "jobs, unsigned"            /api/jobs   "$body" ""                                   401
  expect "jobs, wrong secret"        /api/jobs   "$body" "$(sign wrong "$body")"              401
  expect "jobs, 10 min old"          /api/jobs   "$body" "$(sign "$secret" "$body" 600)"      401
  expect "jobs, body changed"        /api/jobs   "$body" "$(sign "$secret" '{"job_id":"x"}')" 401
  expect "jobs, signed, bad job id"  /api/jobs   "$body" "$(sign "$secret" "$body")"          400
  local nokey='{"job_id":"00000000-0000-4000-8000-000000000000","idempotency_key":"nope"}'
  expect "jobs, signed, bad key"     /api/jobs   "$nokey" "$(sign "$secret" "$nokey")"        400
  expect "delete, unsigned"          /api/delete '{"job_ids":[]}' ""                          401
  expect "delete, wrong secret"      /api/delete '{"job_ids":[]}' "$(sign wrong '{"job_ids":[]}')" 401
  if grep -qF "$secret" "$LOGDIR/next-start.log"; then echo "the secret reached the server log"; fails=1; fi
  echo "server log lines: $(wc -l < "$LOGDIR/next-start.log")"
  return $fails
}
step "worker: local server, HMAC fails closed" "health ok; unsigned/wrong/stale/tampered → 401" smoke

# ── 5. TR edge functions ──────────────────────────────────────────────────────
cd "$ROOT/supabase/functions"
step "edge functions: deno check" "bridge, training-library-admin, ops-alert, shared helpers typecheck" \
  "${DENO[@]}" check sample-redaction-bridge/index.ts training-library-admin/index.ts ops-alert/index.ts _shared/sampleSignature.ts _shared/telnyxRecording.ts
cd "$ROOT"
step "HMAC parity: Deno (TR) ↔ Node (worker)" "same header; same refusals" "${DENO[@]}" run supabase/tests/sample_signature_parity.ts

# ── 6. migration on a throwaway Postgres ──────────────────────────────────────
if command -v initdb >/dev/null || ls /opt/homebrew/opt/postgresql@1[5-9]/bin/initdb /usr/lib/postgresql/1[5-9]/bin/initdb >/dev/null 2>&1; then
  step "migration: throwaway Postgres on RL-1 (caps, race, guards, ingest, takedown, rollback)" "all cases pass; RL-1 cases still pass on top" \
    bash supabase/tests/sample_redaction/run.sh
  step "RL-1 migration tests (unchanged, as on main)" "RL-1 cases pass" bash supabase/tests/training_library/run.sh
else
  skip "migration: throwaway Postgres" "no local PostgreSQL 15+ (brew install postgresql@17)"
fi

# ── 7. repo wiring + hygiene ──────────────────────────────────────────────────
wiring() {
  node -e '
    const fs=require("fs"); const m=JSON.parse(fs.readFileSync("supabase/functions/integrity-audit/manifest.json","utf8"));
    const want=[["sample_redaction_jobs","sample_redaction_jobs_service_columns"],["training_library_calls","sample_redaction_takedown_guard"]];
    const t=JSON.stringify(m); for (const [tb,tr] of want) if(!t.includes(`"table":"${tb}","trigger":"${tr}"`)) { console.log("manifest missing", tb, tr); process.exit(1); }
    if (m.manifest_version !== "2026-10-12.3") { console.log("manifest_version", m.manifest_version, "(want 2026-10-12.3: main 2026-10-12.2 + this change)"); process.exit(1); }
    console.log("manifest", m.manifest_version, "has both new triggers");'
  for f in training-library-admin sample-redaction-bridge; do
    awk -v f="[functions.$f]" '$0==f{getline; if ($0 ~ /verify_jwt = false/) ok=1} END{exit !ok}' supabase/config.toml \
      && echo "config.toml: $f verify_jwt=false" || { echo "config.toml: $f entry missing"; return 1; }
  done
  [ -f scripts/rollbacks/rollback_20261013090000_sample_redaction_worker.sql ] || { echo "rollback missing"; return 1; }
  local dup; dup="$(ls supabase/migrations | sed -n 's/^\([0-9]\{14\}\)_.*/\1/p' | sort | uniq -d)"
  [ -z "$dup" ] && echo "no duplicate migration versions" || { echo "duplicate migration versions: $dup"; return 1; }
  if grep -qiE 'update +(public\.)?feature_flags|insert +into +(public\.)?feature_flags' supabase/migrations/20261013090000_sample_redaction_worker.sql; then
    echo "migration writes feature_flags"; return 1; fi
  echo "rollback present; migration flips no flags"
}
step "repo: manifest, config.toml, rollback" "manifest + verify_jwt entries + rollback in place" wiring

hygiene() {
  local files bad=0
  files="$( { git diff --name-only origin/main...HEAD 2>/dev/null; git diff --name-only; git ls-files --others --exclude-standard; } | sort -u | grep -v '^$')"
  echo "$files" | sed 's/^/  /'
  # secret-shaped strings in anything this branch adds or changes
  if echo "$files" | while read -r f; do [ -f "$f" ] && echo "$f"; done | xargs grep -nIE \
      'sk-or-v1-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{32,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}|KEY[0-9A-F]{24,}|(ASSEMBLYAI_API_KEY|OPENROUTER_API_KEY|_SECRET)=[^.$ "`]{12,}' 2>/dev/null; then
    echo "^ secret-shaped value in a branch file"; bad=1; fi
  for f in .env.local fixtures/out/x.mp3 .next/x; do
    git -C "$W" check-ignore -q "$f" || { echo "sample-redactor/$f is NOT gitignored"; bad=1; }
  done
  if echo "$files" | grep -E '(^|/)\.env|fixtures/out/|\.mp3$|\.wav$'; then echo "^ env file or audio would be committed"; bad=1; fi
  return $bad
}
step "repo: no secrets, no audio, no env files" "nothing sensitive in the branch" hygiene

# ── 8. frontend (/am/recording-library + /admin/recording-library) ────────────
cd "$ROOT"
if [ $FRESH = 1 ] || [ ! -d node_modules ]; then
  step "frontend: npm ci" "deps installed" npm ci --no-audit --no-fund
else
  skip "frontend: npm ci" "node_modules present (use --fresh to reinstall)"
fi
OURS='src/pages/admin/RecordingLibrary.tsx|src/components/recording-library/|src/lib/recordingLibraryFlag.ts|src/App.tsx|src/components/AdminLayout.tsx|src/components/AMLayout.tsx'
fe_tsc() {
  npx tsc -p tsconfig.app.json --noEmit > "$LOGDIR/tsc-app.txt" 2>&1
  local total ours
  total="$(grep -c 'error TS' "$LOGDIR/tsc-app.txt")"
  ours="$(grep 'error TS' "$LOGDIR/tsc-app.txt" | grep -cE "$OURS")"
  echo "errors: $total total (repo baseline 5, none from this branch expected); in this branch's files: $ours"
  grep 'error TS' "$LOGDIR/tsc-app.txt" | sed 's/^/  /'
  [ "$ours" = "0" ]
}
step "frontend: typecheck (this branch adds no errors)" "0 new errors (baseline 5 untouched)" fe_tsc
step "frontend: eslint on the new page + components" "lint clean" \
  npx eslint src/pages/admin/RecordingLibrary.tsx src/components/recording-library src/lib/recordingLibraryFlag.ts
fe_lint_changed() {  # repo lint is not clean on main (≈700 errors): edited files must not get worse
  local f now was bad=0
  for f in src/App.tsx src/components/AdminLayout.tsx src/components/AMLayout.tsx; do
    now="$(npx eslint -f json "$f" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].errorCount')"
    was="$(git show "origin/main:$f" | npx eslint -f json --stdin --stdin-filename "$f" | node -p 'JSON.parse(require("fs").readFileSync(0,"utf8"))[0].errorCount')"
    echo "$f: $now errors (main: $was)"
    [ "$now" -le "$was" ] || bad=1
  done
  return $bad
}
step "frontend: eslint on edited files (no new errors vs main)" "App.tsx, AdminLayout.tsx, AMLayout.tsx no worse than main" fe_lint_changed
step "sample-redactor: eslint with the repo rules" "lint clean (repo-wide npm run lint gains nothing)" \
  npx eslint sample-redactor --ignore-pattern '**/.next/**' --ignore-pattern '**/.well-known/**' --ignore-pattern 'sample-redactor/node_modules/**'
step "frontend: vite production build" "build ok" npm run build

# ── 9. real vendors on the synthetic calls ────────────────────────────────────
cd "$W"
VENDOR_NOTE=""
if [ $OFFLINE = 1 ]; then
  skip "vendors: real-audio leak eval" "--offline"
elif [ -z "${ASSEMBLYAI_API_KEY:-}" ]; then
  skip "vendors: real-audio leak eval" "ASSEMBLYAI_API_KEY not set (env or sample-redactor/.env.local)"
else
  [ -z "${OPENROUTER_API_KEY:-}" ] && VENDOR_NOTE=" (OPENROUTER_API_KEY not set: model PII pass, clips + coaching skipped)"
  EVAL_ARGS=(); [ $SKIP_LONG = 1 ] && EVAL_ARGS+=(--skip-long)
  step "vendors: real-audio leak eval$VENDOR_NOTE" "no planted value audible or in transcripts; clips valid + stable x3; no PII in coaching" npm run eval -- "${EVAL_ARGS[@]}"
fi

# ── report ────────────────────────────────────────────────────────────────────
{
  echo "# Sample redaction — validation $STAMP"
  echo
  echo "- branch \`$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)\` @ \`$(git -C "$ROOT" rev-parse --short HEAD)\`$( [ -n "$(git -C "$ROOT" status --porcelain)" ] && echo ' + uncommitted changes')"
  echo "- $(node -v), $(uname -sm), ffmpeg rubberband: $RB"
  echo "- vendors: $( [ $OFFLINE = 1 ] && echo 'off (--offline)' || { [ -n "${ASSEMBLYAI_API_KEY:-}" ] && echo "AssemblyAI on, OpenRouter $( [ -n "${OPENROUTER_API_KEY:-}" ] && echo on || echo off)" || echo 'no keys'; })"
  echo "- live systems touched: none"
  echo
  echo "| result | check | time | detail |"
  echo "|---|---|---|---|"
  printf '%s\n' "${RESULTS[@]}"
  echo
  if [ -f "$OUT/eval-report.json" ] && [ "$(find "$OUT/eval-report.json" -newer "$LOGDIR" 2>/dev/null)" ]; then
    echo "## Vendor eval (synthetic calls, fictional values)"
    echo
    node -e '
      const r=require(process.argv[1]); console.log(r.summary+"\n");
      console.log("| call | min | bleeped | leaks | transcript leaks | second pass | clips (labels) | stable x runs | coaching PII | over-bleeped | llm $ |");
      console.log("|---|---|---|---|---|---|---|---|---|---|---|");
      for (const c of r.reports) {
        if (c.error) { console.log(`| ${c.call} | — | — | — | — | — | error: ${c.error} | — | — | — | — |`); continue; }
        const k = c.clips || {};
        const j = (a) => a && a.length ? a.join("<br>") : "none";
        const lb = k.skipped ? "skipped" : `${k.clips} (${k.labels || "—"})${k.labels_ok ? "" : " INVALID"}${k.errors && k.errors.length ? " err: " + k.errors.join("; ") : ""}`;
        const st = k.skipped ? "—" : `${k.stable_across_runs ? "yes" : "NO"} (${k.valid_runs}/${k.runs})`;
        console.log(`| ${c.call} | ${c.duration_min} | ${c.bleeped_share} | ${j(c.leaks)} | ${j(c.transcript_leaks)} | ${j([...(c.second_pass||[]), ...(k.clip_second_pass||[])])} | ${lb} | ${st} | ${k.skipped ? "—" : j(k.coaching_pii)} | ${c.over_bleeped_words ?? "—"} | ${(c.llm.cost_usd + (k.cost_usd||0)).toFixed(4)} |`);
      }' "$OUT/eval-report.json"
    echo
    echo "Listen: \`sample-redactor/fixtures/out/*.redacted.mp3\` and \`*.clips/cN.mp3\` · read: \`*.redacted.txt\`, \`*.clips.json\`, \`*.coaching.json\`."
  fi
  echo
  echo "Logs: \`sample-redactor/fixtures/out/$(basename "$LOGDIR")/\` (no secrets; test-call values are fictional)."
} > "$REPORT"

echo
echo "$FAILS failed · report: $REPORT"
[ $FAILS = 0 ]
