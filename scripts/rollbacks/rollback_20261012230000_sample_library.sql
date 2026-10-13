-- Rollback for 20261012230000_sample_library.sql
-- Removes every object that migration created. Nothing else references them.
-- Storage: empty both buckets first (storage.objects rows are deleted through the
-- Storage API, not SQL), or the bucket delete below fails.

set local lock_timeout = '5s';

drop view if exists public.sample_library_manifest;
drop trigger if exists sample_library_status_gate on public.sample_library;
drop trigger if exists sample_library_approvals_append_only on public.sample_library_approvals;
drop table if exists public.sample_library_approvals;
drop table if exists public.sample_library;
drop table if exists public.sample_redaction_jobs;
drop function if exists public.sample_library_status_gate();
drop function if exists public.sample_job_retry(uuid, numeric, numeric);
drop function if exists public.sample_job_insert(uuid, int, text, jsonb, jsonb, uuid, numeric, numeric);
drop function if exists public.sample_month_committed_usd();
drop function if exists public.sample_library_approvals_append_only();
delete from storage.buckets where id in ('sample-work', 'sample-library');
