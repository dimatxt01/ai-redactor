-- RL-1 (TRU-248): Recording Library (internal TRAINING library) - tables, RLS, private buckets, flag OFF.
-- Status: STAGED, NOT APPLIED. Needs its own Dmitry migration go + critic's exact-command check; apply by CLI from clean main
-- with the md5-pinned package (online guard, probe gates, ledger, verify T+0/T+60s).
-- Contract: docs/recording-library/SPEC.md v0.2 §4 + docs/recording-library/TR_PLAN.md v0.2 (ratings = up/down vote, Dmitry 2026-10-12 6:36 PM CT).
--
-- What it does (schema only; no data rows except the flag; nothing reads these tables yet)
--   tables  sample_redaction_jobs        one row per submit to the external redaction service (idempotency_key unique)
--           agent_training_consents      training-use release per agent (one ACTIVE row per agent; revoke = revoked_at)
--           training_library_calls       a processed call (pseudonymized agent_ref, coaching jsonb, status, publish gate). Holds NO
--                                        calls.id and NO agents.id: agents can read published rows, so identity lives elsewhere.
--           training_library_call_sources staff-only: library call -> real calls.id + agents.id + consent
--           training_library_clips       labeled clip segments (fixed taxonomy) with per-clip coaching
--           training_library_reviews     APPEND-ONLY QA log (trigger blocks update/delete)
--           training_library_ratings     agent up/down vote (+1/-1) + optional comment, one row per agent per item (upsert)
--   view    training_library_manifest    (security_invoker) staff audit/export view
--   buckets sample-src, training-library  PRIVATE; no storage.objects policies => only service_role (edge functions) can touch them
--   flag    recording_library             created DISABLED, value {}. Flags are never armed inside migrations.
--
-- Access model (RLS, all policies TO authenticated; anon gets nothing)
--   staff  = has_role(auth.uid(), admin|superadmin|account_manager). AM curation is GLOBAL by design (Dmitry 2026-10-12 6:47 PM
--            CT): an AM sees and curates calls from ALL agents, not only their own book. Read/write jobs, consents, calls, sources, clips;
--            read + insert reviews (reviewer = self); read all ratings. No deletes for anyone but service_role.
--   agent  = the agents row with user_id = auth.uid(): read PUBLISHED calls + their clips; read OWN consent rows;
--            read/insert/update OWN ratings, only on published items. Agents can never read call_sources, jobs, reviews,
--            other agents' ratings.
--   Publish gate (trigger): training_library_calls.status may become 'published' only when (a) the LATEST review for that
--            call is 'approve' with listened_full = true (a later reject/withdraw blocks re-publishing) and (b) the source agent
--            has an ACTIVE training consent (revoked_at is null).
--   Consent revoke (trigger): setting agent_training_consents.revoked_at withdraws every published item of that agent and
--            writes one append-only 'withdraw' review per item (notes 'auto: consent revoked').
-- Foreign keys: rows that reference public.calls use ON DELETE RESTRICT (calls are billing/audit records; deleting a call that a
--   library item or redaction job points at must fail loudly, never silently drop training content or its provenance).
--   library -> job: ON DELETE SET NULL (jobs may be purged by retention; the published item stays). source -> consent: SET NULL.
--   source -> agent: RESTRICT (withdraw first). clips/reviews/sources -> library call: CASCADE (owned children).
-- No new functions are executable by anon/authenticated (only trigger functions, EXECUTE revoked), so the integrity-audit
-- function_acl exact sets are unchanged. Manifest 2026-10-12.1 adds the flag to known_optional and the publish-gate, append-only
-- and consent-revoke triggers to triggers_enabled. ORDER: apply this migration BEFORE redeploying the audit (else MISSING findings).
-- Effect on existing data: none. Rollback: scripts/rollbacks/rollback_20261012180000_training_library.sql (drops everything
-- created here; buckets are removed only when empty).

SET LOCAL lock_timeout = '2s';
SET LOCAL statement_timeout = '30s';

