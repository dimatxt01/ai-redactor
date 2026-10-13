#!/usr/bin/env bash
# Validation of the ai-redactor repo, on this machine only.
# Touches NOTHING live: no Supabase project, no deploy. The only
# network calls are npm/deno downloads and, when keys are set, AssemblyAI +
# OpenRouter on the synthetic test calls (every value in them is fictional).
#
#   npm run validate                                    # everything; vendors if keys are set
#   npm run validate -- --offline                       # never call the vendors
#   npm run validate -- --fresh                         # clean npm ci first
#   npm run validate -- --skip-long                     # vendor eval without the 47-min call (~$1 of the ~$1.6)
#
# Keys: export ASSEMBLYAI_API_KEY / OPENROUTER_API_KEY, or put them in
# .env.local (gitignored). They are never printed or written out.
# The TrueRing frontend checks need a TrueRing checkout: bash truering/check.sh /path/to/truering
# Report: fixtures/out/validation-<time>.md (gitignored) — send that file back.
set -uo pipefail

W="$(cd "$(dirname "$0")/.." && pwd)"
ROOT="$W"
TRS="$W/truering"   # the TrueRing side, at its TrueRing paths
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

echo "ai-redactor validation · $STAMP"
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
step "worker: unit tests (detectors, DSP, HMAC, retries, logs)" "all passed" npx vitest run

FFMPEG="$(node -p 'require("ffmpeg-static")' 2>/dev/null)"
RB="$("$FFMPEG" -hide_banner -filters 2>/dev/null | grep -q rubberband && echo yes || echo 'no (resample fallback on this machine)')"

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

# ── 4. the worker process itself ──────────────────────────────────────────────
selfcheck() {   # refuses without config; with config (dummy values) the bundled ffmpeg must run here
  if env -u TR_BRIDGE_URL -u SAMPLE_REDACTOR_BRIDGE_SECRET -u ASSEMBLYAI_API_KEY -u OPENROUTER_API_KEY node --import tsx src/check.ts; then
    echo "check passed without any config"; return 1; fi
  TR_BRIDGE_URL=https://example.invalid/functions/v1/sample-redaction-bridge SAMPLE_REDACTOR_BRIDGE_SECRET=x ASSEMBLYAI_API_KEY=x OPENROUTER_API_KEY=x \
    node --import tsx src/check.ts
}
step "worker: self-check (refuses without config; ffmpeg runs)" "missing env refused; ffmpeg ok" selfcheck
if docker info >/dev/null 2>&1; then
  dockerbuild() {
    docker build -q -t ai-redactor:validate . && \
    docker run --rm -e TR_BRIDGE_URL=https://example.invalid/x -e SAMPLE_REDACTOR_BRIDGE_SECRET=x -e ASSEMBLYAI_API_KEY=x -e OPENROUTER_API_KEY=x \
      ai-redactor:validate node --import tsx src/check.ts
  }
  step "docker: image builds; ffmpeg runs inside it (linux)" "image ok" dockerbuild
else
  skip "docker: image build" "Docker not running"
fi

# ── 5. TrueRing side (what can run without a TrueRing checkout) ──────────────
cd "$TRS/supabase/functions"
step "TR edge functions: deno check (bridge + shared helpers)" "typecheck" "${DENO[@]}" check --no-lock --node-modules-dir=none sample-redaction-bridge/index.ts _shared/sampleSignature.ts _shared/telnyxRecording.ts
step "TR edge functions: deno check (training-library-admin, TR helpers stubbed)" "typecheck" \
  "${DENO[@]}" check --no-lock --node-modules-dir=none --import-map="$W/sim/supabase/check_map.json" training-library-admin/index.ts
cd "$W"
step "HMAC parity: Deno (TR) ↔ Node (worker)" "same header; same refusals" "${DENO[@]}" run --no-lock --node-modules-dir=none scripts/signature-parity.ts

if command -v initdb >/dev/null || ls /opt/homebrew/opt/postgresql@1[5-9]/bin/initdb /usr/lib/postgresql/1[5-9]/bin/initdb >/dev/null 2>&1; then
  HAVE_PG=1
  step "migration: throwaway Postgres on RL-1 (caps, race, guards, ingest, takedown, rollback)" "all cases pass; RL-1 cases still pass on top" \
    bash "$TRS/supabase/tests/sample_redaction/run.sh"
  step "RL-1 migration tests (unchanged, as on TrueRing main)" "RL-1 cases pass" bash "$TRS/supabase/tests/training_library/run.sh"
else
  HAVE_PG=0
  skip "migration: throwaway Postgres" "no local PostgreSQL 15+ (brew install postgresql@17)"
fi

# ── 6. the whole system on this machine ───────────────────────────────────────
if [ $HAVE_PG = 1 ]; then
  step "simulation: AM → training-library-admin → worker → bridge → library → QA → publish → delete" \
    "every scenario passed (sim-out/*/report.md)" npx tsx sim/run.ts --no-build
  SIM_REPORT="$(ls -td "$W"/sim-out/*/ 2>/dev/null | head -1)report.md"
