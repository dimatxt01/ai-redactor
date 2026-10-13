-- Read-only verify after 20261012180000_training_library (RL-1, TRU-248). ONE select; every *_ok must be true.
select
  (select count(*) from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity
     and c.relname in ('sample_redaction_jobs','agent_training_consents','training_library_calls','training_library_call_sources',
                       'training_library_clips','training_library_reviews','training_library_ratings')) = 7 as tables_rls_ok,
  not exists (select 1 from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.grantee in ('anon','PUBLIC')
                 and (g.table_name like 'training_library%' or g.table_name in ('sample_redaction_jobs','agent_training_consents'))) as no_anon_grants_ok,
  not exists (select 1 from information_schema.role_table_grants g
               where g.table_schema = 'public' and g.grantee = 'authenticated' and g.privilege_type in ('DELETE','TRUNCATE')
                 and (g.table_name like 'training_library%' or g.table_name in ('sample_redaction_jobs','agent_training_consents'))) as no_client_delete_ok,
  (select count(*) from pg_policies where schemaname = 'public'
     and (tablename like 'training_library%' or tablename in ('sample_redaction_jobs','agent_training_consents'))) = 24 as policies_ok,
  not exists (select 1 from pg_policies where schemaname = 'public' and roles::text[] && array['anon','public']
                and (tablename like 'training_library%' or tablename in ('sample_redaction_jobs','agent_training_consents'))) as no_anon_policies_ok,
  coalesce((select reloptions::text[] && array['security_invoker=true'] from pg_class
             where oid = to_regclass('public.training_library_manifest')), false) as view_invoker_ok,
  (select count(*) from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'training_library_%') = 4 as fns_ok,
  not exists (select 1 from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname like 'training_library_%'
                and (has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('authenticated', p.oid, 'execute'))) as fns_not_client_ok,
  (select count(*) from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where not t.tgisinternal and t.tgenabled = 'O' and t.tgname like 'training_library_%'
       and c.relname in ('sample_redaction_jobs','training_library_calls','training_library_ratings','training_library_reviews',
                         'agent_training_consents')) = 6 as triggers_ok,
  not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'training_library_calls'
                and column_name in ('call_id','source_agent_id')) as no_identity_cols_ok,
  (select count(*) from storage.buckets where id in ('sample-src','training-library') and not public) = 2 as buckets_private_ok,
  not exists (select 1 from storage.objects where bucket_id in ('sample-src','training-library')) as buckets_empty_ok,
  coalesce((select not enabled and value = '{}'::jsonb from public.feature_flags where key = 'recording_library'), false) as flag_off_ok,
  (select count(*) from public.sample_redaction_jobs) + (select count(*) from public.training_library_calls)
    + (select count(*) from public.training_library_ratings) + (select count(*) from public.agent_training_consents) = 0 as empty_ok,
  now() as checked_at;
