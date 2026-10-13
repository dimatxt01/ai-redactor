-- RL-1 behaviour cases. Each block asserts; any failure raises and stops the run (ON_ERROR_STOP).
\set ON_ERROR_STOP 1
CREATE OR REPLACE FUNCTION pg_temp.as_user(p uuid) RETURNS void LANGUAGE sql AS $$ SELECT set_config('request.jwt.claim.sub', coalesce(p::text,''), false) $$;
CREATE OR REPLACE FUNCTION pg_temp.expect_fail(p_sql text, p_what text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  BEGIN EXECUTE p_sql; EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'ok: % refused (%)', p_what, SQLSTATE; RETURN; END;
  RAISE EXCEPTION 'FAIL: % was allowed', p_what;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.as_user(uuid), pg_temp.expect_fail(text,text) TO authenticated, anon;

-- flag + buckets
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM feature_flags WHERE key='recording_library' AND NOT enabled AND value='{}'::jsonb) THEN RAISE EXCEPTION 'FAIL flag'; END IF;
  IF (SELECT count(*) FROM storage.buckets WHERE id IN ('sample-src','training-library') AND NOT public) <> 2 THEN RAISE EXCEPTION 'FAIL buckets'; END IF;
  RAISE NOTICE 'ok: flag OFF, 2 private buckets';
END $$;

-- ===== staff (AM) creates a job, a library call, source, clips =====
SET ROLE authenticated; SELECT pg_temp.as_user('22222222-0000-0000-0000-0000000000a3');
INSERT INTO sample_redaction_jobs (id, call_id, idempotency_key, submitted_by)
  VALUES ('dddddddd-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','call:cccccccc-0000-0000-0000-000000000001:v1', auth.uid());
SELECT pg_temp.expect_fail($q$INSERT INTO sample_redaction_jobs (call_id, idempotency_key) VALUES ('cccccccc-0000-0000-0000-000000000001','call:cccccccc-0000-0000-0000-000000000001:v1')$q$, 'duplicate idempotency_key');
SELECT pg_temp.expect_fail($q$INSERT INTO sample_redaction_jobs (call_id, idempotency_key) VALUES ('cccccccc-0000-0000-0000-000000000001','nope')$q$, 'bad idempotency_key format');
INSERT INTO agent_training_consents (id, agent_id, consent_version, source, recorded_by)
  VALUES ('eeeeeeee-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','v0','offline', auth.uid());
SELECT pg_temp.expect_fail($q$INSERT INTO agent_training_consents (agent_id, consent_version, source) VALUES ('00000000-0000-0000-0000-0000000000a1','v0','offline')$q$, 'second active consent');
INSERT INTO training_library_calls (id, job_id, agent_ref, title)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','dddddddd-0000-0000-0000-000000000001','agent_A','Call 1');
INSERT INTO training_library_calls (id, agent_ref, title)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000002','agent_A','Call 2 (stays pending)');
INSERT INTO training_library_calls (id, agent_ref, title)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000003','agent_B','Call 3 (agent Y, no consent)');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_calls (agent_ref, vertical) VALUES ('x','medicare')$q$, 'non-final_expense vertical');
INSERT INTO training_library_call_sources (library_call_id, call_id, source_agent_id, consent_id)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1','eeeeeeee-0000-0000-0000-000000000001'),
         ('aaaaaaaa-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000002','00000000-0000-0000-0000-0000000000a1','eeeeeeee-0000-0000-0000-000000000001'),
         ('aaaaaaaa-0000-0000-0000-000000000003','cccccccc-0000-0000-0000-000000000003','00000000-0000-0000-0000-0000000000a2', null);
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_call_sources (library_call_id, call_id, source_agent_id) VALUES ('aaaaaaaa-0000-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000001','00000000-0000-0000-0000-0000000000a1')$q$, 'second source row for a library call');
-- consent gate: Y has no consent -> approved call 3 still cannot publish
INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES ('aaaaaaaa-0000-0000-0000-000000000003', auth.uid(), 'approve', true);
SELECT pg_temp.expect_fail($q$UPDATE training_library_calls SET status='published' WHERE id='aaaaaaaa-0000-0000-0000-000000000003'$q$, 'publish without an active consent for the source agent');
INSERT INTO training_library_clips (id, library_call_id, clip_key, label, start_ms, end_ms) VALUES
  ('bbbbbbbb-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','c1','opener',0,40000),
  ('bbbbbbbb-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000002','c1','close',0,40000);
