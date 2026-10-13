-- Sample redaction worker on top of RL-1 (20261012180000_training_library.sql, applied 2026-10-13 01:21Z).
-- Status: STAGED, NOT APPLIED. Needs its own migration go; apply by the apply-migration skill, one file, after RL-1.
-- Contract: docs/recording-library/SPEC.md v0.2 + TR_PLAN.md (RL-3 = the sample-redaction-bridge, Dmitry 2026-10-13).
--
-- What it adds (RL-1 objects are extended, never re-created or dropped)
--   sample_redaction_jobs     + columns the worker and the caps need: version, options, call_meta, error_detail, cost_usd,
--                               reserved_usd, pipeline_version, asr_transcript_ids, workflow_run_id, started/completed_at,
--                               delete_requested_at (tombstone), deleted_at; unique (call_id, version); key = call:<id>:v<version>;
--                               error_code limited to the spec's codes.
--   trigger sample_redaction_jobs_service_columns  browser roles (RL-1 lets staff write jobs) cannot set or change the
--                               budget, run-ownership, vendor-id or takedown columns; only service_role (edge functions) can.
--   trigger sample_redaction_takedown_guard  a library call whose job was taken down can never be published again.
--   functions (service_role only, EXECUTE revoked from PUBLIC/anon/authenticated => integrity-audit function_acl sets unchanged)
--     sample_month_committed_usd()   committed spend this UTC month (running jobs count max(cost, reserved))
--     sample_job_insert(...)         month-cap check + insert under one advisory lock
--     sample_job_retry(...)          month-cap check + reset of a failed job under the same lock
--     sample_library_ingest(...)     the bridge's `complete`: job -> done and the RL-1 rows (training_library_calls,
--                                    _call_sources, _clips) in ONE transaction, idempotent per job
-- Buckets: RL-1's sample-src (scratch, <job_id>/...) and training-library (artifacts, <job_id>/...). No new buckets.
-- Paths never contain calls.id: agents can read published training_library_calls rows (RL-1), so audio paths use the job id.
-- Effect on existing data: none. Precondition: sample_redaction_jobs is empty (nothing writes it before this lands).
-- Manifest: 2026-10-12.3 adds both triggers to triggers_enabled. ORDER: apply BEFORE redeploying integrity-audit.
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
              AND column_name IN ('version','options','call_meta','cost_usd','reserved_usd','workflow_run_id','delete_requested_at')) THEN
    RAISE EXCEPTION 'PRECONDITION: sample_redaction_jobs already has worker columns';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sample_redaction_jobs) THEN
    RAISE EXCEPTION 'PRECONDITION: sample_redaction_jobs has rows; this migration assumes nothing has submitted yet';
  END IF;
  IF to_regprocedure('public.sample_library_ingest(uuid,text,jsonb)') IS NOT NULL
     OR to_regprocedure('public.sample_month_committed_usd()') IS NOT NULL THEN
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
  ADD COLUMN options             jsonb NOT NULL DEFAULT '{}'::jsonb,   -- bleep_pad_ms, pitch, clips, coaching, extra_terms (staff-typed only)
  ADD COLUMN call_meta           jsonb NOT NULL DEFAULT '{}'::jsonb,   -- duration_s, disposition, vertical, caller_state, channel_map; no names
  ADD COLUMN error_detail        text CHECK (error_detail IS NULL OR length(error_detail) <= 500),  -- never transcript content
  ADD COLUMN cost_usd            numeric(10,4) NOT NULL DEFAULT 0 CHECK (cost_usd >= 0),
  ADD COLUMN reserved_usd        numeric(10,4) NOT NULL DEFAULT 0 CHECK (reserved_usd >= 0),
  ADD COLUMN pipeline_version    text,
  ADD COLUMN asr_transcript_ids  text[] NOT NULL DEFAULT '{}'::text[],  -- AssemblyAI ids, so delete can purge the vendor copy
  ADD COLUMN workflow_run_id     text,
  ADD COLUMN started_at          timestamptz,
  ADD COLUMN completed_at        timestamptz,
  ADD COLUMN delete_requested_at timestamptz,   -- tombstone, set FIRST by delete; submit/retry/bridge refuse the call after it
  ADD COLUMN deleted_at          timestamptz,   -- every copy purged (TR + vendor); status becomes 'deleted' with it
  ADD CONSTRAINT sample_redaction_jobs_call_version_key UNIQUE (call_id, version),
  ADD CONSTRAINT sample_redaction_jobs_key_matches CHECK (idempotency_key = 'call:' || call_id::text || ':v' || version::text),
  ADD CONSTRAINT sample_redaction_jobs_error_code_check CHECK (error_code IS NULL OR error_code IN
    ('fetch_expired','bad_audio','asr_failed','timeout','unsupported_source','cost_cap','internal'));
