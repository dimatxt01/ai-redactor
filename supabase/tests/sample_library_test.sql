-- Invariants of 20261012230000_sample_library.sql, run on a throwaway Postgres by
-- run_sample_library_tests.sh (stub schema: sample_library_stub.sql). Each block
-- raises on the first broken invariant; the run stops there (ON_ERROR_STOP).
\set ON_ERROR_STOP 1

create function pg_temp.refused(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  execute p_sql;
  raise exception 'EXPECTED REFUSAL, statement succeeded: %', p_sql;
exception when others then
  if sqlerrm like 'EXPECTED REFUSAL%' then raise; end if;
  if sqlerrm !~* p_pattern then
    raise exception 'refused for the wrong reason: % (wanted /%/) — %', sqlerrm, p_pattern, p_sql;
  end if;
end $$;

-- fixtures: two admins (qa, legal), one non-admin, three calls
insert into auth.users values
  ('00000000-0000-0000-0000-0000000000a1'), ('00000000-0000-0000-0000-0000000000a2'), ('00000000-0000-0000-0000-0000000000b1');
insert into public.user_roles values
  ('00000000-0000-0000-0000-0000000000a1', 'admin'), ('00000000-0000-0000-0000-0000000000a2', 'superadmin'),
  ('00000000-0000-0000-0000-0000000000b1', 'agent');
insert into public.calls values
  ('11111111-0000-0000-0000-000000000001'), ('11111111-0000-0000-0000-000000000002'), ('11111111-0000-0000-0000-000000000003');

\echo '--- 1. month budget: reserve, cap, duplicate'
do $$
declare r jsonb;
begin
  r := public.sample_job_insert('11111111-0000-0000-0000-000000000001', 1, 'call:1:v1', '{}', '{}', null, 1.50, 2.00);
  assert (r->>'ok')::boolean, format('first insert refused: %s', r);
  r := public.sample_job_insert('11111111-0000-0000-0000-000000000002', 1, 'call:2:v1', '{}', '{}', null, 1.00, 2.00);
  assert r->>'reason' = 'cost_cap', format('cap not enforced on reservations: %s', r);
  r := public.sample_job_insert('11111111-0000-0000-0000-000000000001', 1, 'call:1:v1', '{}', '{}', null, 0.10, 100);
  assert r->>'reason' = 'duplicate', format('duplicate key not caught: %s', r);
  -- a running job counts max(cost, reserved); a finished one counts its actual cost
  update public.sample_redaction_jobs set cost_usd = 1.80 where idempotency_key = 'call:1:v1';
  assert public.sample_month_committed_usd() = 1.80, 'running job: max(cost, reserved)';
  update public.sample_redaction_jobs set status = 'done', cost_usd = 0.40 where idempotency_key = 'call:1:v1';
  assert public.sample_month_committed_usd() = 0.40, 'done job: actual cost only';
  r := public.sample_job_insert('11111111-0000-0000-0000-000000000002', 1, 'call:2:v1', '{}', '{}', null, 1.00, 2.00);
  assert (r->>'ok')::boolean, format('budget not released after done: %s', r);
  -- last month's spend does not count
  update public.sample_redaction_jobs set created_at = now() - interval '40 days' where idempotency_key = 'call:1:v1';
  assert public.sample_month_committed_usd() = 1.00, 'previous month leaked into this month';
end $$;

\echo '--- 2. retry: only failed jobs, re-reserves on top of spend, refuses a tombstoned call'
do $$
declare r jsonb; v_id uuid;
begin
  select id into v_id from public.sample_redaction_jobs where idempotency_key = 'call:2:v1';
  r := public.sample_job_retry(v_id, 0.50, 100);
  assert r->>'reason' = 'not_failed', format('retried a running job: %s', r);
  update public.sample_redaction_jobs set status = 'failed', cost_usd = 0.30, workflow_run_id = 'run_x' where id = v_id;
  r := public.sample_job_retry(v_id, 0.50, 100);
  assert (r->>'ok')::boolean, format('retry refused: %s', r);
  assert (select status = 'queued' and reserved_usd = 0.80 and workflow_run_id is null from public.sample_redaction_jobs where id = v_id),
    'retry did not reset to queued with reserved = cost + estimate';
  update public.sample_redaction_jobs set status = 'failed', delete_requested_at = now() where id = v_id;
  r := public.sample_job_retry(v_id, 0.50, 100);
  assert r->>'reason' = 'deleted', format('retry ran on a tombstoned call: %s', r);
  r := public.sample_job_insert('11111111-0000-0000-0000-000000000002', 2, 'call:2:v2', '{}', '{}', null, 0.10, 100);
  assert r->>'reason' = 'deleted', format('submit ran on a tombstoned call: %s', r);
end $$;

\echo '--- 3. publish gate'
insert into public.sample_redaction_jobs (id, call_id, version, idempotency_key, status)
values ('22222222-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000003', 1, 'call:3:v1', 'done');
insert into public.sample_library (id, call_id, job_id, version, agent_ref, vertical, redacted_audio_path, redacted_audio_sha256,
  transcript_json_path, transcript_json_sha256, pii_spans_json_path, pii_spans_json_sha256, pipeline_version)
values ('33333333-0000-0000-0000-000000000003', '11111111-0000-0000-0000-000000000003', '22222222-0000-0000-0000-000000000003', 1,
  'agent_ref_x', 'final_expense', 'p/redacted.mp3', 'h', 'p/t.json', 'h', 'p/s.json', 'h', 'sr-1.0.0');

do $$
declare L constant text := '33333333-0000-0000-0000-000000000003';
        QA constant text := '00000000-0000-0000-0000-0000000000a1';
        LG constant text := '00000000-0000-0000-0000-0000000000a2';
begin
  perform pg_temp.refused(format('update public.sample_library set status = ''qa_passed'' where id = %L', L), 'needs a qa approval');
  insert into public.sample_library_approvals (library_id, step, actor, decision, listened_full) values (L::uuid, 'qa', QA::uuid, 'approve', false);
  perform pg_temp.refused(format('update public.sample_library set status = ''qa_passed'' where id = %L', L), 'needs a qa approval');
  insert into public.sample_library_approvals (library_id, step, actor, decision, listened_full) values (L::uuid, 'qa', QA::uuid, 'approve', true);
  update public.sample_library set status = 'qa_passed' where id = L::uuid;

  perform pg_temp.refused(format('update public.sample_library set status = ''legal_approved'' where id = %L', L), 'needs a legal approval');
  insert into public.sample_library_approvals (library_id, step, actor, decision, listened_full) values (L::uuid, 'legal', QA::uuid, 'approve', true);
  perform pg_temp.refused(format('update public.sample_library set status = ''legal_approved'' where id = %L', L), 'different people');
  insert into public.sample_library_approvals (library_id, step, actor, decision, listened_full) values (L::uuid, 'legal', LG::uuid, 'approve', true);
  update public.sample_library set status = 'legal_approved' where id = L::uuid;

  perform pg_temp.refused(format('update public.sample_library set status = ''published'' where id = %L', L), 'consent_ref');
  perform pg_temp.refused(format('update public.sample_library set status = ''published'', consent_ref = ''  '' where id = %L', L), 'consent_ref');
  perform pg_temp.refused(format('update public.sample_library set status = ''published'', consent_ref = ''rel-1'', vertical = ''medicare'' where id = %L', L), 'final_expense');
  update public.sample_library set status = 'published', consent_ref = 'rel-1' where id = L::uuid;
  assert (select published_at is not null from public.sample_library where id = L::uuid), 'published_at not stamped';
  perform pg_temp.refused(format('update public.sample_library set consent_ref = null where id = %L', L), 'consent_ref');

  -- the LATEST decision decides: a later qa reject blocks the published row's next write
  insert into public.sample_library_approvals (library_id, step, actor, decision, listened_full) values (L::uuid, 'qa', QA::uuid, 'reject', true);
  perform pg_temp.refused(format('update public.sample_library set title = ''x'' where id = %L', L), 'needs a qa approval');
  update public.sample_library set status = 'withdrawn' where id = L::uuid;
  assert (select withdrawn_at is not null from public.sample_library where id = L::uuid), 'withdrawn_at not stamped';

  -- a gated status can't be written straight in by INSERT either
  perform pg_temp.refused($q$insert into public.sample_library (call_id, job_id, version, agent_ref, vertical, redacted_audio_path,
      redacted_audio_sha256, transcript_json_path, transcript_json_sha256, pii_spans_json_path, pii_spans_json_sha256, pipeline_version,
      status, consent_ref)
    values ('11111111-0000-0000-0000-000000000001', (select id from public.sample_redaction_jobs where idempotency_key = 'call:1:v1'), 1,
      'a', 'final_expense', 'p', 'h', 'p', 'h', 'p', 'h', 'sr-1.0.0', 'published', 'rel-1')$q$, 'needs a qa approval');
end $$;

\echo '--- 4. approvals are append-only; deleted samples stay withdrawn'
do $$
declare L constant text := '33333333-0000-0000-0000-000000000003';
begin
  perform pg_temp.refused('update public.sample_library_approvals set decision = ''approve''', 'append-only');
  perform pg_temp.refused('delete from public.sample_library_approvals', 'append-only');
  update public.sample_library set deleted_at = now() where id = L::uuid;
  perform pg_temp.refused(format('update public.sample_library set status = ''pending_qa'' where id = %L', L), 'stay withdrawn');
  perform pg_temp.refused(format('update public.sample_library set deleted_at = null where id = %L', L), 'stay withdrawn');
  perform pg_temp.refused(format('delete from public.calls where id = %L', '11111111-0000-0000-0000-000000000003'), 'foreign key');
end $$;

\echo '--- 5. browser roles: admins read, nobody else reads, nobody writes, nobody calls the budget functions'
set role authenticated;
do $$ begin perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000b1', false); end $$;
do $$ begin
  assert (select count(*) from public.sample_redaction_jobs) = 0, 'non-admin can read jobs';
  assert (select count(*) from public.sample_library) = 0, 'non-admin can read library';
  assert (select count(*) from public.sample_library_manifest) = 0, 'non-admin can read the manifest view';
end $$;
do $$ begin perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000a1', false); end $$;
do $$ begin
  assert (select count(*) from public.sample_redaction_jobs) = 3, 'admin cannot read jobs';
  assert (select count(*) from public.sample_library) = 1, 'admin cannot read library';
  assert (select count(*) from public.sample_library_approvals) >= 5, 'admin cannot read approvals';
  assert (select count(*) from public.sample_library_manifest) = 1, 'admin cannot read the manifest view';
  perform pg_temp.refused('update public.sample_library set title = ''x''', 'permission denied');
  perform pg_temp.refused('insert into public.sample_library_approvals (library_id, step, actor, decision, listened_full)
    values (''33333333-0000-0000-0000-000000000003'', ''qa'', auth.uid(), ''approve'', true)', 'permission denied');
  perform pg_temp.refused('update public.sample_redaction_jobs set cost_usd = 0', 'permission denied');
  perform pg_temp.refused('select public.sample_month_committed_usd()', 'permission denied');
  perform pg_temp.refused('select public.sample_job_insert(gen_random_uuid(), 1, ''k'', ''{}'', ''{}'', null, 0, 100)', 'permission denied');
end $$;
reset role;
set role anon;
do $$ begin
  perform pg_temp.refused('select 1 from public.sample_library', 'permission denied');
  perform pg_temp.refused('select public.sample_job_retry(gen_random_uuid(), 0, 100)', 'permission denied');
end $$;
reset role;
set role service_role;
do $$ begin
  assert (public.sample_job_insert('11111111-0000-0000-0000-000000000001', 9, 'call:1:v9', '{}', '{}', null, 0.10, 100)->>'ok')::boolean,
    'service_role cannot call sample_job_insert';
end $$;
reset role;

\echo '--- 6. buckets are private'
do $$ begin
  assert (select count(*) from storage.buckets where id in ('sample-work', 'sample-library') and public = false) = 2, 'buckets missing or public';
  assert (select count(*) from storage.buckets where id in ('sample-work', 'sample-library') and file_size_limit = 209715200) = 2, 'bucket size limit';
end $$;

\echo 'sample_library_test.sql: all invariants hold'