-- ── 0. preconditions ───────────────────────────────────────────────────────
DO $pre$
BEGIN
  IF to_regclass('public.feature_flags') IS NULL OR to_regclass('public.calls') IS NULL
     OR to_regclass('public.agents') IS NULL OR to_regclass('public.user_roles') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION: feature_flags / calls / agents / user_roles missing';
  END IF;
  IF to_regprocedure('public.has_role(uuid,app_role)') IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION: public.has_role(uuid, app_role) missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'public'::regnamespace
              AND relname IN ('sample_redaction_jobs','agent_training_consents','training_library_calls',
                              'training_library_call_sources','training_library_clips','training_library_reviews',
                              'training_library_ratings','training_library_manifest')) THEN
    RAISE EXCEPTION 'PRECONDITION: a training library relation already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id IN ('sample-src','training-library')) THEN
    RAISE EXCEPTION 'PRECONDITION: bucket sample-src or training-library already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM public.feature_flags WHERE key = 'recording_library') THEN
    RAISE EXCEPTION 'PRECONDITION: flag recording_library already exists';
  END IF;
END $pre$;

-- ── 1. shared trigger functions (not callable by clients) ──────────────────
CREATE FUNCTION public.training_library_touch() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN NEW.updated_at := now(); RETURN NEW; END
$fn$;

CREATE FUNCTION public.training_library_reviews_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN RAISE EXCEPTION 'training_library_reviews is append-only' USING ERRCODE = 'insufficient_privilege'; END
$fn$;

CREATE FUNCTION public.training_library_publish_gate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public, pg_temp AS $fn$
BEGIN
  IF NEW.status = 'published' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'published') THEN
    -- the LATEST review decides: a later reject / withdraw blocks (re)publishing until a new approve + listened_full
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

-- SECURITY DEFINER so the withdraw also works when the revoke comes from an agent-side path (RL-6) that cannot write
-- library rows itself. Not client-callable (EXECUTE revoked); it only runs as the AFTER UPDATE trigger below.
CREATE FUNCTION public.training_library_consent_revoked() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
DECLARE v_id uuid;
BEGIN
  IF OLD.revoked_at IS NULL AND NEW.revoked_at IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.agent_training_consents k
                      WHERE k.agent_id = NEW.agent_id AND k.revoked_at IS NULL AND k.id <> NEW.id) THEN
    FOR v_id IN SELECT c.id FROM public.training_library_calls c
                  JOIN public.training_library_call_sources s ON s.library_call_id = c.id
                 WHERE s.source_agent_id = NEW.agent_id AND c.status = 'published' LOOP
      INSERT INTO public.training_library_reviews (library_call_id, reviewer, decision, listened_full, notes)
      VALUES (v_id, coalesce(auth.uid(), '00000000-0000-0000-0000-000000000000'::uuid), 'withdraw', false, 'auto: consent revoked');
      UPDATE public.training_library_calls SET status = 'withdrawn' WHERE id = v_id;
    END LOOP;
  END IF;
  RETURN NULL;
END
$fn$;

REVOKE ALL ON FUNCTION public.training_library_consent_revoked() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.training_library_touch() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.training_library_reviews_append_only() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.training_library_publish_gate() FROM PUBLIC, anon, authenticated;

-- ── 2. tables ──────────────────────────────────────────────────────────────
CREATE TABLE public.sample_redaction_jobs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         uuid NOT NULL REFERENCES public.calls(id) ON DELETE RESTRICT,
  idempotency_key text NOT NULL UNIQUE CHECK (idempotency_key ~ '^call:[0-9a-f-]{36}:v[0-9]+$'),
  status          text NOT NULL DEFAULT 'queued'
                  CHECK (status IN ('queued','fetching','transcribing','redacting','verifying','done','failed','deleted')),
  error_code      text,
  qa_flag         boolean NOT NULL DEFAULT false,
  qa_reasons      jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics         jsonb NOT NULL DEFAULT '{}'::jsonb,
  engine          jsonb NOT NULL DEFAULT '{}'::jsonb,
  schema_version  text,
  submitted_by    uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sample_redaction_jobs_call_idx ON public.sample_redaction_jobs (call_id);