INSERT INTO training_library_clips (library_call_id, clip_key, label, start_ms, end_ms, audio_exported)
  VALUES ('aaaaaaaa-0000-0000-0000-000000000001','c6','application',100000,200000,false);
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_clips (library_call_id, clip_key, label, start_ms, end_ms) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','c9','smalltalk',0,1)$q$, 'label outside taxonomy');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_clips (library_call_id, clip_key, label, start_ms, end_ms) VALUES ('aaaaaaaa-0000-0000-0000-000000000001','c8','close',500,100)$q$, 'end_ms <= start_ms');

-- publish gate
SELECT pg_temp.expect_fail($q$UPDATE training_library_calls SET status='published' WHERE id='aaaaaaaa-0000-0000-0000-000000000001'$q$, 'publish without review');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', auth.uid(), 'approve', false)$q$, 'approve without listened_full');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', '22222222-0000-0000-0000-0000000000ad', 'approve', true)$q$, 'review as someone else');
INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', auth.uid(), 'approve', true);
UPDATE training_library_calls SET status='published' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT published_at FROM training_library_calls WHERE id='aaaaaaaa-0000-0000-0000-000000000001') IS NULL THEN RAISE EXCEPTION 'FAIL published_at'; END IF; RAISE NOTICE 'ok: publish after approve+listened_full'; END $$;
-- latest review decides: withdraw -> republish blocked -> new approve -> republish ok
UPDATE training_library_calls SET status='withdrawn' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', auth.uid(), 'withdraw', false);
SELECT pg_temp.expect_fail($q$UPDATE training_library_calls SET status='published' WHERE id='aaaaaaaa-0000-0000-0000-000000000001'$q$, 'republish after a later withdraw review');
INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', auth.uid(), 'reject', false);
SELECT pg_temp.expect_fail($q$UPDATE training_library_calls SET status='published' WHERE id='aaaaaaaa-0000-0000-0000-000000000001'$q$, 'republish after a later reject review');
INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', auth.uid(), 'approve', true);
UPDATE training_library_calls SET status='published' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT status FROM training_library_calls WHERE id='aaaaaaaa-0000-0000-0000-000000000001') <> 'published' THEN RAISE EXCEPTION 'FAIL republish'; END IF; RAISE NOTICE 'ok: republish after a newer approve+listened_full'; END $$;
SELECT pg_temp.expect_fail($q$UPDATE training_library_reviews SET notes='x'$q$, 'review update');
SELECT pg_temp.expect_fail($q$DELETE FROM training_library_reviews$q$, 'review delete');
SELECT pg_temp.expect_fail($q$DELETE FROM training_library_calls WHERE id='aaaaaaaa-0000-0000-0000-000000000002'$q$, 'staff delete library call');
RESET ROLE;
-- append-only also binds the owner (trigger)
SELECT pg_temp.expect_fail($q$UPDATE training_library_reviews SET notes='x'$q$, 'review update as owner');

-- ===== agent X =====
SET ROLE authenticated; SELECT pg_temp.as_user('11111111-0000-0000-0000-0000000000a1');
DO $$ BEGIN
  IF (SELECT count(*) FROM training_library_calls) <> 1 THEN RAISE EXCEPTION 'FAIL agent sees % calls', (SELECT count(*) FROM training_library_calls); END IF;
  IF (SELECT count(*) FROM training_library_clips) <> 2 THEN RAISE EXCEPTION 'FAIL agent sees % clips', (SELECT count(*) FROM training_library_clips); END IF;
  IF (SELECT count(*) FROM training_library_call_sources) <> 0 THEN RAISE EXCEPTION 'FAIL agent sees sources'; END IF;
  IF (SELECT count(*) FROM sample_redaction_jobs) <> 0 THEN RAISE EXCEPTION 'FAIL agent sees jobs'; END IF;
  IF (SELECT count(*) FROM training_library_reviews) <> 0 THEN RAISE EXCEPTION 'FAIL agent sees reviews'; END IF;
  IF (SELECT count(*) FROM agent_training_consents) <> 1 THEN RAISE EXCEPTION 'FAIL agent X own consent'; END IF;
  IF (SELECT count(*) FROM training_library_manifest WHERE source_agent_id IS NOT NULL OR idempotency_key IS NOT NULL) <> 0 THEN RAISE EXCEPTION 'FAIL manifest leaks identity'; END IF;
  RAISE NOTICE 'ok: agent X sees 1 published call, its 2 clips, own consent; no sources/jobs/reviews; manifest has no identity';
END $$;
INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote, comment)
  VALUES ('00000000-0000-0000-0000-0000000000a1','clip','bbbbbbbb-0000-0000-0000-000000000001', 1, 'great opener');
INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote)
  VALUES ('00000000-0000-0000-0000-0000000000a1','clip','bbbbbbbb-0000-0000-0000-000000000001', -1)
  ON CONFLICT (agent_id, item_type, item_id) DO UPDATE SET vote = excluded.vote, comment = excluded.comment;
DO $$ BEGIN IF (SELECT vote FROM training_library_ratings) <> -1 THEN RAISE EXCEPTION 'FAIL upsert'; END IF; RAISE NOTICE 'ok: vote upsert +1 -> -1'; END $$;
INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote) VALUES ('00000000-0000-0000-0000-0000000000a1','call','aaaaaaaa-0000-0000-0000-000000000001', 1);
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote) VALUES ('00000000-0000-0000-0000-0000000000a1','call','aaaaaaaa-0000-0000-0000-000000000002', 1)$q$, 'vote on unpublished call');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote) VALUES ('00000000-0000-0000-0000-0000000000a1','clip','bbbbbbbb-0000-0000-0000-000000000002', 1)$q$, 'vote on clip of unpublished call');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote) VALUES ('00000000-0000-0000-0000-0000000000a1','clip','bbbbbbbb-0000-0000-0000-000000000001', 0)$q$, 'vote 0 (exists already; also checked below)');
SELECT pg_temp.expect_fail($q$UPDATE training_library_ratings SET vote = 5$q$, 'vote 5');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_ratings (agent_id, item_type, item_id, vote) VALUES ('00000000-0000-0000-0000-0000000000a2','call','aaaaaaaa-0000-0000-0000-000000000001', 1)$q$, 'vote as another agent');
SELECT pg_temp.expect_fail($q$DELETE FROM training_library_ratings$q$, 'agent delete rating');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_calls (agent_ref) VALUES ('x')$q$, 'agent insert library call');
SELECT pg_temp.expect_fail($q$INSERT INTO agent_training_consents (agent_id, consent_version, source) VALUES ('00000000-0000-0000-0000-0000000000a2','v0','portal')$q$, 'agent insert consent');
SELECT pg_temp.expect_fail($q$INSERT INTO training_library_reviews (library_call_id, reviewer, decision) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', auth.uid(), 'reject')$q$, 'agent insert review');
UPDATE training_library_calls SET title = 'hacked' WHERE true;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM training_library_calls WHERE title='hacked') THEN RAISE EXCEPTION 'FAIL agent updated call'; END IF; RAISE NOTICE 'ok: agent update of calls touches 0 rows'; END $$;

-- ===== agent Y: cannot see X's ratings =====
SELECT pg_temp.as_user('11111111-0000-0000-0000-0000000000a2');
DO $$ BEGIN
  IF (SELECT count(*) FROM training_library_ratings) <> 0 THEN RAISE EXCEPTION 'FAIL agent Y sees others ratings'; END IF;
  IF (SELECT count(*) FROM agent_training_consents) <> 0 THEN RAISE EXCEPTION 'FAIL agent Y sees X consent'; END IF;
  RAISE NOTICE 'ok: agent Y sees 0 ratings of others, 0 foreign consents';
END $$;
UPDATE training_library_ratings SET vote = 1 WHERE true;

-- ===== plain authenticated user with no agent row / no role =====
SELECT pg_temp.as_user('33333333-0000-0000-0000-000000000099');
DO $$ BEGIN IF (SELECT count(*) FROM training_library_calls) + (SELECT count(*) FROM training_library_clips) <> 0 THEN RAISE EXCEPTION 'FAIL non-agent sees library'; END IF; RAISE NOTICE 'ok: non-agent user sees nothing'; END $$;

-- ===== AM reads all ratings =====
SELECT pg_temp.as_user('22222222-0000-0000-0000-0000000000a3');
DO $$ BEGIN
  IF (SELECT count(*) FROM training_library_ratings) <> 2 THEN RAISE EXCEPTION 'FAIL staff ratings count %', (SELECT count(*) FROM training_library_ratings); END IF;
  IF (SELECT vote FROM training_library_ratings WHERE item_type='clip') <> -1 THEN RAISE EXCEPTION 'FAIL agent Y changed X rating'; END IF;
  IF (SELECT count(*) FROM training_library_manifest WHERE source_agent_id IS NOT NULL AND call_id IS NOT NULL) <> 3 THEN RAISE EXCEPTION 'FAIL staff manifest'; END IF;
  RAISE NOTICE 'ok: staff reads all ratings; Y could not change X rating; manifest shows identity to staff';