CREATE INDEX sample_redaction_jobs_active_idx ON public.sample_redaction_jobs (status) WHERE status NOT IN ('done','failed','deleted');
CREATE INDEX sample_redaction_jobs_month_idx ON public.sample_redaction_jobs (created_at) INCLUDE (cost_usd, reserved_usd, status);

-- ── 2. browser roles cannot touch the worker's columns ─────────────────────
-- RL-1 lets staff INSERT/UPDATE jobs through RLS. The caps, run ownership, vendor ids and the takedown tombstone must
-- only move through the edge functions (service_role), or a browser write could reset the month budget, hijack a
-- run or un-delete a call.
CREATE FUNCTION public.sample_redaction_jobs_service_columns() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF current_user NOT IN ('anon', 'authenticated') THEN RETURN NEW; END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.cost_usd <> 0 OR NEW.reserved_usd <> 0 OR NEW.workflow_run_id IS NOT NULL OR NEW.asr_transcript_ids <> '{}'
       OR NEW.delete_requested_at IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.started_at IS NOT NULL
       OR NEW.completed_at IS NOT NULL OR NEW.pipeline_version IS NOT NULL THEN
      RAISE EXCEPTION 'sample_redaction_jobs worker columns are set by the edge functions only' USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW.cost_usd IS DISTINCT FROM OLD.cost_usd OR NEW.reserved_usd IS DISTINCT FROM OLD.reserved_usd
     OR NEW.workflow_run_id IS DISTINCT FROM OLD.workflow_run_id OR NEW.asr_transcript_ids IS DISTINCT FROM OLD.asr_transcript_ids
     OR NEW.delete_requested_at IS DISTINCT FROM OLD.delete_requested_at OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
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

-- ── 3. a taken-down call stays withdrawn ───────────────────────────────────
CREATE FUNCTION public.sample_redaction_takedown_guard() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.status = 'published' AND EXISTS (SELECT 1 FROM public.sample_redaction_jobs j
                                           WHERE j.id = NEW.job_id AND j.delete_requested_at IS NOT NULL) THEN
    RAISE EXCEPTION 'this sample was taken down; it cannot be published again' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER sample_redaction_takedown_guard BEFORE INSERT OR UPDATE OF status ON public.training_library_calls
  FOR EACH ROW EXECUTE FUNCTION public.sample_redaction_takedown_guard();

-- ── 4. month budget (atomic) ───────────────────────────────────────────────
CREATE FUNCTION public.sample_month_committed_usd() RETURNS numeric
LANGUAGE sql STABLE SET search_path = public, pg_temp AS $fn$
  SELECT coalesce(sum(CASE WHEN status IN ('done','failed','deleted') THEN cost_usd ELSE greatest(cost_usd, reserved_usd) END), 0)
    FROM public.sample_redaction_jobs
   WHERE created_at >= (date_trunc('month', now() AT TIME ZONE 'utc') AT TIME ZONE 'utc');
$fn$;

CREATE FUNCTION public.sample_job_insert(
  p_call_id uuid, p_version integer, p_options jsonb, p_call_meta jsonb, p_submitted_by uuid, p_reserved numeric, p_month_cap numeric
) RETURNS jsonb
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
DECLARE v_spent numeric; v_id uuid; v_key text := 'call:' || p_call_id::text || ':v' || p_version::text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('sample_redaction_month_budget'));
  IF EXISTS (SELECT 1 FROM public.sample_redaction_jobs WHERE call_id = p_call_id AND delete_requested_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deleted');
  END IF;
  v_spent := public.sample_month_committed_usd();
  IF v_spent + p_reserved > p_month_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cost_cap', 'spent_usd', v_spent);
  END IF;
  INSERT INTO public.sample_redaction_jobs (call_id, version, idempotency_key, options, call_meta, submitted_by, reserved_usd, schema_version)
  VALUES (p_call_id, p_version, v_key, p_options, p_call_meta, p_submitted_by, p_reserved, '1.0')
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
  IF EXISTS (SELECT 1 FROM public.sample_redaction_jobs WHERE call_id = v_job.call_id AND delete_requested_at IS NOT NULL) THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'deleted');
  END IF;
  v_spent := public.sample_month_committed_usd();
  IF v_spent + p_reserved > p_month_cap THEN
    RETURN jsonb_build_object('ok', false, 'reason', 'cost_cap', 'spent_usd', v_spent);
  END IF;
  UPDATE public.sample_redaction_jobs SET
    status = 'queued', error_code = NULL, error_detail = NULL, qa_flag = false, qa_reasons = '[]'::jsonb,
    metrics = jsonb_build_object('cost_items', coalesce(metrics -> 'cost_items', '{}'::jsonb)),
    reserved_usd = cost_usd + p_reserved, started_at = NULL, completed_at = NULL, workflow_run_id = NULL, created_at = now()
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
  v_consent uuid;
  v_clip jsonb;
