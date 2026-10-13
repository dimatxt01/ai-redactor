-- 20261013090000_sample_redaction_worker cases, on top of RL-1 (run.sh applies the RL-1 fixture + RL-1 migration first).
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
  ('cccccccc-0000-0000-0000-000000000005','00000000-0000-0000-0000-0000000000a1',600),
  ('cccccccc-0000-0000-0000-000000000006','00000000-0000-0000-0000-0000000000a1',600);
INSERT INTO agent_training_consents (id, agent_id, consent_version, source)
  VALUES ('eeeeeeee-0000-0000-0000-000000000009','00000000-0000-0000-0000-0000000000a1','v1','offline');

-- ===== 1. month budget (service_role, as the edge function calls it) =====
SET ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000001', 1, 'final_expense', '{}', '{"duration_s":1500}', null, 1.50, 2.00);
  IF NOT (r->>'ok')::boolean OR r->>'idempotency_key' <> 'call:cccccccc-0000-0000-0000-000000000001:v1' THEN RAISE EXCEPTION 'FAIL first insert %', r; END IF;
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000002', 1, 'final_expense', '{}', '{}', null, 1.00, 2.00);
  IF r->>'reason' <> 'cost_cap' THEN RAISE EXCEPTION 'FAIL reservations not counted %', r; END IF;
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000001', 1, 'final_expense', '{}', '{}', null, 0.10, 100);
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
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000002', 1, 'final_expense', '{}', '{}', null, 0.50, 100);
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
SELECT pg_temp.expect_fail($q$UPDATE sample_redaction_jobs SET heartbeat_at = now() WHERE call_id = 'cccccccc-0000-0000-0000-000000000002'$q$, 'AM faking a worker heartbeat');
SELECT pg_temp.expect_fail($q$UPDATE sample_redaction_jobs SET created_at = now() - interval '40 days' WHERE call_id = 'cccccccc-0000-0000-0000-000000000002'$q$, 'AM moving a job out of the month');
UPDATE sample_redaction_jobs SET qa_reasons = '["note"]' WHERE call_id = 'cccccccc-0000-0000-0000-000000000002';
DO $$ BEGIN IF (SELECT qa_reasons FROM sample_redaction_jobs WHERE call_id = 'cccccccc-0000-0000-0000-000000000002') <> '["note"]' THEN RAISE EXCEPTION 'FAIL RL-1 staff write'; END IF;
  RAISE NOTICE 'ok: AM still writes RL-1 columns'; END $$;
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.expect_fail($q$SELECT public.sample_job_insert('cccccccc-0000-0000-0000-000000000003', 1, 'final_expense', '{}', '{}', null, 0, 100)$q$, 'anon calling sample_job_insert');
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
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000004', 1, 'final_expense', '{}', '{"duration_s":600}', null, 0.30, 100);
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
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL ingest %', r; END IF;
  lib := (r->>'library_call_id')::uuid;
  IF NOT (SELECT status = 'done' AND schema_version = '1.0' AND pipeline_version = 'sr-2.0.0' AND completed_at IS NOT NULL FROM sample_redaction_jobs WHERE id = v) THEN
    RAISE EXCEPTION 'FAIL job not done'; END IF;
  IF NOT (SELECT status = 'pending_qa' AND vertical = 'final_expense' AND agent_ref ~ '^agent_[0-9a-f]{8}$' AND duration_s = 600 AND audio_path NOT LIKE '%cccccccc%'
            FROM training_library_calls WHERE id = lib) THEN RAISE EXCEPTION 'FAIL library row'; END IF;
  IF NOT (SELECT call_id = 'cccccccc-0000-0000-0000-000000000004' AND source_agent_id = '00000000-0000-0000-0000-0000000000a1'
                 AND consent_id IS NULL FROM training_library_call_sources WHERE library_call_id = lib) THEN
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

