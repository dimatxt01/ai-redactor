-- ═══════════════════════════════════════════════════════════════════════════
-- Sample library — PII-redacted sales-call samples (spec v0.1, 2026-10-12)
--
-- Status: STAGED, NOT APPLIED. Needs its own explicit go; apply via the
-- `apply-migration` skill, then rename this file to the applied version.
--
-- What it adds (all NEW objects; nothing existing is altered):
--   • public.sample_redaction_jobs     one row per redaction run (call_id + version)
--   • public.sample_library            one row per finished run awaiting / past human QA
--   • public.sample_library_approvals  append-only QA + legal sign-offs
--   • public.sample_library_manifest   audit / take-down view (security_invoker)
--   • storage buckets sample-work (worker scratch) and sample-library (artifacts), both private
--   • triggers: approvals append-only; publish gate (qa + legal, both listened_full, consent_ref)
--   • functions (service_role only): sample_month_committed_usd, sample_job_insert, sample_job_retry
--     — the month cap's check + insert under one advisory lock
--
-- Writers: ONLY the edge functions sample-library-admin and sample-redaction-bridge
-- (service role). The browser reads the three tables + view as admin/superadmin and
-- never writes them: no INSERT/UPDATE/DELETE policy exists, and the grants are revoked.
-- Storage: no storage.objects policies at all, so only the service role can read or
-- write either bucket; the admin UI plays files through short-lived signed URLs that
-- sample-library-admin issues after its own admin check.
--
-- Touches calls/agents: NO writes. call_id is a plain FK (ON DELETE RESTRICT).
--
-- ROLLBACK: scripts/rollbacks/rollback_20261012230000_sample_library.sql
-- ═══════════════════════════════════════════════════════════════════════════

set local lock_timeout = '5s';
set local statement_timeout = '30s';

-- ── jobs ────────────────────────────────────────────────────────────────────
create table if not exists public.sample_redaction_jobs (
  id               uuid primary key default gen_random_uuid(),
  call_id          uuid not null references public.calls(id) on delete restrict,
  version          int  not null check (version >= 1),
  idempotency_key  text not null unique,             -- 'call:<call_id>:v<version>'
  status           text not null default 'queued'
                   check (status in ('queued','fetching','transcribing','redacting','verifying','done','failed')),
  error_code       text check (error_code in ('fetch_expired','bad_audio','asr_failed','timeout','unsupported_source','cost_cap','internal')),
  error_detail     text,                              -- human text; never transcript content
  qa_flag          boolean,
  qa_reasons       jsonb not null default '[]'::jsonb,
  metrics          jsonb not null default '{}'::jsonb,
  engine           jsonb not null default '{}'::jsonb,
  options          jsonb not null default '{}'::jsonb, -- bleep_pad_ms, pitch_shift_customer, highlight, extra_terms (admin-typed only)
  call_meta        jsonb not null default '{}'::jsonb, -- duration_s, disposition, agent_ref, vertical, caller_state; no names
  cost_usd         numeric(10,4) not null default 0,   -- actual spend (ASR at the configured rate + OpenRouter usage.cost)
  reserved_usd     numeric(10,4) not null default 0,   -- estimate held against the month cap while the job runs
  pipeline_version text,                               -- worker's PIPELINE_VERSION, stamped on every artifact too
  asr_transcript_ids text[] not null default '{}'::text[], -- AssemblyAI ids, so the delete action can purge the vendor copy
  workflow_run_id  text,
  submitted_by     uuid references auth.users(id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  started_at       timestamptz,
  completed_at     timestamptz,
  delete_requested_at timestamptz,                     -- tombstone: set FIRST by delete; submit/retry refuse the call after it
  deleted_at       timestamptz,                        -- every stored copy purged by sample-library-admin delete
  unique (call_id, version)
);
create index if not exists sample_redaction_jobs_created_idx on public.sample_redaction_jobs (created_at desc);
create index if not exists sample_redaction_jobs_active_idx on public.sample_redaction_jobs (status)
  where status not in ('done','failed');

-- ── month budget (atomic) ───────────────────────────────────────────────────
-- Committed spend this UTC month: actual cost for finished jobs, the larger of
-- actual and reserved for running ones. Check + insert/reset happen under one
-- advisory lock, so concurrent submits cannot each pass the cap.
create or replace function public.sample_month_committed_usd()
returns numeric language sql stable set search_path = public as $$
  select coalesce(sum(case when status in ('done','failed') then cost_usd else greatest(cost_usd, reserved_usd) end), 0)
    from public.sample_redaction_jobs
   where created_at >= (date_trunc('month', now() at time zone 'utc') at time zone 'utc');
$$;

create or replace function public.sample_job_insert(
  p_call_id uuid, p_version int, p_key text, p_options jsonb, p_call_meta jsonb, p_submitted_by uuid,
  p_reserved numeric, p_month_cap numeric
) returns jsonb language plpgsql set search_path = public as $$
declare
  v_spent numeric;
  v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('sample_redaction_month_budget'));
  if exists (select 1 from public.sample_redaction_jobs where call_id = p_call_id and delete_requested_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'deleted');
  end if;
  v_spent := public.sample_month_committed_usd();
  if v_spent + p_reserved > p_month_cap then
    return jsonb_build_object('ok', false, 'reason', 'cost_cap', 'spent_usd', v_spent);
  end if;
  insert into public.sample_redaction_jobs (call_id, version, idempotency_key, options, call_meta, submitted_by, reserved_usd)
  values (p_call_id, p_version, p_key, p_options, p_call_meta, p_submitted_by, p_reserved)
  returning id into v_id;
  return jsonb_build_object('ok', true, 'job_id', v_id, 'spent_usd', v_spent);
