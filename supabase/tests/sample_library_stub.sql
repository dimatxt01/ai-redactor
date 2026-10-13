-- Minimal stand-ins for the Supabase objects 20261012230000_sample_library.sql
-- depends on: roles, auth.uid()/auth.users, app_role + has_role, calls, storage.buckets.
-- Shapes follow production (has_role is SECURITY DEFINER over user_roles); only the
-- columns the migration touches exist. Test-only, never applied anywhere real.
create role anon nologin;
create role authenticated nologin;
create role service_role nologin bypassrls;

create schema auth;
create table auth.users (id uuid primary key);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

create type public.app_role as enum ('admin', 'superadmin', 'agent');
create table public.user_roles (user_id uuid not null references auth.users(id), role public.app_role not null);
create function public.has_role(_user_id uuid, _role public.app_role) returns boolean
  language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.user_roles where user_id = _user_id and role = _role)
$$;
grant execute on function public.has_role(uuid, public.app_role) to anon, authenticated, service_role;

create table public.calls (id uuid primary key default gen_random_uuid());

create schema storage;
create table storage.buckets (
  id text primary key, name text not null, public boolean default false,
  file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text);

grant usage on schema public to anon, authenticated, service_role;
grant all on all tables in schema public to service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant execute on functions to anon, authenticated, service_role;
