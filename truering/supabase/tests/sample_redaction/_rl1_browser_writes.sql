-- TEST ONLY: re-creates RL-1's browser write grants/policies (the same statements as the rollback) so RL-1's own
-- cases, written for RL-1's browser write path, can run on top of 20261013090000. Never applied anywhere real.
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
