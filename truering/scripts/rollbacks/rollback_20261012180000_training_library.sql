-- Rollback for 20261012180000_training_library (RL-1, TRU-248). NOT RUN unless explicitly told (Dmitry's go + critic check).
-- Fast path, no SQL: the flag recording_library is OFF already; nothing reads these tables until RL-2+ ship.
-- This drops every object the migration created. Data in these tables is lost (by design: it is derived from calls).
-- Buckets are deleted only when they hold no objects; otherwise the rollback aborts (empty them via the Storage API first).
-- Idempotent: re-running after a successful rollback is a no-op.
begin;
SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';
DO $rb$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id IN ('sample-src','training-library')) THEN
    RAISE EXCEPTION 'ROLLBACK ABORT: sample-src / training-library still contain objects; empty them first';
  END IF;
END $rb$;
DROP VIEW  IF EXISTS public.training_library_manifest;
DROP TABLE IF EXISTS public.training_library_ratings;
DROP TABLE IF EXISTS public.training_library_reviews;
DROP TABLE IF EXISTS public.training_library_clips;
DROP TABLE IF EXISTS public.training_library_call_sources;
DROP TABLE IF EXISTS public.training_library_calls;
DROP TABLE IF EXISTS public.agent_training_consents;
DROP TABLE IF EXISTS public.sample_redaction_jobs;
DROP FUNCTION IF EXISTS public.training_library_consent_revoked();
DROP FUNCTION IF EXISTS public.training_library_publish_gate();
DROP FUNCTION IF EXISTS public.training_library_reviews_append_only();
DROP FUNCTION IF EXISTS public.training_library_touch();
-- protect_delete BYPASS (explicit): live storage has trigger `protect_buckets_delete` on storage.buckets (function
-- storage.protect_delete()) that refuses direct SQL deletes unless GUC `storage.allow_delete_query` = 'true'. This rollback sets that
-- GUC with set_config(..., true) = TRANSACTION-LOCAL, only for the single DELETE of the two named buckets below, only after the guard
-- above proved both hold no objects, and sets it back to 'false' right after. storage.objects is never deleted from.
-- If the delete still fails, the (empty, private) buckets are left and must be removed via the Storage API; the rest rolls back.
DO $rbb$
BEGIN
  PERFORM set_config('storage.allow_delete_query', 'true', true);
  DELETE FROM storage.buckets WHERE id IN ('sample-src','training-library');
  PERFORM set_config('storage.allow_delete_query', 'false', true);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'buckets not deleted by SQL (%): remove sample-src / training-library via the Storage API', SQLERRM;
END $rbb$;
DELETE FROM public.feature_flags WHERE key = 'recording_library';
commit;
