-- Sample redaction worker on top of RL-1 (20261012180000_training_library.sql, applied 2026-10-13 01:21Z).
-- Status: STAGED, NOT APPLIED. Needs its own migration go; apply by the apply-migration skill, one file, after RL-1.
-- Contract: docs/recording-library/SPEC.md v0.2 + TR_PLAN.md (RL-3 = the sample-redaction-bridge, Dmitry 2026-10-13).
--
-- What it adds (RL-1 objects are extended, never re-created or dropped)
--   sample_redaction_jobs     + columns the worker and the caps need: version, options, call_meta, error_detail, cost_usd,
--                               reserved_usd, pipeline_version, asr_transcript_ids, workflow_run_id (the worker run that owns
--                               the job), heartbeat_at (that run is alive), started/completed_at;
--                               unique (call_id, version); key = call:<id>:v<version>;
--                               error_code limited to the spec's codes.
--   trigger sample_redaction_jobs_service_columns  browser roles (RL-1 lets staff write jobs) cannot set or change the
--                               budget, run-ownership or vendor-id columns; only service_role (edge functions) can.
--   table sample_spend_ledger  spend of hard-deleted jobs (job_id, month, usd only; no call content), service_role only,
--                               so submit/delete cycles cannot reset the month cap (critic, review 5508073831).
--   functions (service_role only, EXECUTE revoked from PUBLIC/anon/authenticated => integrity-audit function_acl sets unchanged)
--     sample_month_committed_usd()   committed spend this UTC month (running jobs count max(cost, reserved))
--     sample_job_insert(...)         month-cap check + insert under one advisory lock
--     sample_job_retry(...)          month-cap check + reset of a failed job under the same lock
--     sample_library_ingest(...)     the bridge's `complete`: job -> done and the RL-1 rows (training_library_calls,
--                                    _call_sources, _clips) in ONE transaction, idempotent per job
--     sample_call_delete_blockers()  what still blocks a delete (queued/running job, live worker run, vendor copies pending)
--     sample_call_hard_delete(...)   training-library-admin's delete: refuses while anything blocks it, writes each job's
--                                    spend to the ledger, then deletes ratings, library calls (cascade) and jobs, one transaction
-- Buckets: RL-1's sample-src (scratch, <job_id>/...) and training-library (artifacts, <job_id>/...). No new buckets.
-- Paths never contain calls.id: agents can read published training_library_calls rows (RL-1), so audio paths use the job id.
-- Effect on existing data: none. Precondition: sample_redaction_jobs is empty (nothing writes it before this lands).
-- Manifest: 2026-10-12.3 adds the service-columns trigger to triggers_enabled. ORDER: apply BEFORE redeploying integrity-audit.
-- Dmitry 2026-10-13 12:44 PM CT rulings (this port, prb/rl-worker):
--   * every vertical: sample_redaction_jobs.vertical (new) and training_library_calls.vertical take
--     final_expense | medicare | aca (RL-1's final_expense-only CHECK is replaced); the job's vertical is copied on ingest.
--   * no consent requirement: ingest no longer reads agent_training_consents (call_sources.consent_id stays NULL),
--     and RL-1's publish gate no longer requires an active consent (only the approve + listened_full review).
--   * hard delete: training_library_reviews stays append-only for browser roles, but service_role (the
--     training-library-admin delete) may DELETE, so the cascade from training_library_calls goes through.
-- Rollback: scripts/rollbacks/rollback_20261013090000_sample_redaction_worker.sql (RL-1 objects stay as RL-1 made them).

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ── 0. preconditions ───────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.sample_redaction_jobs') IS NULL OR to_regclass('public.training_library_calls') IS NULL
     OR to_regclass('public.training_library_call_sources') IS NULL OR to_regclass('public.training_library_clips') IS NULL
     OR to_regclass('public.agent_training_consents') IS NULL OR to_regclass('public.training_library_reviews') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION: RL-1 (20261012180000_training_library) is not applied';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'sample_redaction_jobs'
              AND column_name IN ('version','options','call_meta','cost_usd','reserved_usd','workflow_run_id')) THEN
    RAISE EXCEPTION 'PRECONDITION: sample_redaction_jobs already has worker columns';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sample_redaction_jobs) THEN
    RAISE EXCEPTION 'PRECONDITION: sample_redaction_jobs has rows; this migration assumes nothing has submitted yet';
  END IF;
  IF to_regprocedure('public.sample_library_ingest(uuid,text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.sample_month_committed_usd()') IS NOT NULL
     OR to_regclass('public.sample_spend_ledger') IS NOT NULL THEN
    RAISE EXCEPTION 'PRECONDITION: sample redaction functions already exist';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'sample-src' AND NOT public)
     OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'training-library' AND NOT public) THEN
    RAISE EXCEPTION 'PRECONDITION: RL-1 private buckets sample-src / training-library missing';
  END IF;