else
  skip "simulation" "needs local PostgreSQL 15+"
fi

# ── 7. repo hygiene ───────────────────────────────────────────────────────────
wiring() {
  local f; for f in $(cat truering/FILES); do [ -f "truering/$f" ] || { echo "truering/FILES lists a missing file: $f"; return 1; }; done
  echo "truering/FILES: $(wc -l < truering/FILES | tr -d ' ') files present"
  grep -q '^diff --git' truering/existing-files.patch || { echo "existing-files.patch is empty"; return 1; }
  echo "existing-files.patch: $(grep -c '^diff --git' truering/existing-files.patch) files"
  [ -f truering/scripts/rollbacks/rollback_20261013090000_sample_redaction_worker.sql ] || { echo "rollback missing"; return 1; }
  if grep -qiE 'update +(public\.)?feature_flags|insert +into +(public\.)?feature_flags' truering/supabase/migrations/20261013090000_sample_redaction_worker.sql; then
    echo "migration writes feature_flags"; return 1; fi
  echo "rollback present; migration flips no flags"
}
step "repo: truering/ reference copy complete" "FILES present, patch non-empty, rollback in place" wiring

hygiene() {
  local files bad=0
  files="$( { git ls-files; git ls-files --others --exclude-standard; } | sort -u | grep -v '^$')"
  if echo "$files" | while read -r f; do [ -f "$f" ] && echo "$f"; done | xargs grep -nIE \
      'sk-or-v1-[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{32,}|eyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}|KEY[0-9A-F]{24,}|(ASSEMBLYAI_API_KEY|OPENROUTER_API_KEY|_SECRET)=[^.$ "`]{12,}' 2>/dev/null; then
    echo "^ secret-shaped value in a repo file"; bad=1; fi
  for f in .env.local fixtures/out/x.mp3 sim-out/x; do
    git -C "$W" check-ignore -q "$f" || { echo "$f is NOT gitignored"; bad=1; }
  done
  if echo "$files" | grep -E '(^|/)\.env($|\.)|fixtures/out/|sim-out/|\.mp3$|\.wav$' | grep -v '\.env\.example$'; then echo "^ env file or audio would be committed"; bad=1; fi
  echo "$(echo "$files" | wc -l | tr -d ' ') files checked"
  return $bad
}
step "repo: no secrets, no audio, no env files" "nothing sensitive in the repo" hygiene

# ── 9. real vendors on the synthetic calls ────────────────────────────────────
cd "$W"
VENDOR_NOTE=""
if [ $OFFLINE = 1 ]; then
  skip "vendors: real-audio leak eval" "--offline"
elif [ -z "${ASSEMBLYAI_API_KEY:-}" ]; then
  skip "vendors: real-audio leak eval" "ASSEMBLYAI_API_KEY not set (env or .env.local)"
else
  [ -z "${OPENROUTER_API_KEY:-}" ] && VENDOR_NOTE=" (OPENROUTER_API_KEY not set: model PII pass, clips + coaching skipped)"
  EVAL_ARGS=(); [ $SKIP_LONG = 1 ] && EVAL_ARGS+=(--skip-long)
  step "vendors: real-audio leak eval$VENDOR_NOTE" "no planted value audible or in transcripts; clips valid + stable x3; no PII in coaching" npm run eval -- "${EVAL_ARGS[@]}"
fi

# ── report ────────────────────────────────────────────────────────────────────
{
  echo "# ai-redactor — validation $STAMP"
  echo
  echo "- branch \`$(git -C "$ROOT" rev-parse --abbrev-ref HEAD)\` @ \`$(git -C "$ROOT" rev-parse --short HEAD)\`$( [ -n "$(git -C "$ROOT" status --porcelain)" ] && echo ' + uncommitted changes')"
  echo "- $(node -v), $(uname -sm), ffmpeg rubberband: $RB"
  echo "- vendors: $( [ $OFFLINE = 1 ] && echo 'off (--offline)' || { [ -n "${ASSEMBLYAI_API_KEY:-}" ] && echo "AssemblyAI on, OpenRouter $( [ -n "${OPENROUTER_API_KEY:-}" ] && echo on || echo off)" || echo 'no keys'; })"
  echo "- live systems touched: none"
  [ -n "${SIM_REPORT:-}" ] && [ -f "$SIM_REPORT" ] && echo "- simulation report: \`${SIM_REPORT#$W/}\` ($(grep -o '[0-9]* passed, [0-9]* failed' "$SIM_REPORT" | head -1))"
  echo "- TrueRing frontend + full deno check: \`bash truering/check.sh /path/to/truering\` in a checkout of Mahamadou2004/truering feat/sample-redaction"
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
    echo "Listen: \`fixtures/out/*.redacted.mp3\` and \`*.clips/cN.mp3\` · read: \`*.redacted.txt\`, \`*.clips.json\`, \`*.coaching.json\`."
  fi
  echo
  echo "Logs: \`fixtures/out/$(basename "$LOGDIR")/\` (no secrets; test-call values are fictional)."
} > "$REPORT"

echo
echo "$FAILS failed · report: $REPORT"
[ $FAILS = 0 ]
