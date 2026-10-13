#!/usr/bin/env bash
# 20261013090000_sample_redaction_worker on a throwaway Postgres, never a real database:
#   RL-1 fixture -> RL-1 migration -> this migration -> re-run refused -> cases -> month-cap race
#   -> RL-1's own cases still pass on top -> rollback leaves RL-1 intact -> rollback twice -> re-apply.
# Usage: bash supabase/tests/sample_redaction/run.sh   (PostgreSQL 15+; PGBIN overrides the lookup)
set -euo pipefail
export LC_ALL="${LC_ALL:-C.UTF-8}"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@1[5-9]/bin 2>/dev/null | tail -1 || true)}"
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../../.."
B="$(mktemp -d "${TMPDIR:-/tmp}/pgt_srw.XXXX")"; PORT="${PORT:-5464}"
"$PGBIN/initdb" -D "$B/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$B/data" -o "-p $PORT -k $B -c listen_addresses=''" -l "$B/log" -w start >/dev/null || { cat "$B/log"; exit 1; }
trap '"$PGBIN/pg_ctl" -D "$B/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$B"' EXIT
P=("$PGBIN/psql" -X -h "$B" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
RL1="$ROOT/supabase/migrations/20261012180000_training_library.sql"
M="$ROOT/supabase/migrations/20261013090000_sample_redaction_worker.sql"
R="$ROOT/scripts/rollbacks/rollback_20261013090000_sample_redaction_worker.sql"

"${P[@]}" -f "$ROOT/supabase/tests/training_library/_fixture.sql"
"${P[@]}" -1 -f "$RL1"
"${P[@]}" -1 -f "$M"
echo "ok: migration applies on RL-1"
if "${P[@]}" -1 -f "$M" >/dev/null 2>&1; then echo "FAIL: migration re-run succeeded"; exit 1; else echo "ok: re-run refused by preconditions"; fi

"${P[@]}" -f "$HERE/test.sql" 2>&1 | grep -E "ok:|PASS|FAIL|ERROR"
"${P[@]}" -At -c "select 1" >/dev/null

echo "--- month-cap race: two sessions submit at once, the cap allows one"
"${P[@]}" -c "update sample_redaction_jobs set created_at = now() - interval '40 days'" >/dev/null
race() {
  "${P[@]}" -At -c "begin; set role service_role;
    select public.sample_job_insert('cccccccc-0000-0000-0000-00000000000$1', 9, '{}', '{}', null, 60, 100)->>'ok';
    select pg_sleep(2); commit;" | head -1
}
race 2 > "$B/r1" & race 3 > "$B/r2" & wait
oks="$(cat "$B/r1" "$B/r2" | grep -c true || true)"
[ "$oks" = "1" ] && echo "ok: month cap race, sessions passing = 1" || { echo "FAIL: month cap race, sessions passing = $oks"; exit 1; }

echo "--- RL-1's own cases on top of this migration"
"${P[@]}" -c "set storage.allow_delete_query = 'true'; truncate training_library_reviews, training_library_ratings, training_library_clips,
  training_library_call_sources, training_library_calls, agent_training_consents, sample_redaction_jobs cascade;
  delete from calls where id::text like 'cccccccc-0000-0000-0000-00000000000%' and id::text > 'cccccccc-0000-0000-0000-000000000003'" >/dev/null
out="$("${P[@]}" -f "$ROOT/supabase/tests/training_library/test.sql" 2>&1)"
echo "$out" | grep -qx " PASS" || echo "$out" | grep -q "^ PASS" || { echo "$out" | tail -5; echo "FAIL: RL-1 cases broke on top of this migration"; exit 1; }
echo "ok: RL-1 cases pass with this migration applied"

"${P[@]}" -f "$R"
"${P[@]}" -f "$R"
left="$("${P[@]}" -At -c "select (select count(*) from information_schema.columns where table_schema='public' and table_name='sample_redaction_jobs'
   and column_name in ('version','options','call_meta','cost_usd','reserved_usd','workflow_run_id','delete_requested_at','deleted_at'))
 + (select count(*) from pg_proc where proname in ('sample_month_committed_usd','sample_job_insert','sample_job_retry','sample_library_ingest',
   'sample_redaction_jobs_service_columns','sample_redaction_takedown_guard'))
 + (select count(*) from pg_trigger where tgname in ('sample_redaction_jobs_service_columns','sample_redaction_takedown_guard'))")"
[ "$left" = "0" ] || { echo "FAIL: rollback left $left objects"; exit 1; }
rl1="$("${P[@]}" -At -c "select count(*) from pg_trigger where not tgisinternal and tgname in
  ('training_library_publish_gate','training_library_reviews_append_only','training_library_consent_revoked')")"
[ "$rl1" = "3" ] || { echo "FAIL: rollback touched RL-1 triggers"; exit 1; }
echo "ok: rollback (twice) removes everything this migration added and leaves RL-1's triggers"
"${P[@]}" -c "truncate sample_redaction_jobs cascade" >/dev/null
"${P[@]}" -1 -f "$M"
echo "ok: re-apply after rollback"
echo "sample redaction migration tests: PASS"
