// training-library-admin — every staff action of the Recording Library curation page
// (/am/recording-library and /admin/recording-library; TR_PLAN RL-2 submit, RL-4 links, RL-5 actions).
// Auth: staff JWT (user_roles admin | superadmin | account_manager; AM curation is global, Dmitry 2026-10-12),
// checked in-body (verify_jwt=false). Reads of the RL-1 tables go straight from the browser under RL-1's RLS;
// this function does the writes that need the service role, the caps, the worker or storage.
// Writes: sample_redaction_jobs (through sample_job_insert / sample_job_retry and status/tombstone updates),
// training_library_calls / _clips (status, titles, dropped clips), training_library_reviews, security_activity_log.
// Never writes calls/agents.
//
// Actions
//   pick     {min_s?, max_s?, agent_id?}      Sale calls with a Telnyx recording + agent name + consent flag, newest 300.
//                                             Server-side because calls RLS limits an AM to their own book, and AM
//                                             curation is global (Dmitry 2026-10-12 6:47 PM CT).
//   submit   {call_id, options, reprocess?}   flag recording_library ON; Final Expense Sale, Telnyx, 60–3600 s, active
//                                             agent consent; idempotent per call:<id>:v<n>; reserves the estimate; queues the job
//                                             (the worker picks it up on its next bridge poll; TR never calls the worker)
//   retry    {job_id}                         failed job → same key, queued again (spec §4 fetch_expired)
//   sweep    {}                               non-terminal jobs older than 2h → failed:timeout, copies purged (the worker's
//                                             next poll deletes their vendor copies)
//   link     {library_call_id, artifact}      10-min signed URL, logged (the log is the listen evidence).
//            artifact: audio | transcript_json | transcript_txt | pii_spans_json | clips_json | coaching_json | clip:<clip uuid>
//   review   {library_call_id, decision: approve|reject, listened_full, notes?}
//            approve needs listened_full AND this reviewer opened the full call and every exported clip (access log)
//   publish  {library_call_id}                status → published; the RL-1 trigger checks latest review + active consent
//   withdraw {library_call_id, notes?}        'withdraw' review + status → withdrawn
//   edit     {library_call_id, title?, tags?, clip_titles?: {<clip uuid>: title}, drop_clip_ids?: [uuid]}  not while published
//   delete   {call_id}                        takedown of every copy: tombstone FIRST, running jobs failed (their worker stops on its
//                                             next poll), both buckets purged, library rows withdrawn and emptied. A job with no
//                                             vendor copy and no live run is 'deleted' at once; otherwise the bridge marks it
//                                             'deleted' when the worker reports its AssemblyAI copies gone (pending_worker).
//
// Cost caps: submit/retry reserve the estimate against SAMPLE_MONTH_CAP_USD (default 100) atomically in SQL; an estimate
// over SAMPLE_JOB_CAP_USD (default 2) is refused. A month-cap refusal logs sample_cost_cap_blocked (ops-alert raises it).
// The worker enforces both caps again on actual spend.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { isTelnyxRecordingUrl } from '../_shared/telnyxRecording.ts';
import { stateFromNumber } from '../_shared/npaState.ts';
import { flagEnabled } from '../_shared/featureFlags.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const STAFF = new Set(['admin', 'superadmin', 'account_manager']);
// a running job's worker polls the bridge every ~20 s; a heartbeat older than this means no live run owns it
const STALE_MS = Number(Deno.env.get('SAMPLE_WORKER_STALE_S') || 300) * 1000;
const JOB_DEADLINE_MS = 2 * 60 * 60 * 1000;
const FILES: Record<string, string> = {
  transcript_json: 'transcript.json', transcript_txt: 'transcript.txt', pii_spans_json: 'pii_spans.json',
  clips_json: 'clips.json', coaching_json: 'coaching.json',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const LIB = 'training-library';
const SRC = 'sample-src';

const numEnv = (k: string, d: number) => {
  const v = Number(Deno.env.get(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};
// Same formula as ai-redactor's lib/cost.ts: two channels on pass 1, one on the verification
// pass, plus a fixed allowance for the OpenRouter PII, clip and coaching calls.
const estimateJobUsd = (durationS: number) =>
  Math.round(((durationS / 3600) * numEnv('SAMPLE_ASR_USD_PER_HOUR', 0.45) * 3 + 0.25) * 10000) / 10000;

// SPEC v0.2 §1 defaults: pitch off for internal training; clips and coaching on.
function cleanOptions(o: any) {
  const pad = Number(o?.bleep_pad_ms);
  const terms = Array.isArray(o?.extra_terms) ? o.extra_terms : [];
  return {
    bleep_pad_ms: Number.isFinite(pad) ? Math.min(300, Math.max(200, Math.round(pad))) : 250,
    pitch_shift_customer: o?.pitch_shift_customer === true,
    redact_health: o?.redact_health !== false,
    clips: { enabled: o?.clips?.enabled !== false, max_per_call: 6, min_s: 20, max_s: 240 },
    coaching: { enabled: o?.coaching?.enabled !== false, rubric: 'fe_v1' },
    extra_terms: [...new Set(terms.map((t: unknown) => String(t).trim()).filter((t: string) => t.length >= 2 && t.length <= 60))].slice(0, 100),
    // TR states which leg is the customer (Telnyx dual-channel recording); the pilot verifies it.
    customer_channel: Number(o?.customer_channel) === 1 ? 1 : 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed', error_code: 'METHOD' }, 405);

  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // ── staff check ───────────────────────────────────────────────────────────
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized', error_code: 'NO_AUTH' }, 401);
  const { data: claims, error: claimsErr } = await admin.auth.getClaims(token);
  const userId = claims?.claims?.sub as string | undefined;
  if (claimsErr || !userId) return json({ error: 'unauthorized', error_code: 'BAD_AUTH' }, 401);
  const { data: roles } = await admin.from('user_roles').select('role').eq('user_id', userId);
  const myRoles = (roles ?? []).map((r) => String(r.role));
  if (!myRoles.some((r) => STAFF.has(r))) return json({ error: 'forbidden', error_code: 'NOT_STAFF' }, 403);
  const portal = myRoles.includes('admin') || myRoles.includes('superadmin') ? 'admin' : 'am';

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { return json({ error: 'bad json', error_code: 'BAD_JSON' }, 400); }
  const action = String(body.action ?? '');
  const jobCap = numEnv('SAMPLE_JOB_CAP_USD', 2);
  const monthCap = numEnv('SAMPLE_MONTH_CAP_USD', 100);

  const logEvent = async (event_type: string, metadata: Record<string, unknown>) => {
    const { error } = await admin.from('security_activity_log').insert({ event_type, user_id: userId, portal, metadata });
    if (error) console.error('[training-library-admin] log failed:', event_type, error.message);
  };

  const purge = async (bucket: string, prefix: string): Promise<number> => {
    let n = 0;
    for (const p of [prefix, `${prefix}/clips`]) {
      const { data: files, error: listErr } = await admin.storage.from(bucket).list(p, { limit: 1000 });
      if (listErr) throw new Error(`${bucket}/${p}: ${listErr.message}`);
      const names = (files ?? []).filter((f) => f.id).map((f) => `${p}/${f.name}`);   // folders have no id
      if (!names.length) continue;
      const { error } = await admin.storage.from(bucket).remove(names);
      if (error) throw new Error(`${bucket}/${p}: ${error.message}`);
      n += names.length;
    }
    return n;
  };

  const callTombstoned = async (callId: string): Promise<boolean> => {
    const { data } = await admin.from('sample_redaction_jobs').select('id').eq('call_id', callId).not('delete_requested_at', 'is', null).limit(1);
    return !!data?.length;
  };

  const libraryCall = async (id: string) => {
    if (!UUID_RE.test(id)) return null;
    const { data } = await admin.from('training_library_calls')
      .select('id, job_id, status, audio_path').eq('id', id).maybeSingle();
    return data;
  };

  switch (action) {
    case 'pick': {
      const minS = Math.max(60, Math.min(3600, Number(body.min_s) || 600));
      const maxS = Math.max(minS, Math.min(3600, Number(body.max_s) || 2400));
      const { data: disp } = await admin.from('call_dispositions').select('id').eq('name', 'Sale').maybeSingle();
      if (!disp) return json({ rows: [] });
      let q = admin.from('calls')
        .select('id, duration, created_at, agent_id, recording_url, agents:agent_id(full_name)')
        .eq('disposition_id', disp.id).not('recording_url', 'is', null).not('agent_id', 'is', null)
        .gte('duration', minS).lte('duration', maxS)
        .order('created_at', { ascending: false }).limit(300);
      if (UUID_RE.test(String(body.agent_id ?? ''))) q = q.eq('agent_id', body.agent_id);
      const { data, error } = await q;
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      const calls = (data ?? []).filter((c: any) => isTelnyxRecordingUrl(String(c.recording_url)));
      const agentIds = [...new Set(calls.map((c: any) => c.agent_id as string))];
      const consented = new Set<string>();
      for (let i = 0; i < agentIds.length; i += 100) {   // .in() lists ride in the URL: keep them short (BUG-129)
        const { data: cons } = await admin.from('agent_training_consents').select('agent_id')
          .is('revoked_at', null).in('agent_id', agentIds.slice(i, i + 100));
        for (const c of cons ?? []) consented.add(c.agent_id);
      }
      return json({
        rows: calls.map((c: any) => ({
          id: c.id, duration: c.duration, created_at: c.created_at, agent_id: c.agent_id,
          agent_name: c.agents?.full_name ?? null, consent: consented.has(c.agent_id),
        })),
      });
    }

    case 'submit': {
      if (!(await flagEnabled(admin, 'recording_library'))) {
        return json({ error: 'the Recording Library is switched off (flag recording_library)', error_code: 'FLAG_OFF' }, 403);
      }
      const callId = String(body.call_id ?? '');
      if (!UUID_RE.test(callId)) return json({ error: 'call_id required', error_code: 'BAD_CALL_ID' }, 400);
      if (await callTombstoned(callId)) return json({ error: 'this call was taken down; it cannot be sampled again', error_code: 'DELETED' }, 409);

      const { data: call, error: callErr } = await admin
        .from('calls')
        .select('id, duration, recording_url, created_at, agent_id, caller_number, call_dispositions:disposition_id(name)')
        .eq('id', callId)
        .maybeSingle();
      if (callErr) return json({ error: callErr.message, error_code: 'DB' }, 500);
      if (!call) return json({ error: 'no such call', error_code: 'NO_CALL' }, 404);

      // SPEC v0.2 §5 scope: Final Expense Sale calls only; Telnyx recordings; ≤60 min; agent consent on file.
      const disposition = (call as any).call_dispositions?.name ?? null;
      if (disposition !== 'Sale') return json({ error: `Sale calls only (this is ${disposition ?? 'undispositioned'})`, error_code: 'OUT_OF_SCOPE' }, 422);
      if (!call.recording_url) return json({ error: 'call has no recording', error_code: 'NO_RECORDING' }, 422);
      if (!isTelnyxRecordingUrl(call.recording_url)) return json({ error: 'Telnyx recordings only (Twilio-era calls are out of scope)', error_code: 'OUT_OF_SCOPE' }, 422);
      const duration = Number(call.duration ?? 0);
      if (!(duration >= 60 && duration <= 3600)) return json({ error: `duration ${duration}s outside 60–3600s`, error_code: 'OUT_OF_SCOPE' }, 422);
      if (!call.agent_id) return json({ error: 'call has no agent', error_code: 'OUT_OF_SCOPE' }, 422);

      let verticals: string[] = ['final_expense'];
      const { data: ag, error: agErr } = await admin.from('agents').select('verticals').eq('id', call.agent_id).maybeSingle();
      if (!agErr && Array.isArray((ag as any)?.verticals)) verticals = (ag as any).verticals;
      if (!verticals.includes('final_expense') || verticals.some((v) => v === 'medicare' || v === 'aca')) {
        return json({ error: `Final Expense only; this agent works ${verticals.join(', ')}`, error_code: 'OUT_OF_SCOPE' }, 422);
      }
      const { data: consent } = await admin.from('agent_training_consents').select('id')
        .eq('agent_id', call.agent_id).is('revoked_at', null).maybeSingle();
      if (!consent) return json({ error: 'the agent has no active training-use consent on file', error_code: 'NO_CONSENT' }, 422);

      const { data: existing } = await admin
        .from('sample_redaction_jobs').select('id, version, status, idempotency_key')
        .eq('call_id', callId).order('version', { ascending: false }).limit(1);
      const latest = existing?.[0];
      if (latest && !body.reprocess) {
        return json({ job_id: latest.id, idempotency_key: latest.idempotency_key, status: latest.status, existing: true });
      }
      if (latest && !['done', 'failed'].includes(latest.status)) {
        return json({ error: `v${latest.version} is still ${latest.status}`, error_code: 'IN_FLIGHT' }, 409);
      }

      const estimate = estimateJobUsd(duration);
      if (estimate > jobCap) return json({ error: `estimated $${estimate.toFixed(2)} exceeds the $${jobCap} job cap`, error_code: 'COST_CAP' }, 402);
      const version = (latest?.version ?? 0) + 1;
      const options = cleanOptions(body.options);

      const { data: ins, error: insErr } = await admin.rpc('sample_job_insert', {
        p_call_id: callId,
        p_version: version,
        p_options: options,
        p_call_meta: {
          duration_s: duration,
          disposition,
          vertical: 'final_expense',
          caller_state: call.caller_number ? stateFromNumber(call.caller_number) : null,
          recorded_at: call.created_at,
          channel_map: { customer: options.customer_channel, agent: 1 - options.customer_channel, verified: false },
        },
        p_submitted_by: userId,
        p_reserved: estimate,
        p_month_cap: monthCap,
      });
      if (insErr) return json({ error: insErr.message, error_code: 'DB' }, 500);
      if (!ins?.ok) {
        if (ins?.reason === 'cost_cap') {
          await logEvent('sample_cost_cap_blocked', { where: 'submit', call_id: callId, spent_usd: Number(ins.spent_usd), estimate_usd: estimate, month_cap_usd: monthCap });
          return json({ error: `month committed $${Number(ins.spent_usd).toFixed(2)} + $${estimate.toFixed(2)} would pass the $${monthCap} cap`, error_code: 'COST_CAP' }, 402);
        }
        if (ins?.reason === 'deleted') return json({ error: 'this call was taken down', error_code: 'DELETED' }, 409);
        return json({ error: 'a job for this version already exists', error_code: 'DUPLICATE' }, 409);
      }
      // queued: the worker claims it on its next bridge poll
      return json({ job_id: String(ins.job_id), idempotency_key: String(ins.idempotency_key), version, status: 'queued', reserved_usd: estimate });
    }

    case 'retry': {
      const jobId = String(body.job_id ?? '');
      if (!UUID_RE.test(jobId)) return json({ error: 'job_id required', error_code: 'BAD_JOB_ID' }, 400);
      const { data: prior } = await admin.from('sample_redaction_jobs').select('call_meta').eq('id', jobId).maybeSingle();
      if (!prior) return json({ error: 'no such job', error_code: 'NOT_FOUND' }, 404);
      const estimate = estimateJobUsd(Number((prior.call_meta as any)?.duration_s ?? 3600));
      const { data: r, error } = await admin.rpc('sample_job_retry', { p_job_id: jobId, p_reserved: estimate, p_month_cap: monthCap });
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      if (!r?.ok) {
        if (r?.reason === 'cost_cap') {
          await logEvent('sample_cost_cap_blocked', { where: 'retry', job_id: jobId, spent_usd: Number(r.spent_usd), estimate_usd: estimate, month_cap_usd: monthCap });
        }
        const map: Record<string, [string, string, number]> = {
          not_failed: ['only failed jobs can be retried', 'NOT_FAILED', 409],
          deleted: ['this call was taken down', 'DELETED', 409],
          cost_cap: [`month cap $${monthCap} would be passed`, 'COST_CAP', 402],
          not_found: ['no such job', 'NOT_FOUND', 404],
        };
        const [msg, code, status] = map[String(r?.reason)] ?? ['retry refused', 'REFUSED', 409];
        return json({ error: msg, error_code: code }, status);
      }
      return json({ job_id: jobId, status: 'queued' });
    }

    case 'sweep': {
      const cutoff = new Date(Date.now() - JOB_DEADLINE_MS).toISOString();
      const { data: stale, error } = await admin.from('sample_redaction_jobs').update({
        status: 'failed', error_code: 'timeout', error_detail: 'job exceeded 2h (sweep)', completed_at: new Date().toISOString(),
      }).not('status', 'in', '(done,failed,deleted)').lt('created_at', cutoff).select('id');
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      if (!stale?.length) return json({ timed_out: 0 });
      // the dead run left raw audio + transcripts in scratch: purge now (its vendor copies go on the worker's next poll)
      for (const j of stale) {
        try {
          await purge(SRC, j.id);
          await purge(LIB, j.id);
        } catch (e) {
          console.error('[training-library-admin] sweep purge failed:', j.id, e instanceof Error ? e.message : 'error');
        }
      }
      return json({ timed_out: stale.length });
    }

    case 'link': {
      const row = await libraryCall(String(body.library_call_id ?? ''));
      if (!row?.job_id) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      const artifact = String(body.artifact ?? '');
      let path: string | null = null;
      let clipId: string | null = null;
      if (artifact === 'audio') path = row.audio_path;
      else if (FILES[artifact]) path = `${row.job_id}/${FILES[artifact]}`;
      else if (artifact.startsWith('clip:')) {
        clipId = artifact.slice(5);
        if (!UUID_RE.test(clipId)) return json({ error: 'bad clip id', error_code: 'BAD_INPUT' }, 400);
        const { data: clip } = await admin.from('training_library_clips').select('audio_path, audio_exported')
          .eq('id', clipId).eq('library_call_id', row.id).maybeSingle();
        path = clip?.audio_exported ? clip.audio_path : null;
      } else return json({ error: 'unknown artifact', error_code: 'BAD_INPUT' }, 400);
      if (!path) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      const { data: signed, error } = await admin.storage.from(LIB).createSignedUrl(path, 600);
      if (error || !signed) return json({ error: error?.message ?? 'not found', error_code: 'NOT_FOUND' }, 404);
      await logEvent('training_library_access', { library_call_id: row.id, artifact: clipId ? 'clip' : artifact, clip_id: clipId, status: row.status });
      return json({ url: signed.signedUrl, expires_in_s: 600 });
    }

    case 'review': {
      const row = await libraryCall(String(body.library_call_id ?? ''));
      if (!row) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
      if (!decision) return json({ error: 'decision must be approve or reject', error_code: 'BAD_INPUT' }, 400);
      if (row.status === 'published') return json({ error: 'withdraw it before reviewing again', error_code: 'BAD_STATE' }, 409);
      if (row.job_id && (await admin.from('sample_redaction_jobs').select('id').eq('id', row.job_id).not('delete_requested_at', 'is', null).maybeSingle()).data) {
        return json({ error: 'this sample was taken down', error_code: 'DELETED' }, 409);
      }
      const listenedFull = body.listened_full === true;
      if (decision === 'approve') {
        if (!listenedFull) return json({ error: 'approval needs the full call and every clip listened to', error_code: 'LISTEN_REQUIRED' }, 422);
        // evidence, not just a checkbox: this reviewer opened the full call and every exported clip
        const { data: opened } = await admin.from('security_activity_log').select('metadata')
          .eq('event_type', 'training_library_access').eq('user_id', userId).eq('metadata->>library_call_id', row.id).limit(1000);
        const seen = new Set((opened ?? []).map((r: any) => (r.metadata?.artifact === 'clip' ? `clip:${r.metadata?.clip_id}` : String(r.metadata?.artifact))));
        const { data: clips } = await admin.from('training_library_clips').select('id').eq('library_call_id', row.id).eq('audio_exported', true);
        const missing = [...(seen.has('audio') ? [] : ['full call']), ...(clips ?? []).filter((c) => !seen.has(`clip:${c.id}`)).map(() => 'a clip')];
        if (missing.length) return json({ error: `open and play ${[...new Set(missing)].join(' and ')} before approving`, error_code: 'LISTEN_REQUIRED' }, 422);
      }
      const { error: insErr } = await admin.from('training_library_reviews').insert({
        library_call_id: row.id, reviewer: userId, decision, listened_full: listenedFull,
        notes: body.notes ? String(body.notes).slice(0, 4000) : null,
      });
      if (insErr) return json({ error: insErr.message, error_code: 'DB' }, 500);
      if (decision === 'reject') {
        const { error } = await admin.from('training_library_calls').update({ status: 'rejected' }).eq('id', row.id);
        if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      } else if (row.status !== 'pending_qa') {
        const { error } = await admin.from('training_library_calls').update({ status: 'pending_qa' }).eq('id', row.id);
        if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      }
      return json({ ok: true, status: decision === 'reject' ? 'rejected' : 'pending_qa' });
    }

    case 'publish': {
      const row = await libraryCall(String(body.library_call_id ?? ''));
      if (!row) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      if (row.status === 'published') return json({ ok: true, already: true });
      if (!row.audio_path) return json({ error: 'nothing to publish (audio removed)', error_code: 'BAD_STATE' }, 409);
      // RL-1 trigger: the latest review must be approve + listened_full and the agent's consent active;
      // sample_redaction_takedown_guard: never after a takedown.
      const { error } = await admin.from('training_library_calls').update({ status: 'published' }).eq('id', row.id);
      if (error) return json({ error: error.message, error_code: 'GATE' }, 409);
      return json({ ok: true });
    }

    case 'withdraw': {
      const row = await libraryCall(String(body.library_call_id ?? ''));
      if (!row) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      if (row.status === 'withdrawn') return json({ ok: true, already: true });
      const { error: revErr } = await admin.from('training_library_reviews').insert({
        library_call_id: row.id, reviewer: userId, decision: 'withdraw', listened_full: false,
        notes: body.notes ? String(body.notes).slice(0, 4000) : null,
      });
      if (revErr) return json({ error: revErr.message, error_code: 'DB' }, 500);
      const { error } = await admin.from('training_library_calls').update({ status: 'withdrawn' }).eq('id', row.id);
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      return json({ ok: true });
    }

    case 'edit': {
      const row = await libraryCall(String(body.library_call_id ?? ''));
      if (!row) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      if (row.status === 'published') return json({ error: 'withdraw it before editing', error_code: 'BAD_STATE' }, 409);
      const patch: Record<string, unknown> = {};
      if (typeof body.title === 'string') patch.title = body.title.trim().slice(0, 200) || null;
      if (Array.isArray(body.tags)) patch.tags = body.tags.map(String).map((t: string) => t.trim()).filter(Boolean).slice(0, 20);
      if (Object.keys(patch).length) {
        const { error } = await admin.from('training_library_calls').update(patch).eq('id', row.id);
        if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      }
      const titles = body.clip_titles && typeof body.clip_titles === 'object' ? Object.entries(body.clip_titles) : [];
      for (const [clipId, t] of titles.slice(0, 20)) {
        if (!UUID_RE.test(clipId)) continue;
        await admin.from('training_library_clips').update({ title: String(t ?? '').trim().slice(0, 200) || null })
          .eq('id', clipId).eq('library_call_id', row.id);
      }
      const drop = Array.isArray(body.drop_clip_ids) ? body.drop_clip_ids.map(String).filter((s: string) => UUID_RE.test(s)).slice(0, 6) : [];
      let dropped = 0;
      for (const clipId of drop) {
        const { data: clip } = await admin.from('training_library_clips').select('id, audio_path')
          .eq('id', clipId).eq('library_call_id', row.id).maybeSingle();
        if (!clip) continue;
        if (clip.audio_path) {
          const { error } = await admin.storage.from(LIB).remove([clip.audio_path]);
          if (error) return json({ error: `clip audio not removed: ${error.message}`, error_code: 'STORAGE' }, 500);
        }
        const { error } = await admin.from('training_library_clips').delete().eq('id', clip.id);
        if (error) return json({ error: error.message, error_code: 'DB' }, 500);
        dropped++;
      }
      return json({ ok: true, dropped });
    }

    case 'delete': {
      const callId = String(body.call_id ?? '');
      if (!UUID_RE.test(callId)) return json({ error: 'call_id required', error_code: 'BAD_CALL_ID' }, 400);
      const nowIso = new Date().toISOString();

      // 1. tombstone FIRST: from here every bridge action, submit and retry refuses this call
      const { error: tombErr } = await admin.from('sample_redaction_jobs')
        .update({ delete_requested_at: nowIso }).eq('call_id', callId).is('delete_requested_at', null);
      if (tombErr) return json({ error: tombErr.message, error_code: 'DB' }, 500);
      // a running job fails here; its worker sees the tombstone on its next poll and stops
      await admin.from('sample_redaction_jobs').update({
        status: 'failed', error_code: 'internal', error_detail: 'deleted by staff', completed_at: nowIso,
      }).eq('call_id', callId).not('status', 'in', '(done,failed,deleted)');

      const { data: jobs, error: jobsErr } = await admin
        .from('sample_redaction_jobs').select('id, status, heartbeat_at, asr_transcript_ids, deleted_at').eq('call_id', callId);
      if (jobsErr) return json({ error: jobsErr.message, error_code: 'DB' }, 500);
      if (!jobs?.length) return json({ error: 'no samples for this call', error_code: 'NOT_FOUND' }, 404);
      const jobIds = jobs.map((j) => j.id);

      // 2. TR copies: every job's scratch and artifacts (the bridge purges again when the worker confirms)
      const removed: Record<string, number> = { [LIB]: 0, [SRC]: 0 };
      try {
        for (const id of jobIds) {
          removed[LIB] += await purge(LIB, id);
          removed[SRC] += await purge(SRC, id);
        }
      } catch (e) {
        return json({ error: `storage purge failed: ${e instanceof Error ? e.message : String(e)}`, error_code: 'STORAGE', removed }, 500);
      }

      // 3. library rows stay as the take-down record, withdrawn and emptied of audio paths and generated text
      const { data: libs } = await admin.from('training_library_calls').select('id, status').in('job_id', jobIds);
      for (const l of libs ?? []) {
        if (l.status !== 'withdrawn') {
          await admin.from('training_library_reviews').insert({
            library_call_id: l.id, reviewer: userId, decision: 'withdraw', listened_full: false, notes: 'takedown: every copy deleted',
          });
        }
        await admin.from('training_library_calls').update({ status: 'withdrawn', audio_path: null, audio_sha256: null, coaching: {}, title: null })
          .eq('id', l.id);
        await admin.from('training_library_clips').update({ audio_path: null, audio_sha256: null, audio_exported: false, coaching: {}, title: null })
          .eq('library_call_id', l.id);
      }

      // 4. 'deleted' now where nothing is left for the worker: no AssemblyAI copy and no live run. The rest
      //    become 'deleted' when the worker reports their vendor copies gone (bridge `vendor_purged`).
      const live = (j: { heartbeat_at: string | null }) => !!j.heartbeat_at && Date.now() - new Date(j.heartbeat_at).getTime() <= STALE_MS;
      const done = jobs.filter((j) => !j.deleted_at && !(j.asr_transcript_ids ?? []).length && !live(j)).map((j) => j.id);
      if (done.length) {
        await admin.from('sample_redaction_jobs').update({ status: 'deleted', deleted_at: nowIso }).in('id', done).is('deleted_at', null);
      }
      const pending = jobs.filter((j) => !j.deleted_at && !done.includes(j.id)).length;
      await logEvent('training_library_deleted', { call_id: callId, jobs: jobs.length, removed, pending_worker: pending });
      return json({ ok: true, removed, deleted: done.length, pending_worker: pending });
    }

    default:
      return json({ error: `unknown action ${action}`, error_code: 'BAD_ACTION' }, 400);
  }
});
