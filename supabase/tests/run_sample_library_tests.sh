#!/usr/bin/env bash
# =========================================================================
# Sample library migration on a throwaway Postgres, never a real database:
#   stub schema → migration (incl. its self-verify block) → invariant tests
#   → month-cap race (two sessions at once) → re-apply (idempotent)
#   → rollback leaves nothing behind → apply again after rollback.
#
# Usage:  bash supabase/tests/run_sample_library_tests.sh
# Requires: local PostgreSQL binaries (15+; PGBIN overrides the lookup).
# =========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$HERE/../.."
MIG="$ROOT/supabase/migrations/20261012230000_sample_library.sql"
RB="$ROOT/scripts/rollbacks/rollback_20261012230000_sample_library.sql"

if [ -z "${PGBIN:-}" ]; then
  for c in /opt/homebrew/opt/postgresql@17/bin /opt/homebrew/opt/postgresql@16/bin /opt/homebrew/opt/postgresql@15/bin \
           /usr/lib/postgresql/17/bin /usr/lib/postgresql/16/bin /usr/lib/postgresql/15/bin; do
    [ -x "$c/initdb" ] && PGBIN="$c" && break
  done
fi
[ -n "${PGBIN:-}" ] || { PGBIN="$(dirname "$(command -v initdb)")"; }
ver="$("$PGBIN/postgres" --version | grep -oE '[0-9]+' | head -1)"
[ "$ver" -ge 15 ] || { echo "need PostgreSQL 15+ (found $ver at $PGBIN; set PGBIN)"; exit 2; }

B="$(mktemp -d "${TMPDIR:-/tmp}/sample_lib_pg.XXXXXX")"
PORT="${PORT:-5457}"
cleanup() { "$PGBIN/pg_ctl" -D "$B/data" -w stop >/dev/null 2>&1 || true; rm -rf "$B"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$B/data" -U postgres --auth=trust >/dev/null
"$PGBIN/pg_ctl" -D "$B/data" -o "-k $B -p $PORT -c listen_addresses=''" -l "$B/pg.log" -w start >/dev/null
"$PGBIN/createdb" -h "$B" -p "$PORT" -U postgres t
P=("$PGBIN/psql" -X -v ON_ERROR_STOP=1 -h "$B" -p "$PORT" -U postgres -d t -q)

echo "postgres $ver · throwaway cluster in $B"
"${P[@]}" -f "$HERE/sample_library_stub.sql" >/dev/null

echo "=== apply migration (single transaction, as apply_migration does) ==="
"${P[@]}" -1 -f "$MIG"

echo "=== invariants ==="
"${P[@]}" -f "$HERE/sample_library_test.sql"

echo "=== month-cap race: two sessions submit at once, cap allows only one ==="
"${P[@]}" -c "insert into public.calls values ('44444444-0000-0000-0000-000000000001'), ('44444444-0000-0000-0000-000000000002');
              update public.sample_redaction_jobs set status = 'done', cost_usd = 0, created_at = now() - interval '40 days';"
race() {  # each holds its transaction 2 s after inserting; without the advisory lock both would pass
  "${P[@]}" -At -c "begin;
    select public.sample_job_insert('44444444-0000-0000-0000-00000000000$1', 1, 'race:$1', '{}', '{}', null, 60, 100)->>'ok';
    select pg_sleep(2); commit;" | head -1
}
race 1 > "$B/r1" & race 2 > "$B/r2" & wait
oks="$(cat "$B/r1" "$B/r2" | grep -c true || true)"
echo "sessions passing the cap: $oks (want 1)"
[ "$oks" = "1" ] || { echo "FAIL: month cap race"; exit 1; }

echo "=== re-apply migration (idempotent) ==="
"${P[@]}" -1 -f "$MIG"

echo "=== rollback leaves nothing behind ==="
"${P[@]}" -c "delete from public.sample_library_approvals" 2>/dev/null || true  # append-only: the rollback drops the table instead
"${P[@]}" -1 -f "$RB"
left="$("${P[@]}" -At -c "select
  (select count(*) from pg_class where relnamespace = 'public'::regnamespace and relname like 'sample\_%')
+ (select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname like 'sample\_%')
+ (select count(*) from storage.buckets where id in ('sample-work', 'sample-library'))")"
echo "objects left after rollback: $left (want 0)"
[ "$left" = "0" ] || { echo "FAIL: rollback left objects"; exit 1; }

echo "=== apply again after rollback ==="
"${P[@]}" -1 -f "$MIG"

echo "ALL SAMPLE LIBRARY MIGRATION TESTS PASSED"
