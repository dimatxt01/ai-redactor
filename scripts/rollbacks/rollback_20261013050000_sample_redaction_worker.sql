-- Rollback for 20261013050000_sample_redaction_worker.sql. Leaves RL-1 (20261012180000) exactly as RL-1 made it.
-- Drops the worker columns, so job spend/run/takedown history is lost: run it only before the pilot, or after
-- exporting sample_redaction_jobs. Library rows already ingested stay (they are RL-1 rows).
-- Idempotent: safe to run twice.

SET LOCAL lock_timeout = '2s';

DROP TRIGGER IF EXISTS sample_redaction_takedown_guard ON public.training_library_calls;
DROP TRIGGER IF EXISTS sample_redaction_jobs_service_columns ON public.sample_redaction_jobs;
DROP FUNCTION IF EXISTS public.sample_redaction_takedown_guard();
DROP FUNCTION IF EXISTS public.sample_redaction_jobs_service_columns();
DROP FUNCTION IF EXISTS public.sample_library_ingest(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.sample_job_retry(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS public.sample_job_insert(uuid, integer, jsonb, jsonb, uuid, numeric, numeric);
DROP FUNCTION IF EXISTS public.sample_month_committed_usd();
DROP INDEX IF EXISTS public.sample_redaction_jobs_active_idx;
DROP INDEX IF EXISTS public.sample_redaction_jobs_month_idx;
ALTER TABLE public.sample_redaction_jobs
  DROP CONSTRAINT IF EXISTS sample_redaction_jobs_error_code_check,
  DROP CONSTRAINT IF EXISTS sample_redaction_jobs_key_matches,
  DROP CONSTRAINT IF EXISTS sample_redaction_jobs_call_version_key,
  DROP COLUMN IF EXISTS deleted_at,
  DROP COLUMN IF EXISTS delete_requested_at,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS workflow_run_id,
  DROP COLUMN IF EXISTS asr_transcript_ids,
  DROP COLUMN IF EXISTS pipeline_version,
  DROP COLUMN IF EXISTS reserved_usd,
  DROP COLUMN IF EXISTS cost_usd,
  DROP COLUMN IF EXISTS error_detail,
  DROP COLUMN IF EXISTS call_meta,
  DROP COLUMN IF EXISTS options,
  DROP COLUMN IF EXISTS version;