CREATE TABLE public.agent_training_consents (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  consent_version text NOT NULL CHECK (length(consent_version) BETWEEN 1 AND 40),
  source          text NOT NULL CHECK (source IN ('portal','offline')),
  recorded_by     uuid,
  ip              text,
  user_agent      text,
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX agent_training_consents_one_active ON public.agent_training_consents (agent_id) WHERE revoked_at IS NULL;

CREATE TABLE public.training_library_calls (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid REFERENCES public.sample_redaction_jobs(id) ON DELETE SET NULL,
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  agent_ref     text NOT NULL CHECK (length(agent_ref) BETWEEN 1 AND 40),
  vertical      text NOT NULL DEFAULT 'final_expense' CHECK (vertical = 'final_expense'),
  duration_s    integer CHECK (duration_s IS NULL OR duration_s >= 0),
  audio_path    text,
  audio_sha256  text CHECK (audio_sha256 IS NULL OR audio_sha256 ~ '^[0-9a-f]{64}$'),
  coaching      jsonb NOT NULL DEFAULT '{}'::jsonb,
  title         text,
  tags          text[] NOT NULL DEFAULT '{}',
  status        text NOT NULL DEFAULT 'pending_qa' CHECK (status IN ('pending_qa','published','rejected','withdrawn')),
  published_at  timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX training_library_calls_status_idx ON public.training_library_calls (status);

CREATE TABLE public.training_library_call_sources (
  library_call_id uuid PRIMARY KEY REFERENCES public.training_library_calls(id) ON DELETE CASCADE,
  call_id         uuid NOT NULL REFERENCES public.calls(id) ON DELETE RESTRICT,
  call_version    integer NOT NULL DEFAULT 1 CHECK (call_version >= 1),
  source_agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE RESTRICT,
  consent_id      uuid REFERENCES public.agent_training_consents(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (call_id, call_version)
);
CREATE INDEX training_library_call_sources_agent_idx ON public.training_library_call_sources (source_agent_id);

CREATE TABLE public.training_library_clips (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  library_call_id uuid NOT NULL REFERENCES public.training_library_calls(id) ON DELETE CASCADE,
  clip_key        text NOT NULL,
  label           text NOT NULL CHECK (label IN ('opener','rapport','discovery','budget','presentation','objection',
                                                 'close','application','wrap_up')),
  sub_label       text,
  start_ms        integer NOT NULL CHECK (start_ms >= 0),
  end_ms          integer NOT NULL,
  audio_exported  boolean NOT NULL DEFAULT true,
  audio_path      text,
  audio_sha256    text CHECK (audio_sha256 IS NULL OR audio_sha256 ~ '^[0-9a-f]{64}$'),
  title           text,
  coaching        jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence      numeric CHECK (confidence IS NULL OR confidence BETWEEN 0 AND 1),
  sort_order      integer NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_ms > start_ms),
  CHECK (audio_exported OR audio_path IS NULL),
  UNIQUE (library_call_id, clip_key)
);

CREATE TABLE public.training_library_reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq             bigint GENERATED ALWAYS AS IDENTITY UNIQUE,  -- insertion order; the publish gate reads the latest by seq
  library_call_id uuid NOT NULL REFERENCES public.training_library_calls(id) ON DELETE CASCADE,
  reviewer        uuid NOT NULL,
  decision        text NOT NULL CHECK (decision IN ('approve','reject','withdraw')),
  listened_full   boolean NOT NULL DEFAULT false,
  notes           text CHECK (notes IS NULL OR length(notes) <= 4000),
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (decision <> 'approve' OR listened_full)
);
CREATE INDEX training_library_reviews_call_idx ON public.training_library_reviews (library_call_id);

CREATE TABLE public.training_library_ratings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id   uuid NOT NULL REFERENCES public.agents(id) ON DELETE CASCADE,
  item_type  text NOT NULL CHECK (item_type IN ('call','clip')),
  item_id    uuid NOT NULL,
  vote       smallint NOT NULL CHECK (vote IN (-1, 1)),
  comment    text CHECK (comment IS NULL OR length(comment) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (agent_id, item_type, item_id)
);
CREATE INDEX training_library_ratings_item_idx ON public.training_library_ratings (item_type, item_id);

CREATE TRIGGER training_library_touch BEFORE UPDATE ON public.sample_redaction_jobs
  FOR EACH ROW EXECUTE FUNCTION public.training_library_touch();
CREATE TRIGGER training_library_touch BEFORE UPDATE ON public.training_library_calls
  FOR EACH ROW EXECUTE FUNCTION public.training_library_touch();
CREATE TRIGGER training_library_touch BEFORE UPDATE ON public.training_library_ratings
  FOR EACH ROW EXECUTE FUNCTION public.training_library_touch();
CREATE TRIGGER training_library_publish_gate BEFORE INSERT OR UPDATE OF status ON public.training_library_calls
  FOR EACH ROW EXECUTE FUNCTION public.training_library_publish_gate();
CREATE TRIGGER training_library_reviews_append_only BEFORE UPDATE OR DELETE ON public.training_library_reviews
  FOR EACH ROW EXECUTE FUNCTION public.training_library_reviews_append_only();
CREATE TRIGGER training_library_consent_revoked AFTER UPDATE OF revoked_at ON public.agent_training_consents
  FOR EACH ROW EXECUTE FUNCTION public.training_library_consent_revoked();

-- ── 3. privileges + RLS ────────────────────────────────────────────────────
ALTER TABLE public.sample_redaction_jobs         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_training_consents       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_library_calls        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_library_call_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_library_clips        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_library_reviews      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_library_ratings      ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.sample_redaction_jobs, public.agent_training_consents, public.training_library_calls,
              public.training_library_call_sources, public.training_library_clips, public.training_library_reviews,
              public.training_library_ratings FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.sample_redaction_jobs, public.agent_training_consents, public.training_library_calls,
              public.training_library_call_sources, public.training_library_clips, public.training_library_ratings TO authenticated;
GRANT SELECT, INSERT ON public.training_library_reviews TO authenticated;
GRANT ALL ON public.sample_redaction_jobs, public.agent_training_consents, public.training_library_calls,
              public.training_library_call_sources, public.training_library_clips, public.training_library_reviews,
              public.training_library_ratings TO service_role;

-- staff predicate (inline; has_role is the existing SECURITY DEFINER helper)
-- (public.has_role(auth.uid(),'admin') OR public.has_role(auth.uid(),'superadmin') OR public.has_role(auth.uid(),'account_manager'))

-- jobs: staff only
CREATE POLICY tl_jobs_staff_select ON public.sample_redaction_jobs FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_jobs_staff_insert ON public.sample_redaction_jobs FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_jobs_staff_update ON public.sample_redaction_jobs FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));

