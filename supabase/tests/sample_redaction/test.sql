-- 20261013050000_sample_redaction_worker cases, on top of RL-1 (run.sh applies the RL-1 fixture + RL-1 migration first).
-- Each block asserts; any failure raises and stops the run (ON_ERROR_STOP).
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.as_user(p uuid) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', coalesce(p::text,''), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.expect_fail(p_sql text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'ok: % refused (%)', p_what, SQLSTATE; RETURN; END;
  RAISE EXCEPTION 'FAIL: % was allowed', p_what;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(uuid), pg_temp.expect_fail(text,text) TO authenticated, anon, service_role;
-- Supabase grants service_role every public table (default privileges); the RL-1 fixture only creates them.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
-- fixture people (RL-1 _fixture.sql): admin 22..ad, AM 22..a3, agent X (00..a1, user 11..a1), agent Y (00..a2); calls cc..01-03
INSERT INTO public.calls (id, agent_id, duration) VALUES
  ('cccccccc-0000-0000-0000-000000000004','00000000-0000-0000-0000-0000000000a1',600),
  ('cccccccc-0000-0000-0000-000000000005','00000000-0000-0000-0000-0000000000a1',600);
INSERT INTO agent_training_consents (id, agent_id, consent_version, source)
  VALUES ('eeeeeeee-0000-0000-0000-000000000009','00000000-0000-0000-0000-0000000000a1','v1','offline');

-- ===== 1. month budget (service_role, as the edge function calls it) =====
SET ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000001', 1, '{}', '{"duration_s":1500}', null, 1.50, 2.00);
  IF NOT (r->>'ok')::boolean OR r->>'idempotency_key' <> 'call:cccccccc-0000-0000-0000-000000000001:v1' THEN RAISE EXCEPTION 'FAIL first insert %', r; END IF;
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000002', 1, '{}', '{}', null, 1.00, 2.00);
  IF r->>'reason' <> 'cost_cap' THEN RAISE EXCEPTION 'FAIL reservations not counted %', r; END IF;
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000001', 1, '{}', '{}', null, 0.10, 100);
  IF r->>'reason' <> 'duplicate' THEN RAISE EXCEPTION 'FAIL duplicate %', r; END IF;
  UPDATE sample_redaction_jobs SET cost_usd = 1.80 WHERE version = 1 AND call_id = 'cccccccc-0000-0000-0000-000000000001';
  IF public.sample_month_committed_usd() <> 1.80 THEN RAISE EXCEPTION 'FAIL running = max(cost, reserved)'; END IF;
  UPDATE sample_redaction_jobs SET status = 'done', cost_usd = 0.40 WHERE call_id = 'cccccccc-0000-0000-0000-000000000001';
  IF public.sample_month_committed_usd() <> 0.40 THEN RAISE EXCEPTION 'FAIL done = actual cost'; END IF;
  UPDATE sample_redaction_jobs SET status = 'deleted' WHERE call_id = 'cccccccc-0000-0000-0000-000000000001';
  IF public.sample_month_committed_usd() <> 0.40 THEN RAISE EXCEPTION 'FAIL deleted = actual cost'; END IF;
  UPDATE sample_redaction_jobs SET created_at = now() - interval '40 days' WHERE call_id = 'cccccccc-0000-0000-0000-000000000001';
  IF public.sample_month_committed_usd() <> 0 THEN RAISE EXCEPTION 'FAIL last month leaked'; END IF;
  RAISE NOTICE 'ok: reservations count, cap refuses, duplicate key caught, done/deleted count actual cost, UTC month window';
END $$;
SELECT pg_temp.expect_fail($q$INSERT INTO sample_redaction_jobs (call_id, version, idempotency_key) VALUES ('cccccccc-0000-0000-0000-000000000003', 2, 'call:cccccccc-0000-0000-0000-000000000003:v1')$q$, 'idempotency_key not matching version');
SELECT pg_temp.expect_fail($q$UPDATE sample_redaction_jobs SET error_code = 'whatever' WHERE call_id = 'cccccccc-0000-0000-0000-000000000001'$q$, 'error_code outside the spec list');

-- ===== 2. retry =====
DO $$
DECLARE r jsonb; v uuid;
BEGIN
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000002', 1, '{}', '{}', null, 0.50, 100);
  v := (r->>'job_id')::uuid;
  r := public.sample_job_retry(v, 0.50, 100);
  IF r->>'reason' <> 'not_failed' THEN RAISE EXCEPTION 'FAIL retried a queued job %', r; END IF;
  UPDATE sample_redaction_jobs SET status = 'failed', cost_usd = 0.30, workflow_run_id = 'wrun_x', error_code = 'timeout' WHERE id = v;
  r := public.sample_job_retry(v, 0.50, 100);
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL retry %', r; END IF;
  IF NOT (SELECT status = 'queued' AND reserved_usd = 0.80 AND workflow_run_id IS NULL AND error_code IS NULL FROM sample_redaction_jobs WHERE id = v) THEN
    RAISE EXCEPTION 'FAIL retry did not reset'; END IF;
  r := public.sample_job_retry(v, 200, 100);
  IF r->>'reason' <> 'not_failed' THEN RAISE EXCEPTION 'FAIL %', r; END IF;
  RAISE NOTICE 'ok: retry only from failed; reserves cost + estimate; clears run and error';