-- ===== 5. hard delete keeps the spend; refuses while in flight (critic 5508073831) =====
SET ROLE service_role;
DO $$
DECLARE r jsonb; v uuid; lib uuid; before numeric; after numeric; cap numeric;
BEGIN
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000005', 1, 'final_expense', '{}', '{"duration_s":600}', null, 0.90, 100);
  v := (r->>'job_id')::uuid;
  UPDATE sample_redaction_jobs SET status = 'verifying', workflow_run_id = 'wrun_5', cost_usd = 0.60 WHERE id = v;
  -- (a) in flight: refused, nothing removed, nothing written to the ledger
  r := public.sample_call_hard_delete('cccccccc-0000-0000-0000-000000000005');
  IF r->>'reason' <> 'in_flight' OR (r->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL delete of an in-flight job %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM sample_redaction_jobs WHERE id = v) OR EXISTS (SELECT 1 FROM sample_spend_ledger WHERE job_id = v) THEN
    RAISE EXCEPTION 'FAIL in-flight refusal changed rows'; END IF;
  RAISE NOTICE 'ok: delete refused while a job is in flight (reason in_flight -> edge 409 IN_FLIGHT)';
  UPDATE sample_redaction_jobs SET status = 'queued' WHERE id = v;
  IF public.sample_call_hard_delete('cccccccc-0000-0000-0000-000000000005')->>'reason' <> 'in_flight' THEN RAISE EXCEPTION 'FAIL queued not in flight'; END IF;
  UPDATE sample_redaction_jobs SET status = 'verifying' WHERE id = v;
  -- finish it: library row + clip + review + rating, so the cascade is exercised
  r := public.sample_library_ingest(v, 'wrun_5', jsonb_build_object('audio', jsonb_build_object('path', v::text || '/redacted.mp3', 'sha256', repeat('c', 64)),
         'clips', jsonb_build_array(jsonb_build_object('clip_key','c1','label','opener','start_ms',0,'end_ms',1000,'audio_exported',false))));
  IF NOT (r->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL ingest 05 %', r; END IF;
  lib := (r->>'library_call_id')::uuid;
  UPDATE sample_redaction_jobs SET cost_usd = 0.75 WHERE id = v;
  INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES (lib, '22222222-0000-0000-0000-0000000000ad', 'approve', true);
  INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote) VALUES ('00000000-0000-0000-0000-0000000000a1', 'call', lib, 1);
  INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote)
    SELECT '00000000-0000-0000-0000-0000000000a1', 'clip', id, 1 FROM training_library_clips WHERE library_call_id = lib;
  -- (b) committed is the same before and after the delete
  before := public.sample_month_committed_usd();
  r := public.sample_call_hard_delete('cccccccc-0000-0000-0000-000000000005');
  after := public.sample_month_committed_usd();
  RAISE NOTICE 'ok: committed before delete = %, after delete = %', before, after;
  IF NOT (r->>'ok')::boolean OR before <> after OR before = 0 THEN RAISE EXCEPTION 'FAIL committed changed by delete: % -> % (%)', before, after, r; END IF;
  IF NOT EXISTS (SELECT 1 FROM sample_spend_ledger WHERE job_id = v AND usd = 0.75 AND month = date_trunc('month', now() AT TIME ZONE 'utc')::date) THEN
    RAISE EXCEPTION 'FAIL ledger row'; END IF;
  IF EXISTS (SELECT 1 FROM sample_redaction_jobs WHERE id = v) OR EXISTS (SELECT 1 FROM training_library_calls WHERE id = lib)
     OR EXISTS (SELECT 1 FROM training_library_clips WHERE library_call_id = lib) OR EXISTS (SELECT 1 FROM training_library_reviews WHERE library_call_id = lib)
     OR EXISTS (SELECT 1 FROM training_library_call_sources WHERE library_call_id = lib) THEN
    RAISE EXCEPTION 'FAIL hard delete left rows'; END IF;
  IF EXISTS (SELECT 1 FROM training_library_ratings WHERE item_id = lib) THEN RAISE EXCEPTION 'FAIL call rating left'; END IF;
  IF (SELECT count(*) FROM training_library_ratings) <> 0 THEN RAISE EXCEPTION 'FAIL clip rating left'; END IF;
  RAISE NOTICE 'ok: hard delete removes job, library call, sources, clips, reviews, ratings; committed unchanged (spend in ledger)';
  -- idempotent; the ledger holds no call content
  IF NOT (public.sample_call_hard_delete('cccccccc-0000-0000-0000-000000000005')->>'already')::boolean THEN RAISE EXCEPTION 'FAIL repeat delete'; END IF;
  IF (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'sample_spend_ledger') <> ARRAY['created_at','job_id','month','usd'] THEN
    RAISE EXCEPTION 'FAIL ledger columns'; END IF;
  -- the critic's cycle: a resubmit after the delete still sees the deleted job's spend against the cap
  cap := after + 0.50;
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000005', 2, 'final_expense', '{}', '{}', null, 0.60, cap);
  IF r->>'reason' <> 'cost_cap' THEN RAISE EXCEPTION 'FAIL submit/delete cycle bypassed the cap %', r; END IF;
  RAISE NOTICE 'ok: repeat delete idempotent; ledger = job_id, month, usd only; submit after delete still capped';