-- consents: staff read/write; agent reads own (agent self-grant/revoke arrives in RL-6 via its own reviewed path)
CREATE POLICY tl_consents_staff_select ON public.agent_training_consents FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_consents_own_select ON public.agent_training_consents FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.agents a WHERE a.id = agent_training_consents.agent_id AND a.user_id = auth.uid()));
CREATE POLICY tl_consents_staff_insert ON public.agent_training_consents FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_consents_staff_update ON public.agent_training_consents FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));

-- library calls: staff all; any authenticated agent reads published
CREATE POLICY tl_calls_staff_select ON public.training_library_calls FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_calls_agent_published ON public.training_library_calls FOR SELECT TO authenticated
  USING (status = 'published' AND EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = auth.uid()));
CREATE POLICY tl_calls_staff_insert ON public.training_library_calls FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_calls_staff_update ON public.training_library_calls FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));

-- call sources: staff only (this is where the real agent identity lives)
CREATE POLICY tl_sources_staff_select ON public.training_library_call_sources FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_sources_staff_insert ON public.training_library_call_sources FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_sources_staff_update ON public.training_library_call_sources FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));

-- clips: staff all; agents read clips of published calls
CREATE POLICY tl_clips_staff_select ON public.training_library_clips FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_clips_agent_published ON public.training_library_clips FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.training_library_calls c
                  WHERE c.id = training_library_clips.library_call_id AND c.status = 'published')
         AND EXISTS (SELECT 1 FROM public.agents a WHERE a.user_id = auth.uid()));