END $pre$;

-- ── 1. job columns ─────────────────────────────────────────────────────────
ALTER TABLE public.sample_redaction_jobs
  ADD COLUMN version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  ADD COLUMN vertical            text CHECK (vertical IN ('final_expense','medicare','aca')),   -- from the call (Dmitry 12:44 PM); required by sample_job_insert + ingest
  ADD COLUMN options             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- bleep_pad_ms, pitch, clips, coaching, extra_terms (staff-typed only)
  ADD COLUMN call_meta           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- duration_s, disposition, vertical, caller_state, channel_map; no names
  ADD COLUMN error_detail        text CHECK (error_detail IS NULL OR length(error_detail) <= 500),  -- never transcript content
  ADD COLUMN cost_usd            numeric(10,4) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  ADD COLUMN reserved_usd        numeric(10,4) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  ADD COLUMN pipeline_version    text,
  ADD COLUMN asr_transcript_ids  text[] NOT NULL DEFAULT '{}'::text[],  -- AssemblyAI ids, so delete can purge the vendor copy
  ADD COLUMN workflow_run_id     text,          -- the worker run that claimed the job (name kept from the Workflow design)
  ADD COLUMN heartbeat_at        timestamptz,   -- the owning run's last bridge poll; stale = the worker died (bridge fails the job)
  ADD COLUMN started_at          timestamptz,
  ADD COLUMN completed_at        timestamptz,
  ADD CONSTRAINT sample_redaction_jobs_call_version_key UNIQUE (call_id, version),
  ADD CONSTRAINT sample_redaction_jobs_key_matches CHECK (idempotency_key = 'call:' || call_id::text || ':v' || version::text),
  ADD CONSTRAINT sample_redaction_jobs_error_code_check CHECK (error_code IS NULL OR error_code IN
    ('fetch_expired','bad_audio','asr_failed','timeout','unsupported_source','cost_cap','internal','cancelled'));
CREATE INDEX sample_redaction_jobs_active_idx ON public.sample_redaction_jobs (status) WHERE status NOT IN ('done','failed','deleted');
CREATE INDEX sample_redaction_jobs_month_idx ON public.sample_redaction_jobs (created_at) INCLUDE (cost_usd, reserved_usd, status);

-- ── 2. browser roles cannot touch the worker's columns ─────────────────────
-- RL-1 lets staff INSERT/UPDATE jobs through RLS. The caps, run ownership and vendor ids must
-- only move through the edge functions (service_role), or a browser write could reset the month budget or hijack a run.
CREATE FUNCTION public.sample_redaction_jobs_service_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.cost_usd <> 0 OR NEW.reserved_usd <> 0 OR NEW.workflow_run_id IS NOT NULL OR NEW.heartbeat_at IS NOT NULL OR NEW.asr_transcript_ids <> '{}'
       OR NEW.started_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL OR NEW.pipeline_version IS NOT NULL THEN
      RAISE EXCEPTION 'sample_redaction_jobs worker columns are set by the edge functions only' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.cost_usd IS DISTINCT FROM OLD.cost_usd OR NEW.reserved_usd IS DISTINCT FROM OLD.reserved_usd
     OR NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id OR NEW.heartbeat_at IS DISTINCT FROM OLD.heartbeat_at
     OR NEW.asr_transcript_ids IS DISTINCT FROM OLD.asr_transcript_ids
     OR NEW.version IS DISTINCT FROM OLD.version OR NEW.call_id IS DISTINCT FROM OLD.call_id
     OR NEW.started_at IS DISTINCT FROM OLD.started_at OR NEW.completed_at IS DISTINCT FROM OLD.completed_at
     OR NEW.pipeline_version IS DISTINCT FROM OLD.pipeline_version OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'sample_redaction_jobs worker columns are set by the edge functions only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sample_redaction_jobs_service_columns BEFORE INSERT OR UPDATE ON public.sample_redaction_jobs
  FOR EACH ROW EXECUTE FUNCTION public.sample_redaction_jobs_service_columns();

