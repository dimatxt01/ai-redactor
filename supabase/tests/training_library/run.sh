#!/usr/bin/env bash
# RL-1: throwaway Postgres -> Supabase-shaped fixture -> migration -> verify -> cases -> rollback -> rollback re-run -> re-apply -> rollback.
# Usage: bash supabase/tests/training_library/run.sh
set -euo pipefail
export LC_ALL="${LC_ALL:-C.UTF-8}"
PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin /opt/homebrew/opt/postgresql@17/bin 2>/dev/null | tail -1 || true)}"
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../../.."
B="$(mktemp -d /tmp/pgt_rl1.XXXX)"; PORT="${PORT:-5463}"
"$PGBIN/initdb" -D "$B/data" -U postgres -A trust >/dev/null
"$PGBIN/pg_ctl" -D "$B/data" -o "-p $PORT -k $B" -l "$B/log" -w start >/dev/null || { cat "$B/log"; exit 1; }
trap '"$PGBIN/pg_ctl" -D "$B/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$B"' EXIT
P=("$PGBIN/psql" -h "$B" -p "$PORT" -U postgres -d postgres -v ON_ERROR_STOP=1 -q)
M="$ROOT/supabase/migrations/20261012180000_training_library.sql"
R="$ROOT/scripts/rollbacks/rollback_20261012180000_training_library.sql"
V="${VERIFY_SQL:-$ROOT/scripts/verify/verify_20261012180000_training_library.sql}"
"${P[@]}" -f "$HERE/_fixture.sql"
"${P[@]}" -1 -f "$M"
if ! "${P[@]}" -1 -f "$M" >/dev/null 2>&1; then echo "ok: re-run refused by preconditions"; else echo "FAIL: migration re-run succeeded"; exit 1; fi
if [ -n "$V" ]; then "${P[@]}" -At -F' ' -c "$(cat "$V")" | tee "$B/verify.out"; grep -q " f " "$B/verify.out" && { echo "FAIL: verify has a false gate"; exit 1; }; fi
"${P[@]}" -f "$HERE/test.sql" 2>&1 | grep -E "ok:|PASS|FAIL|ERROR"
"${P[@]}" -At -c "insert into storage.objects (bucket_id, name) values ('training-library','x')"
if "${P[@]}" -f "$R" >/dev/null 2>&1; then echo "FAIL: rollback ran with a non-empty bucket"; exit 1; else echo "ok: rollback refuses non-empty bucket"; fi
"${P[@]}" -At -c "set storage.allow_delete_query = 'true'; delete from storage.objects"
"${P[@]}" -f "$R"
"${P[@]}" -f "$R"                                     # idempotent rollback
"${P[@]}" -At -c "select count(*) from pg_class where relnamespace='public'::regnamespace and (relname like 'training_library%' or relname in ('sample_redaction_jobs','agent_training_consents'))" | grep -qx 0
"${P[@]}" -At -c "select count(*) from storage.buckets where id in ('sample-src','training-library')" | grep -qx 0
"${P[@]}" -At -c "select count(*) from feature_flags where key='recording_library'" | grep -qx 0
"${P[@]}" -At -c "select count(*) from pg_proc where proname like 'training_library_%'" | grep -qx 0
"${P[@]}" -1 -f "$M"                                  # re-apply after rollback
"${P[@]}" -f "$R"
echo "RL-1 tests: PASS (migration, re-run refused, cases, rollback guard, rollback, re-run, re-apply, rollback)"