CREATE POLICY tl_clips_staff_insert ON public.training_library_clips FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_clips_staff_update ON public.training_library_clips FOR UPDATE TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role))
  WITH CHECK (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));

-- reviews: staff read + insert as self; append-only (no update/delete grants + trigger)
CREATE POLICY tl_reviews_staff_select ON public.training_library_reviews FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_reviews_staff_insert ON public.training_library_reviews FOR INSERT TO authenticated
  WITH CHECK (reviewer = auth.uid()
              AND (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role)));

-- ratings: agent reads/writes OWN rows on PUBLISHED items; staff reads all; nobody but service_role deletes
CREATE POLICY tl_ratings_own_select ON public.training_library_ratings FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.agents a WHERE a.id = training_library_ratings.agent_id AND a.user_id = auth.uid()));
CREATE POLICY tl_ratings_staff_select ON public.training_library_ratings FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'admin'::app_role) OR public.has_role(auth.uid(),'superadmin'::app_role) OR public.has_role(auth.uid(),'account_manager'::app_role));
CREATE POLICY tl_ratings_own_insert ON public.training_library_ratings FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.agents a WHERE a.id = training_library_ratings.agent_id AND a.user_id = auth.uid())
              AND ((item_type = 'call' AND EXISTS (SELECT 1 FROM public.training_library_calls c
                                                    WHERE c.id = item_id AND c.status = 'published'))
                OR (item_type = 'clip' AND EXISTS (SELECT 1 FROM public.training_library_clips k
                                                     JOIN public.training_library_calls c ON c.id = k.library_call_id
                                                    WHERE k.id = item_id AND c.status = 'published'))));
CREATE POLICY tl_ratings_own_update ON public.training_library_ratings FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.agents a WHERE a.id = training_library_ratings.agent_id AND a.user_id = auth.uid()))
  WITH CHECK (EXISTS (SELECT 1 FROM public.agents a WHERE a.id = training_library_ratings.agent_id AND a.user_id = auth.uid())
              AND ((item_type = 'call' AND EXISTS (SELECT 1 FROM public.training_library_calls c
                                                    WHERE c.id = item_id AND c.status = 'published'))
                OR (item_type = 'clip' AND EXISTS (SELECT 1 FROM public.training_library_clips k
                                                     JOIN public.training_library_calls c ON c.id = k.library_call_id
                                                    WHERE k.id = item_id AND c.status = 'published'))));

-- ── 4. staff manifest view (invoker rights => RLS of the caller applies) ────
CREATE VIEW public.training_library_manifest WITH (security_invoker = true) AS
SELECT c.id AS library_call_id, s.call_id, c.version, c.agent_ref, s.source_agent_id, s.consent_id,
       c.status, c.published_at, c.audio_sha256, j.idempotency_key, j.schema_version, j.engine,
       (SELECT count(*) FROM public.training_library_clips k WHERE k.library_call_id = c.id) AS clips,
       (SELECT max(r.created_at) FROM public.training_library_reviews r
         WHERE r.library_call_id = c.id AND r.decision = 'approve' AND r.listened_full) AS approved_at
  FROM public.training_library_calls c
  LEFT JOIN public.training_library_call_sources s ON s.library_call_id = c.id
  LEFT JOIN public.sample_redaction_jobs j ON j.id = c.job_id;
REVOKE ALL ON public.training_library_manifest FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.training_library_manifest TO authenticated, service_role;

-- ── 5. private buckets (no storage.objects policies: service_role only) ────
INSERT INTO storage.buckets (id, name, public) VALUES ('sample-src', 'sample-src', false), ('training-library', 'training-library', false);

-- ── 6. flag, created DISABLED ──────────────────────────────────────────────
INSERT INTO public.feature_flags (key, enabled, value, description)
VALUES ('recording_library', false, '{}'::jsonb,
        'RL (TRU-247..256): internal training Recording Library UI + submit path. Created OFF by 20261012180000; arming = separate Dmitry go.');