END $$;
-- cancel then delete (Dmitry 1:41 PM): cancel = the edge `cancel` UPDATE; the worker stops on its next poll
DO $$
DECLARE r jsonb; v uuid; c uuid := 'cccccccc-0000-0000-0000-000000000006'; before numeric;
BEGIN
  r := public.sample_job_insert(c, 1, 'medicare', '{}', '{}', null, 0.50, 100);
  v := (r->>'job_id')::uuid;
  UPDATE sample_redaction_jobs SET status = 'transcribing', workflow_run_id = 'run_6', heartbeat_at = now(), cost_usd = 0.20,
         asr_transcript_ids = '{tr_abc123}' WHERE id = v;
  r := public.sample_call_delete_blockers(c);
  IF NOT (r->>'blocked')::boolean OR (r->>'in_flight')::int <> 1 THEN RAISE EXCEPTION 'FAIL running job not blocking %', r; END IF;
  -- admin cancel (training-library-admin `cancel`)
  UPDATE sample_redaction_jobs SET status = 'failed', error_code = 'cancelled', error_detail = 'cancelled by staff', completed_at = now()
   WHERE call_id = c AND status NOT IN ('done','failed','deleted');
  r := public.sample_call_hard_delete(c);
  IF r->>'reason' <> 'in_flight' OR (r->>'in_flight')::int <> 0 OR (r->>'live_runs')::int <> 1 THEN RAISE EXCEPTION 'FAIL live run after cancel not blocking %', r; END IF;
  -- critic nit 2: a NULL / bad stale window must never turn the live-run block off
  r := public.sample_call_delete_blockers(c, NULL);
  IF NOT (r->>'blocked')::boolean OR (r->>'live_runs')::int <> 1 THEN RAISE EXCEPTION 'FAIL NULL p_stale_s disabled the live-run block %', r; END IF;
  IF NOT (public.sample_call_delete_blockers(c, 0)->>'blocked')::boolean THEN RAISE EXCEPTION 'FAIL p_stale_s 0 disabled the block'; END IF;
  r := public.sample_call_hard_delete(c, NULL);
  IF r->>'reason' <> 'in_flight' OR (r->>'live_runs')::int <> 1 THEN RAISE EXCEPTION 'FAIL hard delete with NULL p_stale_s %', r; END IF;
  RAISE NOTICE 'ok: NULL / 0 p_stale_s still blocks a live run (coalesce 300)';
  -- the run, already stopping, reports a late cost (bridge lets the owning run post `cost` on a failed job)
  UPDATE sample_redaction_jobs SET cost_usd = 0.35 WHERE id = v;
  -- the worker aborted and reported vendor_purged as owner without deleting the transcript (cancel deletes nothing): heartbeat cleared
  UPDATE sample_redaction_jobs SET heartbeat_at = NULL WHERE id = v;
  r := public.sample_call_hard_delete(c);
  IF r->>'reason' <> 'in_flight' OR (r->>'live_runs')::int <> 0 OR (r->>'vendor_pending')::int <> 1 THEN RAISE EXCEPTION 'FAIL vendor copy not blocking %', r; END IF;
  -- the normal cleanup list deletes the AssemblyAI copy on the next poll
  UPDATE sample_redaction_jobs SET asr_transcript_ids = '{}' WHERE id = v;
  before := public.sample_month_committed_usd();
  r := public.sample_call_hard_delete(c);
  IF NOT (r->>'ok')::boolean OR public.sample_month_committed_usd() <> before
     OR NOT EXISTS (SELECT 1 FROM sample_spend_ledger WHERE job_id = v AND usd = 0.35) THEN RAISE EXCEPTION 'FAIL delete after cancel %', r; END IF;
  RAISE NOTICE 'ok: cancel -> 409 while the run is live (live_runs) and while vendor copies wait (vendor_pending) -> delete; late cost kept in ledger';
  -- a dead worker: a stale heartbeat (> p_stale_s) does not block
  r := public.sample_job_insert(c, 2, 'medicare', '{}', '{}', null, 0.10, 100);
  UPDATE sample_redaction_jobs SET status = 'failed', workflow_run_id = 'run_6b', heartbeat_at = now() - interval '10 minutes' WHERE id = (r->>'job_id')::uuid;
  IF (public.sample_call_delete_blockers(c, 300)->>'blocked')::boolean THEN RAISE EXCEPTION 'FAIL stale heartbeat blocks'; END IF;
  IF NOT (public.sample_call_delete_blockers(c, 3600)->>'blocked')::boolean THEN RAISE EXCEPTION 'FAIL p_stale_s ignored'; END IF;
  IF NOT (public.sample_call_hard_delete(c, 300)->>'ok')::boolean THEN RAISE EXCEPTION 'FAIL delete with stale heartbeat'; END IF;
  IF EXISTS (SELECT 1 FROM sample_redaction_jobs WHERE call_id = c) THEN RAISE EXCEPTION 'FAIL rows left after delete'; END IF;
  RAISE NOTICE 'ok: stale heartbeat (dead worker) does not block; delete leaves no job row (status deleted is never written)';