exception when unique_violation then
  return jsonb_build_object('ok', false, 'reason', 'duplicate');
end $$;

-- Retry: same key, fresh 2h window; spend so far stays, the new estimate is reserved on top.
create or replace function public.sample_job_retry(p_job_id uuid, p_reserved numeric, p_month_cap numeric)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_job public.sample_redaction_jobs;
  v_spent numeric;
begin
  perform pg_advisory_xact_lock(hashtext('sample_redaction_month_budget'));
  select * into v_job from public.sample_redaction_jobs where id = p_job_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'not_found'); end if;
  if v_job.status <> 'failed' then return jsonb_build_object('ok', false, 'reason', 'not_failed'); end if;
  if exists (select 1 from public.sample_redaction_jobs where call_id = v_job.call_id and delete_requested_at is not null) then
    return jsonb_build_object('ok', false, 'reason', 'deleted');
  end if;
  v_spent := public.sample_month_committed_usd();
  if v_spent + p_reserved > p_month_cap then
    return jsonb_build_object('ok', false, 'reason', 'cost_cap', 'spent_usd', v_spent);
  end if;
  update public.sample_redaction_jobs set
    status = 'queued', error_code = null, error_detail = null, qa_flag = null, qa_reasons = '[]'::jsonb,
    metrics = jsonb_build_object('cost_items', coalesce(metrics->'cost_items', '{}'::jsonb)),
    reserved_usd = cost_usd + p_reserved, started_at = null, completed_at = null, workflow_run_id = null,
    created_at = now(), updated_at = now()
  where id = p_job_id;
  return jsonb_build_object('ok', true, 'job_id', v_job.id, 'idempotency_key', v_job.idempotency_key);
end $$;

revoke all on function public.sample_month_committed_usd() from public, anon, authenticated;
revoke all on function public.sample_job_insert(uuid, int, text, jsonb, jsonb, uuid, numeric, numeric) from public, anon, authenticated;
revoke all on function public.sample_job_retry(uuid, numeric, numeric) from public, anon, authenticated;
grant execute on function public.sample_month_committed_usd() to service_role;
grant execute on function public.sample_job_insert(uuid, int, text, jsonb, jsonb, uuid, numeric, numeric) to service_role;
grant execute on function public.sample_job_retry(uuid, numeric, numeric) to service_role;