BEGIN
  SELECT * INTO v_job FROM public.sample_redaction_jobs WHERE id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_found'); END IF;
  IF v_job.workflow_run_id IS DISTINCT FROM p_run_id THEN RETURN jsonb_build_object('ok', false, 'reason', 'not_owner'); END IF;
  IF v_job.delete_requested_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'reason', 'deleted'); END IF;

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
  IF jsonb_array_length(coalesce(p_payload -> 'clips', '[]'::jsonb)) > 6 THEN
    RAISE EXCEPTION 'ingest: at most 6 clips per call' USING ERRCODE = 'check_violation';
  END IF;

  SELECT agent_id INTO v_agent FROM public.calls WHERE id = v_job.call_id;
  IF v_agent IS NULL THEN RAISE EXCEPTION 'ingest: call % has no agent', v_job.call_id USING ERRCODE = 'check_violation'; END IF;
  SELECT id INTO v_consent FROM public.agent_training_consents WHERE agent_id = v_agent AND revoked_at IS NULL;

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
    INSERT INTO public.training_library_calls (job_id, version, agent_ref, duration_s, audio_path, audio_sha256, coaching, title)
    VALUES (p_job_id, v_job.version,
            'agent_' || left(encode(sha256(convert_to('sample-agent-ref:' || v_agent::text, 'UTF8')), 'hex'), 8),
            nullif(v_job.call_meta ->> 'duration_s', '')::integer,
            p_payload #>> '{audio,path}', p_payload #>> '{audio,sha256}',
            coalesce(p_payload -> 'coaching', '{}'::jsonb), left(p_payload ->> 'title', 200))
    RETURNING id INTO v_lib;
    INSERT INTO public.training_library_call_sources (library_call_id, call_id, call_version, source_agent_id, consent_id)
    VALUES (v_lib, v_job.call_id, v_job.version, v_agent, v_consent);
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
  RETURN jsonb_build_object('ok', true, 'library_call_id', v_lib, 'consent', v_consent IS NOT NULL);
END
$fn$;

REVOKE ALL ON FUNCTION public.sample_redaction_jobs_service_columns() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_redaction_takedown_guard() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_month_committed_usd() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_job_insert(uuid, integer, jsonb, jsonb, uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_job_retry(uuid, numeric, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.sample_library_ingest(uuid, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sample_month_committed_usd() TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_job_insert(uuid, integer, jsonb, jsonb, uuid, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_job_retry(uuid, numeric, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.sample_library_ingest(uuid, text, jsonb) TO service_role;

-- ── 6. self-check ──────────────────────────────────────────────────────────
DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
              AND p.proname IN ('sample_redaction_jobs_service_columns','sample_redaction_takedown_guard',
                                'sample_month_committed_usd','sample_job_insert','sample_job_retry','sample_library_ingest')
              AND (has_function_privilege('anon', p.oid, 'execute') OR has_function_privilege('authenticated', p.oid, 'execute'))) THEN
    RAISE EXCEPTION 'VERIFY FAIL: a sample redaction function is executable by a browser role';
  END IF;
  IF (SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgenabled = 'O'
       AND tgname IN ('sample_redaction_jobs_service_columns','sample_redaction_takedown_guard')) <> 2 THEN
    RAISE EXCEPTION 'VERIFY FAIL: triggers missing or disabled';
  END IF;
END
$verify$;

COMMENT ON COLUMN public.sample_redaction_jobs.delete_requested_at IS
  'Takedown tombstone (training-library-admin delete). From here submit, retry and every bridge action except purge refuse the call.';