END $$;
RESET ROLE;
SET ROLE authenticated; SELECT pg_temp.as_user('22222222-0000-0000-0000-0000000000ad');
SELECT pg_temp.expect_fail($q$SELECT * FROM public.sample_spend_ledger$q$, 'admin browser reading sample_spend_ledger');
SELECT pg_temp.expect_fail($q$INSERT INTO public.sample_spend_ledger (job_id, month, usd) VALUES (gen_random_uuid(), '2026-10-01', 0)$q$, 'admin browser writing sample_spend_ledger');
SELECT pg_temp.expect_fail($q$SELECT public.sample_call_hard_delete('cccccccc-0000-0000-0000-000000000004')$q$, 'admin browser calling sample_call_hard_delete');
SELECT pg_temp.expect_fail($q$SELECT public.sample_call_delete_blockers('cccccccc-0000-0000-0000-000000000004')$q$, 'admin browser calling sample_call_delete_blockers');
RESET ROLE;
SET ROLE anon;
SELECT pg_temp.expect_fail($q$SELECT * FROM public.sample_spend_ledger$q$, 'anon reading sample_spend_ledger');
RESET ROLE;
DO $$ BEGIN
  IF has_table_privilege('authenticated', 'public.sample_spend_ledger', 'SELECT') OR has_table_privilege('anon', 'public.sample_spend_ledger', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL ledger grant to a browser role'; END IF;
  RAISE NOTICE 'ok: sample_spend_ledger not readable by authenticated or anon';
END $$;

-- ===== 6. agents never see job ids' call ids: the published row's paths carry the job id only =====
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM training_library_calls c JOIN training_library_call_sources s ON s.library_call_id = c.id
              WHERE c.audio_path LIKE '%' || s.call_id::text || '%') THEN RAISE EXCEPTION 'FAIL call id in an agent-readable path'; END IF;
  RAISE NOTICE 'ok: no calls.id in agent-readable paths';
END $$;
SELECT 'PASS' AS cases;

-- ===== 12:44 PM rulings: vertical required, hard delete cascades for service_role only =====
SET ROLE service_role;
DO $$
DECLARE r jsonb;
BEGIN
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000003', 7, NULL, '{}', '{}', null, 0.10, 1000);
  IF r->>'reason' <> 'vertical' THEN RAISE EXCEPTION 'FAIL job without vertical %', r; END IF;
  r := public.sample_job_insert('cccccccc-0000-0000-0000-000000000003', 7, 'medicare', '{}', '{}', null, 0.10, 1000);
  IF NOT (r->>'ok')::boolean OR (SELECT vertical FROM sample_redaction_jobs WHERE id = (r->>'job_id')::uuid) <> 'medicare' THEN
    RAISE EXCEPTION 'FAIL medicare job %', r; END IF;
  RAISE NOTICE 'ok: jobs need a vertical; medicare accepted';
END $$;
RESET ROLE;
DO $$
DECLARE lib uuid;
BEGIN
  SELECT id INTO lib FROM training_library_calls WHERE job_id IS NOT NULL LIMIT 1;
  INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES (lib, '22222222-0000-0000-0000-0000000000ad', 'reject', false);
  PERFORM pg_temp.expect_fail(format('DELETE FROM training_library_reviews WHERE library_call_id = %L', lib), 'direct review delete (parent still there)');
END $$;
SET ROLE service_role;
DO $$
DECLARE lib uuid; j uuid;
BEGIN
  SELECT id, job_id INTO lib, j FROM training_library_calls WHERE job_id IS NOT NULL LIMIT 1;
  DELETE FROM training_library_calls WHERE id = lib;
  DELETE FROM sample_redaction_jobs WHERE id = j;
  IF EXISTS (SELECT 1 FROM training_library_reviews WHERE library_call_id = lib) OR EXISTS (SELECT 1 FROM training_library_clips WHERE library_call_id = lib)
     OR EXISTS (SELECT 1 FROM training_library_call_sources WHERE library_call_id = lib) THEN RAISE EXCEPTION 'FAIL cascade'; END IF;
  IF (public.sample_library_ingest(j, 'wrun_1', '{}'::jsonb))->>'reason' <> 'not_found' THEN RAISE EXCEPTION 'FAIL ingest after hard delete'; END IF;
  RAISE NOTICE 'ok: service_role hard delete cascades (sources, clips, reviews); ingest of a deleted job id returns not_found';
END $$;
RESET ROLE;