-- ── library ─────────────────────────────────────────────────────────────────
create table if not exists public.sample_library (
  id                     uuid primary key default gen_random_uuid(),
  call_id                uuid not null references public.calls(id) on delete restrict,
  job_id                 uuid not null unique references public.sample_redaction_jobs(id) on delete restrict,
  version                int  not null,
  agent_ref              text not null,
  vertical               text not null,
  disposition            text,
  duration_s             int,
  redacted_audio_path    text not null,
  redacted_audio_sha256  text not null,
  redacted_audio_bytes   bigint,
  highlight_audio_path   text,
  highlight_audio_sha256 text,
  highlight_start_ms     int,
  highlight_end_ms       int,
  transcript_json_path   text not null,
  transcript_json_sha256 text not null,
  transcript_txt_path    text,
  pii_spans_json_path    text not null,
  pii_spans_json_sha256  text not null,
  labels_json_path       text,                        -- fixed-label segments (opener … wrap_up)
  labels_json_sha256     text,
  coaching_json_path     text,
  coaching_json_sha256   text,
  pipeline_version       text not null,
  qa_flag                boolean not null default true,
  qa_reasons             jsonb not null default '[]'::jsonb,
  title                  text,
  tags                   text[] not null default '{}'::text[],
  consent_ref            text,                       -- the featured agent's signed release
  status                 text not null default 'pending_qa'
                         check (status in ('pending_qa','qa_passed','legal_approved','published','rejected','withdrawn')),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  published_at           timestamptz,
  withdrawn_at           timestamptz,
  deleted_at             timestamptz,                 -- artifacts purged; the row stays as the take-down record
  review_due_at          timestamptz not null default (now() + interval '12 months'),
  unique (call_id, version)
);
create index if not exists sample_redaction_jobs_month_cost_idx on public.sample_redaction_jobs (created_at) include (cost_usd);
create index if not exists sample_library_status_idx on public.sample_library (status, created_at desc);

-- ── approvals (append-only) ─────────────────────────────────────────────────
create table if not exists public.sample_library_approvals (
  id             bigint generated always as identity primary key,
  library_id     uuid not null references public.sample_library(id) on delete restrict,
  step           text not null check (step in ('qa','legal')),
  actor          uuid not null references auth.users(id) on delete restrict,
  decision       text not null check (decision in ('approve','reject')),
  notes          text,
  listened_full  boolean not null,
  at             timestamptz not null default now()
);
create index if not exists sample_library_approvals_lib_idx on public.sample_library_approvals (library_id, step, at desc);

create or replace function public.sample_library_approvals_append_only()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'sample_library_approvals is append-only (% refused)', tg_op;
end $$;

drop trigger if exists sample_library_approvals_append_only on public.sample_library_approvals;
create trigger sample_library_approvals_append_only
  before update or delete on public.sample_library_approvals
  for each row execute function public.sample_library_approvals_append_only();

-- ── publish gate ────────────────────────────────────────────────────────────
-- The LATEST decision per step decides. legal_approved needs qa; published needs
-- qa + legal, both with listened_full, by TWO DIFFERENT people, plus a consent_ref
-- and the v1 vertical. Checked on EVERY insert and update of a gated row (blanking
-- consent_ref on a published row is refused; a row can't be inserted already
-- published), and a deleted sample can never leave withdrawn.
create or replace function public.sample_library_status_gate()
returns trigger language plpgsql set search_path = public as $$
declare
  v_qa    record;
  v_legal record;