END $$;
RESET ROLE;

-- ===== 3. browser staff (RL-1 lets AMs write jobs) cannot touch worker columns =====
SET ROLE authenticated; SELECT pg_temp.as_user('22222222-0000-0000-0000-0000000000a3');
SELECT pg_temp.expect_fail($q$INSERT INTO sample_redaction_jobs (call_id, version, idempotency_key, reserved_usd) VALUES ('cccccccc-0000-0000-0000-000000000003', 1, 'call:cccccccc-0000-0000-0000-000000000003:v1', 5)$q$, 'AM inserting a job with a reservation');
SELECT pg_temp.expect_fail($q$UPDATE sample_redaction_jobs SET cost_usd = 0 WHERE call_id = 'cccccccc-0000-0000-0000-000000000002'$q$, 'AM resetting spend');
SELECT pg_temp.expect_fail($q$UPDATE sample_redaction_jobs SET reserved_usd = 0 WHERE call_id = 'cccccccc-0000-0000-0000-000000000002'$q$, 'AM resetting the reservation');
SELECT pg_temp.expect_fail($q$UPDATE sample_redaction_jobs SET workflow_run_id = 'wrun_evil' WHERE call_id = 'cccccccc-0000-0000-0000-000000000002'$q$, 'AM hijacking the run');
SELECT pg_temp.expect_fail($q$UPDATE sample_redaction_jobs SET delete_requested_at = now() WHERE call_id = 'cccccccc-0000-0000-0000-000000000002'$q$, 'AM setting the tombstone');
SELECT pg_temp.expect_fail($q$UPDATE sample_redaction_jobs SET created_at = now() - interval '40 days' WHERE call_id = 'cccccccc-0000-0000-0000-000000000002'$q$, 'AM moving a job out of the month');
UPDATE sample_redaction_jobs SET qa_reasons = '["note"]' WHERE call_id = 'cccccccc-0000-0000-0000-000000000002';
DO $$ BEGIN IF (SELECT qa_reasons FROM sample_redaction_jobs WHERE call_id = 'cccccccc-0000-0000-0000-000000000002') <> '["note"]' THEN RAISE EXCEPTION 'FAIL RL-1 staff write'; END IF;
  RAISE NOTICE 'ok: AM still writes RL-1 columns'; END $$;
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.expect_fail($q$SELECT public.sample_job_insert('cccccccc-0000-0000-0000-000000000003', 1, '{}', '{}', null, 0, 100)$q$, 'anon calling sample_job_insert');
RESET ROLE;
SET ROLE authenticated; SELECT pg_temp.as_user('22222222-0000-0000-0000-0000000000ad');
SELECT pg_temp.expect_fail($q$SELECT public.sample_library_ingest(gen_random_uuid(), 'x', '{}')$q$, 'admin browser calling sample_library_ingest');
SELECT pg_temp.expect_fail($q$SELECT public.sample_month_committed_usd()$q$, 'admin browser reading the budget function');
RESET ROLE;

