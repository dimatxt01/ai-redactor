-- Rollback for 20261013090000_sample_redaction_worker.sql. Leaves RL-1 (20261012180000) exactly as RL-1 made it.
-- Drops the worker columns, and drops sample_spend_ledger, so job spend/run history is lost: run it only before the pilot, or after
-- exporting sample_redaction_jobs. Library rows already ingested stay (they are RL-1 rows).
-- Idempotent: safe to run twice. Run it in one transaction: psql -1 -f <this file>.

SET LOCAL lock_timeout = '2s';

-- 12:44 PM rulings: restore RL-1's final_expense-only vertical, consent publish gate and strict append-only reviews.
DO $pre$ BEGIN
  IF EXISTS (SELECT 1 FROM public.training_library_calls WHERE vertical <> 'final_expense') THEN
    RAISE EXCEPTION 'ROLLBACK STOP: non-final_expense library rows exist; delete or export them first';
  END IF;
END $pre$;
ALTER TABLE public.training_library_calls DROP CONSTRAINT IF EXISTS training_library_calls_vertical_check;
ALTER TABLE public.training_library_calls ADD CONSTRAINT training_library_calls_vertical_check CHECK (vertical = 'final_expense');
CREATE OR REPLACE FUNCTION public.training_library_reviews_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'training_library_reviews is append-only' USING ERRCODE = 'insufficient_privilege'; END
$fn$;
CREATE OR REPLACE FUNCTION public.training_library_publish_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN
    IF NOT COALESCE((SELECT r.decision = 'approve' AND r.listened_full FROM public.training_library_reviews r
                      WHERE r.library_call_id = NEW.id ORDER BY r.seq DESC LIMIT 1), false) THEN
      RAISE EXCEPTION 'publish requires the latest review to be approve with listened_full = true' USING ERRCODE = 'check_violation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.training_library_call_sources s
                     JOIN public.agent_training_consents k ON k.agent_id = s.source_agent_id AND k.revoked_at IS NULL
                    WHERE s.library_call_id = NEW.id) THEN
      RAISE EXCEPTION 'publish requires an active training consent for the source agent' USING ERRCODE = 'check_violation';
    END IF;
    NEW.published_at := now();
  END IF;
  RETURN NEW;
END
$fn$;

DROP TRIGGER IF EXISTS sample_redaction_jobs_service_columns ON public.sample_redaction_jobs;
DROP FUNCTION IF EXISTS public.sample_call_hard_delete(uuid, integer);
DROP FUNCTION IF EXISTS public.sample_call_delete_blockers(uuid, integer);
-- restore RL-1's browser write path on library rows (20261012180000 definitions verbatim)
GRANT INSERT, UPDATE ON public.training_library_calls, public.training_library_call_sources, public.training_library_clips TO authenticated;
GRANT INSERT ON public.training_library_reviews TO authenticated;
DROP POLICY IF EXISTS tl_calls_staff_insert ON public.training_library_calls;
DROP POLICY IF EXISTS tl_calls_staff_update ON public.training_library_calls;
CREATE POLICY tl_calls_staff_insert ON public.training_library_calls FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_calls_staff_update ON public.training_library_calls FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
DROP POLICY IF EXISTS tl_sources_staff_insert ON public.training_library_call_sources;
DROP POLICY IF EXISTS tl_sources_staff_update ON public.training_library_call_sources;
CREATE POLICY tl_sources_staff_insert ON public.training_library_call_sources FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_sources_staff_update ON public.training_library_call_sources FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
DROP POLICY IF EXISTS tl_clips_staff_insert ON public.training_library_clips;
DROP POLICY IF EXISTS tl_clips_staff_update ON public.training_library_clips;
CREATE POLICY tl_clips_staff_insert ON public.training_library_clips FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_clips_staff_update ON public.training_library_clips FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
DROP POLICY IF EXISTS tl_reviews_staff_insert ON public.training_library_reviews;
CREATE POLICY tl_reviews_staff_insert ON public.training_library_reviews FOR INSERT TO authenticated
  WITH CHECK (reviewer = auth.uid()
              AND (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role)));
-- restore RL-1's browser write path on jobs (critic C1 fix undone; RL-1 20261012180000 definitions verbatim)
GRANT INSERT, UPDATE ON public.sample_redaction_jobs TO authenticated;
DROP POLICY IF EXISTS tl_jobs_staff_insert ON public.sample_redaction_jobs;
DROP POLICY IF EXISTS tl_jobs_staff_update ON public.sample_redaction_jobs;
CREATE POLICY tl_jobs_staff_insert ON public.sample_redaction_jobs FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_jobs_staff_update ON public.sample_redaction_jobs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
DROP FUNCTION IF EXISTS public.sample_redaction_jobs_service_columns();
DROP FUNCTION IF EXISTS public.sample_library_ingest(uuid, text, jsonb);
DROP FUNCTION IF EXISTS public.sample_job_retry(uuid, numeric, numeric);
DROP FUNCTION IF EXISTS public.sample_job_insert(uuid, integer, text, jsonb, jsonb, uuid, numeric, numeric);
DROP FUNCTION IF EXISTS public.sample_month_committed_usd();
DROP TABLE IF EXISTS public.sample_spend_ledger;
DROP INDEX IF EXISTS public.sample_redaction_jobs_active_idx;
DROP INDEX IF EXISTS public.sample_redaction_jobs_month_idx;
ALTER TABLE public.sample_redaction_jobs
  DROP CONSTRAINT IF EXISTS sample_redaction_jobs_error_code_check,
  DROP CONSTRAINT IF EXISTS sample_redaction_jobs_key_matches,
  DROP CONSTRAINT IF EXISTS sample_redaction_jobs_call_version_key,
  DROP COLUMN IF EXISTS completed_at,
  DROP COLUMN IF EXISTS started_at,
  DROP COLUMN IF EXISTS heartbeat_at,
  DROP COLUMN IF EXISTS workflow_run_id,
  DROP COLUMN IF EXISTS asr_transcript_ids,
  DROP COLUMN IF EXISTS pipeline_version,
  DROP COLUMN IF EXISTS reserved_usd,
  DROP COLUMN IF EXISTS cost_usd,
  DROP COLUMN IF EXISTS error_detail,
  DROP COLUMN IF EXISTS call_meta,
  DROP COLUMN IF EXISTS options,
  DROP COLUMN IF EXISTS vertical,
  DROP COLUMN IF EXISTS version;