begin
  if tg_op = 'UPDATE' and old.deleted_at is not null and (new.deleted_at is null or new.status <> 'withdrawn') then
    raise exception 'sample_library %: deleted samples stay withdrawn', new.id;
  end if;

  if new.status in ('qa_passed','legal_approved','published') then
    select decision, listened_full, actor into v_qa
      from public.sample_library_approvals
     where library_id = new.id and step = 'qa' order by at desc, id desc limit 1;
    if not (coalesce(v_qa.decision,'') = 'approve' and coalesce(v_qa.listened_full,false)) then
      raise exception 'sample_library %: % needs a qa approval with listened_full', new.id, new.status;
    end if;
  end if;
  if new.status in ('legal_approved','published') then
    select decision, listened_full, actor into v_legal
      from public.sample_library_approvals
     where library_id = new.id and step = 'legal' order by at desc, id desc limit 1;
    if not (coalesce(v_legal.decision,'') = 'approve' and coalesce(v_legal.listened_full,false)) then
      raise exception 'sample_library %: % needs a legal approval with listened_full', new.id, new.status;
    end if;
    if v_legal.actor = v_qa.actor then
      raise exception 'sample_library %: qa and legal must be signed by different people', new.id;
    end if;
  end if;
  if new.status = 'published' then
    if nullif(btrim(coalesce(new.consent_ref,'')),'') is null then
      raise exception 'sample_library %: published needs consent_ref', new.id;
    end if;
    if new.vertical <> 'final_expense' then
      raise exception 'sample_library %: v1 publishes final_expense only', new.id;
    end if;
    new.published_at := coalesce(new.published_at, now());
  end if;
  if new.status = 'withdrawn' and (tg_op = 'INSERT' or old.status is distinct from 'withdrawn') then
    new.withdrawn_at := now();
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists sample_library_status_gate on public.sample_library;
create trigger sample_library_status_gate
  before insert or update on public.sample_library
  for each row execute function public.sample_library_status_gate();

revoke all on function public.sample_library_approvals_append_only() from public, anon, authenticated;
revoke all on function public.sample_library_status_gate() from public, anon, authenticated;

-- ── manifest view (audits / take-downs) ─────────────────────────────────────
create or replace view public.sample_library_manifest
with (security_invoker = true) as
select
  l.id as library_id, l.call_id, l.version, l.job_id, l.agent_ref, l.vertical, l.status,
  l.consent_ref, l.published_at, l.withdrawn_at, l.deleted_at, l.review_due_at, l.pipeline_version,
  l.redacted_audio_path, l.redacted_audio_sha256,
  l.highlight_audio_path, l.highlight_audio_sha256,
  l.transcript_json_sha256, l.pii_spans_json_sha256,
  j.engine, j.qa_flag, j.qa_reasons, j.cost_usd, j.completed_at as redacted_at,
  coalesce((
    select jsonb_agg(jsonb_build_object('step', a.step, 'decision', a.decision, 'actor', a.actor,
                                        'listened_full', a.listened_full, 'at', a.at) order by a.at)
      from public.sample_library_approvals a where a.library_id = l.id
  ), '[]'::jsonb) as approvals
from public.sample_library l
join public.sample_redaction_jobs j on j.id = l.job_id;

-- ── RLS + grants: admin/superadmin READ only ────────────────────────────────
alter table public.sample_redaction_jobs    enable row level security;
alter table public.sample_library           enable row level security;
alter table public.sample_library_approvals enable row level security;

revoke all on public.sample_redaction_jobs, public.sample_library, public.sample_library_approvals,
              public.sample_library_manifest from anon, authenticated;
grant select on public.sample_redaction_jobs, public.sample_library, public.sample_library_approvals,
                public.sample_library_manifest to authenticated;

drop policy if exists "Admins read sample redaction jobs" on public.sample_redaction_jobs;
create policy "Admins read sample redaction jobs" on public.sample_redaction_jobs
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role) or public.has_role(auth.uid(), 'superadmin'::public.app_role));

drop policy if exists "Admins read sample library" on public.sample_library;
create policy "Admins read sample library" on public.sample_library
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role) or public.has_role(auth.uid(), 'superadmin'::public.app_role));

