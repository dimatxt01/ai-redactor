-- SIMULATION ONLY, on the throwaway Postgres (never a real database). Applied after the RL-1 fixture
-- (truering/supabase/tests/training_library/_fixture.sql), the RL-1 migration and the worker migration.
-- Adds the live TrueRing columns/tables the two edge functions read that the minimal fixture leaves out.
-- The test calls' people and numbers are fictional.
CREATE TABLE public.call_dispositions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE);
INSERT INTO public.call_dispositions (name) VALUES ('Sale'), ('No Sale');
ALTER TABLE public.calls
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN status text NOT NULL DEFAULT 'completed',
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN disposition_id uuid REFERENCES public.call_dispositions(id),
  ADD COLUMN recording_url text,
  ADD COLUMN telnyx_call_control_id text,
  ADD COLUMN caller_name text,
  ADD COLUMN caller_number text;
CREATE TABLE public.security_activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_type text NOT NULL, user_id uuid, portal text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
-- Supabase grants service_role every public table (default privileges); the fixture only creates them.
GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO service_role;
GRANT USAGE ON SCHEMA storage TO service_role;