END $$;
-- consent revoke -> auto-withdraw + append-only review row
UPDATE agent_training_consents SET revoked_at = now() WHERE id = 'eeeeeeee-0000-0000-0000-000000000001';
DO $$ BEGIN
  IF (SELECT status FROM training_library_calls WHERE id='aaaaaaaa-0000-0000-0000-000000000001') <> 'withdrawn' THEN RAISE EXCEPTION 'FAIL revoke did not withdraw'; END IF;
  IF (SELECT count(*) FROM training_library_reviews WHERE library_call_id='aaaaaaaa-0000-0000-0000-000000000001' AND decision='withdraw' AND notes='auto: consent revoked') <> 1 THEN RAISE EXCEPTION 'FAIL no auto withdraw review'; END IF;
  IF (SELECT status FROM training_library_calls WHERE id='aaaaaaaa-0000-0000-0000-000000000002') <> 'pending_qa' THEN RAISE EXCEPTION 'FAIL pending item touched'; END IF;
  RAISE NOTICE 'ok: consent revoke withdrew the published item and wrote one auto withdraw review; pending item untouched';
END $$;
-- re-approve cannot republish while consent is revoked
INSERT INTO training_library_reviews (library_call_id, reviewer, decision, listened_full) VALUES ('aaaaaaaa-0000-0000-0000-000000000001', auth.uid(), 'approve', true);
SELECT pg_temp.expect_fail($q$UPDATE training_library_calls SET status='published' WHERE id='aaaaaaaa-0000-0000-0000-000000000001'$q$, 'republish while consent revoked');
-- new consent -> republish ok
INSERT INTO agent_training_consents (agent_id, consent_version, source, recorded_by) VALUES ('00000000-0000-0000-0000-0000000000a1','v1','offline', auth.uid());
UPDATE training_library_calls SET status='published' WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
DO $$ BEGIN RAISE NOTICE 'ok: republish after a new consent'; END $$;
RESET ROLE;
-- agent X: published row exposes no calls.id / agents.id (columns do not exist on the agent-readable table)
SET ROLE authenticated; SELECT pg_temp.as_user('11111111-0000-0000-0000-0000000000a1');
SELECT pg_temp.expect_fail($q$SELECT call_id FROM training_library_calls$q$, 'agent reading a call_id column');
DO $$ BEGIN IF (SELECT count(*) FROM training_library_manifest WHERE call_id IS NOT NULL) <> 0 THEN RAISE EXCEPTION 'FAIL manifest leaks call_id to agent'; END IF; RAISE NOTICE 'ok: agent sees no calls.id via table or manifest'; END $$;
RESET ROLE;
-- FK behaviour on calls
SELECT pg_temp.expect_fail($q$DELETE FROM calls WHERE id='cccccccc-0000-0000-0000-000000000001'$q$, 'deleting a call referenced by the library (RESTRICT)');
DELETE FROM training_library_calls WHERE id='aaaaaaaa-0000-0000-0000-000000000002';
DELETE FROM sample_redaction_jobs WHERE id='dddddddd-0000-0000-0000-000000000001';
DO $$ BEGIN IF (SELECT job_id FROM training_library_calls WHERE id='aaaaaaaa-0000-0000-0000-000000000001') IS NOT NULL THEN RAISE EXCEPTION 'FAIL job SET NULL'; END IF; RAISE NOTICE 'ok: job purge sets library job_id NULL'; END $$;
DELETE FROM calls WHERE id='cccccccc-0000-0000-0000-000000000002';
DO $$ BEGIN RAISE NOTICE 'ok: call deletable once nothing references it'; END $$;

-- ===== anon: nothing =====
SET ROLE anon;
SELECT pg_temp.expect_fail($q$SELECT 1 FROM training_library_calls$q$, 'anon select calls');
SELECT pg_temp.expect_fail($q$SELECT 1 FROM training_library_ratings$q$, 'anon select ratings');
SELECT pg_temp.expect_fail($q$SELECT 1 FROM training_library_manifest$q$, 'anon select manifest');
RESET ROLE;
DO $$ BEGIN
  IF (SELECT count(*) FROM pg_proc p WHERE p.proname LIKE 'training_library_%') <> 4 THEN RAISE EXCEPTION 'FAIL fn count'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.proname LIKE 'training_library_%' AND (has_function_privilege('authenticated', p.oid, 'execute') OR has_function_privilege('anon', p.oid, 'execute'))) THEN
    RAISE EXCEPTION 'FAIL a training_library function is client-executable'; END IF;
  RAISE NOTICE 'ok: no client-executable functions';
END $$;
SELECT 'PASS' AS cases;