drop policy if exists "Admins read sample library approvals" on public.sample_library_approvals;
create policy "Admins read sample library approvals" on public.sample_library_approvals
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'::public.app_role) or public.has_role(auth.uid(), 'superadmin'::public.app_role));

-- ── storage buckets (private; no storage.objects policies on purpose) ───────
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('sample-work',    'sample-work',    false, 209715200, array['audio/mpeg','audio/wav','application/json']),
  ('sample-library', 'sample-library', false, 209715200, array['audio/mpeg','audio/wav','application/json','text/plain'])
on conflict (id) do nothing;

-- ── self-verification (CLAUDE.md: a policy change proves its own safety) ────
do $verify$
declare
  v_auth_violations int;
  v_policies int;
begin
  if exists (
    select 1 from pg_class
     where oid in ('public.sample_redaction_jobs'::regclass, 'public.sample_library'::regclass,
                   'public.sample_library_approvals'::regclass)
       and not relrowsecurity
  ) then
    raise exception 'VERIFY FAIL: RLS is off on a sample_* table';
  end if;

  select count(*) into v_policies from pg_policies
   where schemaname = 'public'
     and tablename in ('sample_redaction_jobs','sample_library','sample_library_approvals');
  if v_policies <> 3 then
    raise exception 'VERIFY FAIL: expected exactly 3 sample_* policies (SELECT only), found %', v_policies;
  end if;
  if exists (select 1 from pg_policies where schemaname = 'public'
              and tablename in ('sample_redaction_jobs','sample_library','sample_library_approvals')
              and cmd <> 'SELECT') then
    raise exception 'VERIFY FAIL: a sample_* policy is not SELECT-only';
  end if;

  -- integrity-audit's own predicate, scoped to these policies.
  select count(*) into v_auth_violations
  from pg_policy pol
  join pg_class rel on rel.oid = pol.polrelid
  join pg_depend dep on dep.objid = pol.oid
    and dep.classid = 'pg_policy'::regclass and dep.refclassid = 'pg_proc'::regclass
  join pg_proc p on p.oid = dep.refobjid
  where rel.relnamespace = 'public'::regnamespace
    and rel.relname in ('sample_redaction_jobs','sample_library','sample_library_approvals')
    and (pol.polroles = '{0}'::oid[] or 'authenticated'::regrole::oid = any(pol.polroles))
    and not has_function_privilege('authenticated', p.oid, 'execute');
  if v_auth_violations <> 0 then
    raise exception 'VERIFY FAIL: sample_* policies depend on % function(s) authenticated cannot execute', v_auth_violations;
  end if;

  if has_table_privilege('authenticated', 'public.sample_library', 'insert')
     or has_table_privilege('authenticated', 'public.sample_library_approvals', 'insert')
     or has_table_privilege('anon', 'public.sample_library', 'select') then
    raise exception 'VERIFY FAIL: browser roles can write sample_* or anon can read';
  end if;

  if has_function_privilege('authenticated', 'public.sample_job_insert(uuid, int, text, jsonb, jsonb, uuid, numeric, numeric)', 'execute')
     or has_function_privilege('anon', 'public.sample_job_retry(uuid, numeric, numeric)', 'execute')
     or has_function_privilege('authenticated', 'public.sample_month_committed_usd()', 'execute') then
    raise exception 'VERIFY FAIL: a sample budget function is executable by a browser role';
  end if;

  if (select count(*) from storage.buckets where id in ('sample-work','sample-library') and not public) <> 2 then
    raise exception 'VERIFY FAIL: sample buckets missing or public';
  end if;
end;
$verify$;

comment on table public.sample_redaction_jobs is
  'One PII-redaction run of a recorded call (sample library spec v0.1). Written only by sample-library-admin / sample-redaction-bridge.';
comment on table public.sample_library is
  'Redacted call samples. Publishing needs qa + legal approvals with listened_full and a consent_ref (trigger sample_library_status_gate).';
comment on table public.sample_library_approvals is
  'Append-only QA / legal decisions on sample_library rows (trigger sample_library_approvals_append_only).';