-- ===== 4. ingest =====
SET ROLE service_role;
DO $$
DECLARE r jsonb; v uuid; lib uuid; p jsonb;
BEGIN
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000004', 1, '{}', '{"duration_s":600}', null, 0.30, 100);
  v := (r->>'job_id')::uuid;
  UPDATE sample_redaction_jobs SET status = 'verifying', workflow_run_id = 'wrun_1' WHERE id = v;
  p := jsonb_build_object(
    'qa_flag', true, 'qa_reasons', '["channel_map_unverified"]'::jsonb, 'metrics', '{"clips":2}'::jsonb, 'engine', '{"asr":"assemblyai"}'::jsonb,
    'pipeline_version', 'sr-2.0.0', 'schema_version', '1.0',
    'audio', jsonb_build_object('path', v::text || '/redacted.mp3', 'sha256', repeat('a', 64)),
    'coaching', '{"summary":"s","rubric":"fe_v1"}'::jsonb,
    'clips', jsonb_build_array(
      jsonb_build_object('clip_key','c1','label','opener','start_ms',1000,'end_ms',40000,'audio_exported',true,
                         'audio_path', v::text || '/clips/c1.mp3','audio_sha256',repeat('b',64),'title','Opener','coaching','{"did":"x"}'::jsonb,'sort_order',0),
      jsonb_build_object('clip_key','c2','label','application','start_ms',50000,'end_ms',200000,'audio_exported',false,
                         'audio_path', v::text || '/clips/c2.mp3','coaching','{"did":"y"}'::jsonb,'sort_order',1)));
  r := public.sample_library_ingest(v, 'wrun_other', p);
  IF r->>'reason' <> 'not_owner' THEN RAISE EXCEPTION 'FAIL non-owner ingest %', r; END IF;
  PERFORM pg_temp.expect_fail(format('SELECT public.sample_library_ingest(%L, %L, %L)', v, 'wrun_1',
    jsonb_set(p, '{audio,path}', '"cccccccc-0000-0000-0000-000000000004/v1/redacted.mp3"')), 'audio path outside the job prefix');
  PERFORM pg_temp.expect_fail(format('SELECT public.sample_library_ingest(%L, %L, %L)', v, 'wrun_1',
    jsonb_set(p, '{clips}', (SELECT jsonb_agg(p->'clips'->0) FROM generate_series(1,7)))), 'more than 6 clips');
  r := public.sample_library_ingest(v, 'wrun_1', p);
  IF NOT (r->>'ok')::boolean OR NOT (r->>'consent')::boolean THEN RAISE EXCEPTION 'FAIL ingest %', r; END IF;
  lib := (r->>'library_call_id')::uuid;
  IF NOT (SELECT status = 'done' AND schema_version = '1.0' AND pipeline_version = 'sr-2.0.0' AND completed_at IS NOT NULL FROM sample_redaction_jobs WHERE id = v) THEN
    RAISE EXCEPTION 'FAIL job not done'; END IF;
  IF NOT (SELECT status = 'pending_qa' AND agent_ref ~ '^agent_[0-9a-f]{8}$' AND duration_s = 600 AND audio_path NOT LIKE '%cccccccc%'
            FROM training_library_calls WHERE id = lib) THEN RAISE EXCEPTION 'FAIL library row'; END IF;
  IF NOT (SELECT call_id = 'cccccccc-0000-0000-0000-000000000004' AND source_agent_id = '00000000-0000-0000-0000-0000000000a1'
                 AND consent_id = 'eeeeeeee-0000-0000-0000-000000000009' FROM training_library_call_sources WHERE library_call_id = lib) THEN
    RAISE EXCEPTION 'FAIL source row'; END IF;
  IF (SELECT count(*) FROM training_library_clips WHERE library_call_id = lib) <> 2
     OR (SELECT audio_path FROM training_library_clips WHERE library_call_id = lib AND clip_key = 'c2') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL clips (application clip must keep no audio path)'; END IF;
  r := public.sample_library_ingest(v, 'wrun_1', p);
  IF NOT (r->>'replay')::boolean OR (r->>'library_call_id')::uuid <> lib THEN RAISE EXCEPTION 'FAIL replay %', r; END IF;
  IF (SELECT count(*) FROM training_library_calls WHERE job_id = v) <> 1 THEN RAISE EXCEPTION 'FAIL replay duplicated rows'; END IF;
  RAISE NOTICE 'ok: ingest owner-only, path- and count-checked, writes job+call+source+clips once, replay returns the same row';
END $$;
RESET ROLE;

-- ===== 5. takedown: tombstoned job blocks ingest and republish =====
SET ROLE service_role;
DO $$
DECLARE r jsonb; v uuid; lib uuid;
BEGIN
  SELECT id INTO v FROM sample_redaction_jobs WHERE call_id = 'cccccccc-0000-0000-0000-000000000004';
  SELECT id INTO lib FROM training_library_calls WHERE job_id = v;
  INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES (lib, '22222222-0000-0000-0000-0000000000ad', 'approve', true);
  UPDATE training_library_calls SET status = 'published' WHERE id = lib;
  UPDATE sample_redaction_jobs SET delete_requested_at = now() WHERE call_id = 'cccccccc-0000-0000-0000-000000000004';
  UPDATE training_library_calls SET status = 'withdrawn' WHERE id = lib;
  INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES (lib, '22222222-0000-0000-0000-0000000000ad', 'approve', true);
  PERFORM pg_temp.expect_fail(format('UPDATE training_library_calls SET status = %L WHERE id = %L', 'published', lib), 'republishing a taken-down sample');
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000004', 2, '{}', '{}', null, 0.10, 100);
  IF r->>'reason' <> 'deleted' THEN RAISE EXCEPTION 'FAIL resubmit after takedown %', r; END IF;
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000005', 1, '{}', '{}', null, 0.10, 100);
  UPDATE sample_redaction_jobs SET status = 'verifying', workflow_run_id = 'wrun_5', delete_requested_at = now() WHERE id = (r->>'job_id')::uuid;
  r := public.sample_library_ingest((r->>'job_id')::uuid, 'wrun_5', '{}');
  IF r->>'reason' <> 'deleted' THEN RAISE EXCEPTION 'FAIL ingest after tombstone %', r; END IF;
  RAISE NOTICE 'ok: tombstone blocks resubmit, ingest and republish';
END $$;
RESET ROLE;

-- ===== 6. agents never see job ids' call ids: the published row's paths carry the job id only =====
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM training_library_calls c JOIN training_library_call_sources s ON s.library_call_id = c.id
              WHERE c.audio_path LIKE '%' || s.call_id::text || '%') THEN RAISE EXCEPTION 'FAIL call id in an agent-readable path'; END IF;
  RAISE NOTICE 'ok: no calls.id in agent-readable paths';
END $$;
SELECT 'PASS' AS cases;