-- ── 3. spend ledger: spend survives the hard delete ─────────────────────────
-- One row per hard-deleted job: its id, the UTC month it counted in and its actual spend. No call id, no content.
-- No grants to browser roles and RLS on with no policy: only service_role (and the definer-less functions it calls) reads it.
CREATE TABLE public.sample_spend_ledger (
  job_id     uuid PRIMARY KEY,
  month      date NOT NULL CHECK (month = date_trunc('month', month)::date),
  usd        numeric(10,4) NOT NULL CHECK (usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.sample_spend_ledger ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sample_spend_ledger FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.sample_spend_ledger TO service_role;
COMMENT ON TABLE public.sample_spend_ledger IS
  'Spend of hard-deleted sample_redaction_jobs (job id, UTC month, usd). Summed by sample_month_committed_usd() so delete cannot reset SAMPLE_MONTH_CAP_USD. service_role only.';

-- ── 4. month budget (atomic) ───────────────────────────────────────────────
CREATE FUNCTION public.sample_month_committed_usd() RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT coalesce((SELECT sum(CASE WHEN status IN ('done','failed','deleted') THEN cost_usd ELSE greatest(cost_usd, reserved_usd) END)
                      FROM public.sample_redaction_jobs
                     WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc')), 0)
       + coalesce((SELECT sum(usd) FROM public.sample_spend_ledger
                    WHERE month = date_trunc('month', now() AT TIME ZONE 'utc')::date), 0);
$fn$;

CREATE FUNCTION public.sample_job_insert(
  p_call_id uuid, p_version integer, p_vertical text, p_options jsonb, p_call_meta jsonb, p_submitted_by uuid, p_reserved numeric, p_month_cap numeric
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_spent numeric; v_id uuid; v_key text := 'call:' || p_call_id::text || ':v' || p_version::text;
BEGIN
  IF p_vertical IS NULL OR p_vertical NOT IN ('final_expense','medicare','aca') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'vertical');
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('sample_redaction_month_budget'));
  v_spent := public.sample_month_committed_usd();
  IF v_spent + p_reserved > p_month_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cost_cap', 'spent_usd', v_spent);
  END IF;
  INSERT INTO public.sample_redaction_jobs (call_id, version, vertical, idempotency_key, options, call_meta, submitted_by, reserved_usd, schema_version)
  VALUES (p_call_id, p_version, p_vertical, v_key, p_options, p_call_meta, p_submitted_by, p_reserved, '1.0')
  RETURNING id INTO v_id;
  RETURN jsonb_build_object('ok', true, 'job_id', v_id, 'idempotency_key', v_key, 'spent_usd', v_spent);
EXCEPTION WHEN unique_violation THEN
  RETURN jsonb_build_object('ok', false, 'reason', 'duplicate');
END
$fn$;

-- Retry: same key, fresh 2h window; spend so far stays, the new estimate is reserved on top.
CREATE FUNCTION public.sample_job_retry(p_job_id uuid, p_reserved numeric, p_month_cap numeric) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_job public.sample_redaction_jobs; v_spent numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sample_redaction_month_budget'));
  SELECT * INTO v_job FROM public.sample_redaction_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_job.status <> 'failed' THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_failed'); END IF;
  v_spent := public.sample_month_committed_usd();
  IF v_spent + p_reserved > p_month_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cost_cap', 'spent_usd', v_spent);
  END IF;
  UPDATE public.sample_redaction_jobs SET
    status = 'queued', error_code = NULL, error_detail = NULL, qa_flag = false, qa_reasons = '[]'::jsonb,
    metrics = jsonb_build_object('cost_items', coalesce(metrics -> 'cost_items', '{}'::jsonb)),
    reserved_usd = cost_usd + p_reserved, started_at = NULL, completed_at = NULL, workflow_run_id = NULL, heartbeat_at = NULL, created_at = now()
  WHERE id = p_job_id;
  RETURN jsonb_build_object('ok', true, 'job_id', v_job.id, 'idempotency_key', v_job.idempotency_key);
END
$fn$;

-- ── 5. ingest: job -> done + RL-1 rows, one transaction ────────────────────
-- p_payload: {qa_flag, qa_reasons[], metrics{}, engine{}, pipeline_version, schema_version,
--             audio:{path, sha256}, coaching{}, title?, clips:[{clip_key, label, sub_label, start_ms, end_ms,
--             audio_exported, audio_path, audio_sha256, title, coaching{}, confidence, sort_order}]}
-- The bridge has already checked every artifact is in training-library/<job_id>/.
-- Idempotent: a repeat by the owning run of a done job returns the existing library call.
CREATE FUNCTION public.sample_library_ingest(p_job_id uuid, p_run_id text, p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE
  v_job public.sample_redaction_jobs;
  v_agent uuid;
  v_lib uuid;
  v_clip jsonb;
BEGIN
  SELECT * INTO v_job FROM public.sample_redaction_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_job.workflow_run_id IS DISTINCT FROM p_run_id THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_owner'); END IF;

  SELECT id INTO v_lib FROM public.training_library_calls WHERE job_id = p_job_id;
  IF v_job.status = 'done' THEN
    IF v_lib IS NOT NULL THEN RETURN jsonb_build_object('ok', true, 'library_call_id', v_lib, 'replay', true); END IF;
  ELSIF v_job.status IN ('failed', 'deleted') THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'terminal', 'status', v_job.status);
  END IF;

  IF NOT (p_payload ? 'audio') OR coalesce(p_payload #>> '{audio,path}', '') !~ ('^' || p_job_id::text || '/[a-z0-9_.-]+$')
     OR coalesce(p_payload #>> '{audio,sha256}', '') !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'ingest: audio path/sha256 invalid' USING ERRCODE = 'check_violation';
  END IF;
  IF v_job.vertical IS NULL THEN
    RAISE EXCEPTION 'ingest: job has no vertical' USING ERRCODE = 'check_violation';
  END IF;
  IF jsonb_array_length(coalesce(p_payload -> 'clips', '[]'::jsonb)) > 6 THEN
    RAISE EXCEPTION 'ingest: at most 6 clips per call' USING ERRCODE = 'check_violation';
  END IF;

  SELECT agent_id INTO v_agent FROM public.calls WHERE id = v_job.call_id;
  IF v_agent IS NULL THEN RAISE EXCEPTION 'ingest: call % has no agent', v_job.call_id USING ERRCODE = 'check_violation'; END IF;

  UPDATE public.sample_redaction_jobs SET
    status = 'done',
    qa_flag = coalesce((p_payload ->> 'qa_flag')::boolean, true),
    qa_reasons = coalesce(p_payload -> 'qa_reasons', '[]'::jsonb),
    metrics = coalesce(p_payload -> 'metrics', '{}'::jsonb) || jsonb_build_object('cost_items', coalesce(metrics -> 'cost_items', '{}'::jsonb)),
    engine = coalesce(p_payload -> 'engine', '{}'::jsonb),
    pipeline_version = p_payload ->> 'pipeline_version',
    schema_version = coalesce(p_payload ->> 'schema_version', '1.0'),
    completed_at = now()
  WHERE id = p_job_id;

  IF v_lib IS NULL THEN
    INSERT INTO public.training_library_calls (job_id, version, vertical, agent_ref, duration_s, audio_path, audio_sha256, coaching, title)
    VALUES (p_job_id, v_job.version, v_job.vertical,
            'agent_' || left(encode(sha256(convert_to('sample-agent-ref:' || v_agent::text, 'UTF8')), 'hex'), 8),
            nullif(v_job.call_meta ->> 'duration_s', '')::integer,
            p_payload #>> '{audio,path}', p_payload #>> '{audio,sha256}',
            coalesce(p_payload -> 'coaching', '{}'::jsonb), left(p_payload ->> 'title', 200))
    RETURNING id INTO v_lib;
    INSERT INTO public.training_library_call_sources (library_call_id, call_id, call_version, source_agent_id)
    VALUES (v_lib, v_job.call_id, v_job.version, v_agent);   -- consent_id stays NULL (no consent requirement)
    FOR v_clip IN SELECT * FROM jsonb_array_elements(coalesce(p_payload -> 'clips', '[]'::jsonb)) LOOP
      IF coalesce((v_clip ->> 'audio_exported')::boolean, false)
         AND coalesce(v_clip ->> 'audio_path', '') !~ ('^' || p_job_id::text || '/clips/[a-z0-9_.-]+$') THEN
        RAISE EXCEPTION 'ingest: clip audio path invalid' USING ERRCODE = 'check_violation';
      END IF;
      INSERT INTO public.training_library_clips (library_call_id, clip_key, label, sub_label, start_ms, end_ms, audio_exported,
                                                 audio_path, audio_sha256, title, coaching, confidence, sort_order)
      VALUES (v_lib, v_clip ->> 'clip_key', v_clip ->> 'label', nullif(v_clip ->> 'sub_label', ''),
              (v_clip ->> 'start_ms')::integer, (v_clip ->> 'end_ms')::integer,
              coalesce((v_clip ->> 'audio_exported')::boolean, false),
              CASE WHEN coalesce((v_clip ->> 'audio_exported')::boolean, false) THEN v_clip ->> 'audio_path' END,
              CASE WHEN coalesce((v_clip ->> 'audio_exported')::boolean, false) THEN v_clip ->> 'audio_sha256' END,
              left(v_clip ->> 'title', 200), coalesce(v_clip -> 'coaching', '{}'::jsonb),
              nullif(v_clip ->> 'confidence', '')::numeric, coalesce((v_clip ->> 'sort_order')::integer, 0));
    END LOOP;
  END IF;
  RETURN jsonb_build_object('ok', true, 'library_call_id', v_lib);
END
$fn$;

-- ── 5a. hard delete (Dmitry 12:44 PM), spend kept (critic 5508073831) ──────
-- Refused while anything below blocks it: a running job would keep spending and its later bridge `cost` calls would
-- hit NO_JOB, so that spend would never be counted (Dmitry 1:41 PM: an admin cancels first; the cancel deletes nothing
-- on the worker's side). Otherwise, under the month-budget lock: each job's cost_usd goes to sample_spend_ledger (month
-- of the job's created_at), then ratings, library calls (cascade: sources, clips, reviews) and the job rows are deleted.
-- Storage is purged by the edge function around it. Nothing in this migration writes job status 'deleted' any more
-- (RL-1's status CHECK still allows it; the hard delete removes the row instead).
-- What still blocks a hard delete of a call: a queued/running job (cancel it first), a worker run that still owns a job
-- (heartbeat fresher than p_stale_s; a cancelled run stops on the worker's next poll and clears it), or AssemblyAI
-- copies the worker's cleanup has not deleted yet (the job row is what tells the worker about them).
CREATE FUNCTION public.sample_call_delete_blockers(p_call_id uuid, p_stale_s integer DEFAULT 300) RETURNS jsonb
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT jsonb_build_object(
    'blocked', count(*) FILTER (WHERE b_flight OR b_live OR b_vendor) > 0,
    'in_flight', count(*) FILTER (WHERE b_flight),
    'live_runs', count(*) FILTER (WHERE b_live),
    'vendor_pending', count(*) FILTER (WHERE b_vendor))
  FROM (SELECT status NOT IN ('done','failed') AS b_flight,
               heartbeat_at IS NOT NULL AND heartbeat_at > now() - make_interval(secs => greatest(coalesce(p_stale_s, 300), 1)) AS b_live,   -- NULL/bad never disables the block
               asr_transcript_ids <> '{}' AS b_vendor
          FROM public.sample_redaction_jobs WHERE call_id = p_call_id) j;
$fn$;

CREATE FUNCTION public.sample_call_hard_delete(p_call_id uuid, p_stale_s integer DEFAULT 300) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_jobs uuid[]; v_libs uuid[]; v_blk jsonb; v_usd numeric;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sample_redaction_month_budget'));
  SELECT array_agg(id), coalesce(sum(cost_usd), 0) INTO v_jobs, v_usd
    FROM (SELECT id, cost_usd FROM public.sample_redaction_jobs WHERE call_id = p_call_id FOR UPDATE) j;
  IF v_jobs IS NULL THEN RETURN jsonb_build_object('ok', true, 'already', true, 'jobs', 0, 'library_calls', 0); END IF;
  v_blk := public.sample_call_delete_blockers(p_call_id, p_stale_s);
  IF (v_blk ->> 'blocked')::boolean THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'in_flight') || (v_blk - 'blocked');
  END IF;

  INSERT INTO public.sample_spend_ledger (job_id, month, usd)
  SELECT id, date_trunc('month', created_at AT TIME ZONE 'utc')::date, cost_usd
    FROM public.sample_redaction_jobs WHERE id = ANY (v_jobs)
  ON CONFLICT (job_id) DO NOTHING;

  SELECT array_agg(id) INTO v_libs FROM public.training_library_calls WHERE job_id = ANY (v_jobs);
  IF v_libs IS NOT NULL THEN
    DELETE FROM public.training_library_ratings
     WHERE (item_type = 'call' AND item_id = ANY (v_libs))
        OR (item_type = 'clip' AND item_id IN (SELECT id FROM public.training_library_clips WHERE library_call_id = ANY (v_libs)));
    DELETE FROM public.training_library_calls WHERE id = ANY (v_libs);
  END IF;
  DELETE FROM public.sample_redaction_jobs WHERE id = ANY (v_jobs);
  RETURN jsonb_build_object('ok', true, 'jobs', cardinality(v_jobs), 'library_calls', coalesce(cardinality(v_libs), 0),
                            'ledger_usd', v_usd, 'job_ids', to_jsonb(v_jobs));
END
$fn$;

REVOKE ALL ON FUNCTION public.sample_redaction_jobs_service_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_month_committed_usd() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_job_insert(uuid, integer, text, jsonb, jsonb, uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_job_retry(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_library_ingest(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_call_hard_delete(uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_call_delete_blockers(uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sample_month_committed_usd() TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_job_insert(uuid, integer, text, jsonb, jsonb, uuid, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_job_retry(uuid, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_library_ingest(uuid, text, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_call_hard_delete(uuid, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_call_delete_blockers(uuid, integer) TO service_role;

-- ── 5b. Dmitry 12:44 PM: every vertical, no consent gate, hard delete ──────
ALTER TABLE public.training_library_calls DROP CONSTRAINT training_library_calls_vertical_check;
ALTER TABLE public.training_library_calls ADD CONSTRAINT training_library_calls_vertical_check
  CHECK (vertical IN ('final_expense','medicare','aca'));

CREATE OR REPLACE FUNCTION public.training_library_publish_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN
    -- the LATEST review decides: a later reject / withdraw blocks (re)publishing until a new approve + listened_full
    IF NOT COALESCE((SELECT r.decision = 'approve' AND r.listened_full FROM public.training_library_reviews r
                      WHERE r.library_call_id = NEW.id ORDER BY r.seq DESC LIMIT 1), false) THEN
      RAISE EXCEPTION 'publish requires the latest review to be approve with listened_full = true' USING ERRCODE = 'check_violation';
    END IF;
    -- (consent requirement removed, Dmitry 2026-10-13 12:44 PM)
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END
$fn$;

-- append-only, except rows removed by the cascade from a deleted library call (hard delete)
CREATE OR REPLACE FUNCTION public.training_library_reviews_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  -- only the FK cascade from a deleted training_library_calls row (its parent is already gone); browser roles have no
  -- DELETE grant on training_library_calls, so only service_role (training-library-admin delete) can start that cascade
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.training_library_calls c WHERE c.id = OLD.library_call_id) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'training_library_reviews is append-only' USING ERRCODE = 'insufficient_privilege';
END
$fn$;

-- ── 6. self-check ──────────────────────────────────────────────────────────
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('sample_redaction_jobs_service_columns','sample_call_hard_delete','sample_call_delete_blockers',
                                'sample_month_committed_usd','sample_job_insert','sample_job_retry','sample_library_ingest')
              AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute'))) THEN
    RAISE EXCEPTION 'VERIFY FAIL: a sample redaction function is executable by a browser role';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
       AND tgname = 'sample_redaction_jobs_service_columns') <> 1 THEN
    RAISE EXCEPTION 'VERIFY FAIL: trigger missing or disabled';
  END IF;
  IF has_table_privilege('anon', 'public.sample_spend_ledger', 'select') OR has_table_privilege('authenticated', 'public.sample_spend_ledger', 'select')
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.sample_spend_ledger'::regclass) THEN
    RAISE EXCEPTION 'VERIFY FAIL: sample_spend_ledger readable by a browser role or RLS off';
  END IF;
END
$verify$;

