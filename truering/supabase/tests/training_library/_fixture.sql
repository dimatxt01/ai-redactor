-- Minimal Supabase-shaped fixture for the RL-1 test (NOT prod data). Roles, auth.uid(), app_role, has_role, agents, calls,
-- feature_flags, storage.buckets/objects. Mirrors the live shapes the migration touches (checked read-only 2026-10-12).
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA auth; CREATE SCHEMA storage;
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT EXECUTE ON FUNCTION auth.uid() TO anon, authenticated, service_role;
CREATE TYPE public.app_role AS ENUM ('admin','superadmin','account_manager','agent','agency_owner','media_buyer','publisher');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role app_role NOT NULL, created_at timestamptz DEFAULT now());
CREATE FUNCTION public.has_role(_user_id uuid, _role app_role) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS
$$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO anon, authenticated;
CREATE TABLE public.agents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, full_name text, verticals text[] DEFAULT '{final_expense}');
ALTER TABLE public.agents ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.agents TO authenticated;
CREATE POLICY agents_own ON public.agents FOR SELECT TO authenticated USING (user_id = auth.uid());
CREATE TABLE public.calls (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), agent_id uuid REFERENCES public.agents(id), duration int);
CREATE TABLE public.feature_flags (key text PRIMARY KEY, enabled boolean NOT NULL DEFAULT false, value jsonb NOT NULL DEFAULT '{}'::jsonb, description text, updated_at timestamptz DEFAULT now());
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text);
CREATE SCHEMA supabase_migrations;
CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[]);
-- people: admin A, AM M, agents X (featured) and Y, plain user U (no agent row, no role)
INSERT INTO public.agents (id, user_id, full_name) VALUES
  ('00000000-0000-0000-0000-0000000000a1','11111111-0000-0000-0000-0000000000a1','Agent X'),
  ('00000000-0000-0000-0000-0000000000a2','11111111-0000-0000-0000-0000000000a2','Agent Y');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('22222222-0000-0000-0000-0000000000ad','admin'), ('22222222-0000-0000-0000-0000000000a3','account_manager'),
  ('11111111-0000-0000-0000-0000000000a1','agent'), ('11111111-0000-0000-0000-0000000000a2','agent');
INSERT INTO public.calls (id, agent_id, duration) VALUES
  ('cccccccc-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1',1500),
  ('cccccccc-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000a1',900),
  ('cccccccc-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000a2',1200);
-- live-like delete protection (storage.protect_delete, checked read-only 2026-10-12)
CREATE FUNCTION storage.protect_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(current_setting('storage.allow_delete_query', true), 'false') != 'true' THEN
    RAISE EXCEPTION 'Direct deletion from storage tables is not allowed. Use the Storage API instead.' USING ERRCODE = '42501';
  END IF;
  RETURN NULL;
END $$;
CREATE TRIGGER protect_buckets_delete BEFORE DELETE ON storage.buckets FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
CREATE TRIGGER protect_objects_delete BEFORE DELETE ON storage.objects FOR EACH STATEMENT EXECUTE FUNCTION storage.protect_delete();
