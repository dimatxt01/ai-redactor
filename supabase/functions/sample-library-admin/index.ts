// sample-library-admin — every browser action on /admin/sample-library.
// Auth: admin/superadmin JWT (user_roles), checked in-body (verify_jwt=false).
// Writes ONLY sample_redaction_jobs / sample_library / sample_library_approvals
// (job inserts/resets through the sample_job_insert / sample_job_retry RPCs)
// and security_activity_log (access log). Reads calls/agents/call_dispositions;
// never writes them.
//
// Actions:
//   submit {call_id, options, reprocess?}  create job (idempotent per call:v<n>) + start the worker
//   retry  {job_id}                        failed job → same key, restarted (spec §4 fetch_expired)
//   sweep  {}                              non-terminal jobs older than 2h → failed:timeout, copies purged
//   play_url {library_id, artifact}        10-min signed URL; logged (the log is the full-listen evidence)
//   approve {library_id, step, decision, listened_full, notes}
//   update {library_id, title?, tags?, consent_ref?, status?}  status ∈ published | withdrawn
//   delete {call_id}                       takedown: tombstone FIRST (no new work for the call, ever),
//                                          runs cancelled + vendor transcripts deleted via the worker,
//                                          both buckets purged now and again after signed URLs expire
//
// Cost caps: a submit/retry reserves its estimate against SAMPLE_MONTH_CAP_USD
// (default 100) atomically in SQL; an estimate over SAMPLE_JOB_CAP_USD (default 2)
// is refused. The worker enforces both again on actual spend.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { signSampleBody } from '../_shared/sampleSignature.ts';
import { isTelnyxRecordingUrl } from '../_shared/telnyxRecording.ts';
import { stateFromNumber } from '../_shared/npaState.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });

const WORKER_BUDGET_MS = 10_000;
const DELETE_BUDGET_MS = 45_000;
const JOB_DEADLINE_MS = 2 * 60 * 60 * 1000;
const ARTIFACT_COLS: Record<string, string> = {
  redacted_audio: 'redacted_audio_path',
  highlight_audio: 'highlight_audio_path',
  transcript_json: 'transcript_json_path',
  transcript_txt: 'transcript_txt_path',
  pii_spans_json: 'pii_spans_json_path',
  labels_json: 'labels_json_path',
  coaching_json: 'coaching_json_path',
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const numEnv = (k: string, d: number) => {
  const v = Number(Deno.env.get(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};
// Same formula as sample-redactor/lib/cost.ts: two channels on pass 1, one on the
// verification pass, plus a fixed allowance for the OpenRouter label/coaching calls.
const estimateJobUsd = (durationS: number) =>
  Math.round(((durationS / 3600) * numEnv('SAMPLE_ASR_USD_PER_HOUR', 0.45) * 3 + 0.25) * 10000) / 10000;

async function sha256Hex(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('');
}

function cleanOptions(o: any) {
  const pad = Number(o?.bleep_pad_ms);
  const target = Number(o?.highlight?.target_s);
  const terms = Array.isArray(o?.extra_terms) ? o.extra_terms : [];
  return {
    bleep_pad_ms: Number.isFinite(pad) ? Math.min(300, Math.max(200, Math.round(pad))) : 250,
    pitch_shift_customer: o?.pitch_shift_customer !== false,
    redact_health: o?.redact_health !== false,
    highlight: {
      enabled: o?.highlight?.enabled !== false,
      target_s: Number.isFinite(target) ? Math.min(480, Math.max(180, Math.round(target))) : 300,
    },
    extra_terms: [...new Set(terms.map((t: unknown) => String(t).trim()).filter((t: string) => t.length >= 2 && t.length <= 60))].slice(0, 100),
    // TR states which leg is the customer (Telnyx dual-channel recording); the pilot verifies it.
    customer_channel: Number(o?.customer_channel) === 1 ? 1 : 0,
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'method not allowed', error_code: 'METHOD' }, 405);

  const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
  const admin = createClient(supabaseUrl, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  // ── admin check ───────────────────────────────────────────────────────────
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'unauthorized', error_code: 'NO_AUTH' }, 401);
  const { data: claims, error: claimsErr } = await admin.auth.getClaims(token);
  const userId = claims?.claims?.sub as string | undefined;
  if (claimsErr || !userId) return json({ error: 'unauthorized', error_code: 'BAD_AUTH' }, 401);
  const { data: roles } = await admin.from('user_roles').select('role').eq('user_id', userId);
  if (!roles?.some((r) => r.role === 'admin' || r.role === 'superadmin')) {
    return json({ error: 'forbidden', error_code: 'NOT_ADMIN' }, 403);
  }

  let body: Record<string, any> = {};
  try { body = await req.json(); } catch { return json({ error: 'bad json', error_code: 'BAD_JSON' }, 400); }
  const action = String(body.action ?? '');
  const jobCap = numEnv('SAMPLE_JOB_CAP_USD', 2);
  const monthCap = numEnv('SAMPLE_MONTH_CAP_USD', 100);

  const callWorker = async (path: string, payload: unknown, budgetMs: number): Promise<{ ok: boolean; status: number; body: any; detail?: string }> => {
    const base = Deno.env.get('SAMPLE_REDACTOR_URL');
    const secret = Deno.env.get('SAMPLE_REDACTOR_START_SECRET');
    if (!base || !secret) return { ok: false, status: 0, body: null, detail: 'SAMPLE_REDACTOR_URL / SAMPLE_REDACTOR_START_SECRET not set' };
    const raw = JSON.stringify(payload);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), budgetMs);
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-TR-Signature': await signSampleBody(secret, raw) },
        body: raw,
        signal: ctl.signal,
      });
      const j = await res.json().catch(() => ({}));
      return { ok: res.ok && j?.ok !== false, status: res.status, body: j, detail: res.ok ? undefined : `worker ${res.status}` };
    } catch (e) {
      return { ok: false, status: 0, body: null, detail: `worker unreachable: ${e instanceof Error ? e.message : String(e)}` };
    } finally {
      clearTimeout(timer);
    }
  };

  const startWorker = async (jobId: string, idempotencyKey: string) => {
    const r = await callWorker('/api/jobs', { job_id: jobId, idempotency_key: idempotencyKey }, WORKER_BUDGET_MS);
    return r.ok ? { ok: true as const, runId: r.body?.run_id as string | undefined } : { ok: false as const, detail: r.detail ?? 'worker start failed' };
  };

  const markStartFailed = async (jobId: string, detail: string) => {
    await admin.from('sample_redaction_jobs').update({
      status: 'failed', error_code: 'internal', error_detail: detail.slice(0, 500),
      completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }).eq('id', jobId).eq('status', 'queued');
  };

  const purge = async (bucket: string, prefix: string): Promise<number> => {
    const { data: files } = await admin.storage.from(bucket).list(prefix, { limit: 1000 });
    if (!files?.length) return 0;
    const { error } = await admin.storage.from(bucket).remove(files.map((f) => `${prefix}/${f.name}`));
    if (error) throw new Error(`${bucket}/${prefix}: ${error.message}`);
    return files.length;
  };

  const callTombstoned = async (callId: string): Promise<boolean> => {
    const [{ data: j }, { data: l }] = await Promise.all([
      admin.from('sample_redaction_jobs').select('id').eq('call_id', callId).not('delete_requested_at', 'is', null).limit(1),
      admin.from('sample_library').select('id').eq('call_id', callId).not('deleted_at', 'is', null).limit(1),
    ]);
    return !!(j?.length || l?.length);
  };

  switch (action) {
    case 'submit': {
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

      // v1 scope (spec §5): Final Expense Sale calls only, Telnyx recordings only, ≤60 min.
      const disposition = (call as any).call_dispositions?.name ?? null;
      if (disposition !== 'Sale') return json({ error: `v1 takes Sale calls only (this is ${disposition ?? 'undispositioned'})`, error_code: 'OUT_OF_SCOPE' }, 422);
      if (!call.recording_url) return json({ error: 'call has no recording', error_code: 'NO_RECORDING' }, 422);
      if (!isTelnyxRecordingUrl(call.recording_url)) return json({ error: 'v1 takes Telnyx recordings only', error_code: 'OUT_OF_SCOPE' }, 422);
      const duration = Number(call.duration ?? 0);
      if (!(duration >= 60 && duration <= 3600)) return json({ error: `duration ${duration}s outside 60–3600s`, error_code: 'OUT_OF_SCOPE' }, 422);
      if (!call.agent_id) return json({ error: 'call has no agent', error_code: 'OUT_OF_SCOPE' }, 422);

      // agents.verticals may not exist yet (20261010193000 staged): absent ⇒ the column default {final_expense}.
      let verticals: string[] = ['final_expense'];
      const { data: ag, error: agErr } = await admin.from('agents').select('verticals').eq('id', call.agent_id).maybeSingle();
      if (!agErr && Array.isArray((ag as any)?.verticals)) verticals = (ag as any).verticals;
      if (!verticals.includes('final_expense') || verticals.some((v) => v === 'medicare' || v === 'aca')) {
        return json({ error: `v1 excludes agents working ${verticals.join(', ')} (CMS rules)`, error_code: 'OUT_OF_SCOPE' }, 422);
      }

      const { data: existing } = await admin
        .from('sample_redaction_jobs')
        .select('id, version, status, idempotency_key')
        .eq('call_id', callId)
        .order('version', { ascending: false })
        .limit(1);
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
      const idempotencyKey = `call:${callId}:v${version}`;
      const options = cleanOptions(body.options);

      const { data: ins, error: insErr } = await admin.rpc('sample_job_insert', {
        p_call_id: callId,
        p_version: version,
        p_key: idempotencyKey,
        p_options: options,
        p_call_meta: {
          duration_s: duration,
          disposition,
          agent_ref: `agent_${(await sha256Hex(`sample-agent-ref:${call.agent_id}`)).slice(0, 8)}`,
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
        if (ins?.reason === 'cost_cap') return json({ error: `month committed $${Number(ins.spent_usd).toFixed(2)} + $${estimate.toFixed(2)} would pass the $${monthCap} cap`, error_code: 'COST_CAP' }, 402);
        if (ins?.reason === 'deleted') return json({ error: 'this call was taken down', error_code: 'DELETED' }, 409);
        return json({ error: 'a job for this version already exists', error_code: 'DUPLICATE' }, 409);
      }
      const jobId = String(ins.job_id);

      const started = await startWorker(jobId, idempotencyKey);
      if (!started.ok) {
        console.error('[sample-library-admin] worker start failed:', jobId, started.detail);
        await markStartFailed(jobId, started.detail);
        return json({ error: started.detail, error_code: 'WORKER_START_FAILED', job_id: jobId }, 502);
      }
      // The worker's claim normally stamped it already; only fill a gap, never overwrite the owner.
      await admin.from('sample_redaction_jobs').update({ workflow_run_id: started.runId ?? null }).eq('id', jobId).is('workflow_run_id', null);
      return json({ job_id: jobId, idempotency_key: idempotencyKey, version, run_id: started.runId, reserved_usd: estimate });
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
        const map: Record<string, [string, string, number]> = {
          not_failed: ['only failed jobs can be retried', 'NOT_FAILED', 409],
          deleted: ['this call was taken down', 'DELETED', 409],
          cost_cap: [`month cap $${monthCap} would be passed`, 'COST_CAP', 402],
          not_found: ['no such job', 'NOT_FOUND', 404],
        };
        const [msg, code, status] = map[String(r?.reason)] ?? ['retry refused', 'REFUSED', 409];
        return json({ error: msg, error_code: code }, status);
      }
      const started = await startWorker(jobId, String(r.idempotency_key));
      if (!started.ok) {
        await markStartFailed(jobId, started.detail);
        return json({ error: started.detail, error_code: 'WORKER_START_FAILED' }, 502);
      }
      await admin.from('sample_redaction_jobs').update({ workflow_run_id: started.runId ?? null }).eq('id', jobId).is('workflow_run_id', null);
      return json({ job_id: jobId, run_id: started.runId });
    }

    case 'sweep': {
      const cutoff = new Date(Date.now() - JOB_DEADLINE_MS).toISOString();
      const nowIso = new Date().toISOString();
      const { data: stale, error } = await admin.from('sample_redaction_jobs').update({
        status: 'failed', error_code: 'timeout', error_detail: 'job exceeded 2h (sweep)', completed_at: nowIso, updated_at: nowIso,
      }).not('status', 'in', '(done,failed)').lt('created_at', cutoff).select('id, call_id, version, workflow_run_id, asr_transcript_ids');
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      if (!stale?.length) return json({ timed_out: 0 });
      // the dead run left raw audio + transcript in scratch: purge now, and again after its signed URLs expire
      for (const j of stale) {
        try {
          await purge('sample-work', j.id);
          await purge('sample-library', `${j.call_id}/v${j.version}`);
        } catch (e) {
          console.error('[sample-library-admin] sweep purge failed:', j.id, e instanceof Error ? e.message : 'error');
        }
      }
      const w = await callWorker('/api/delete', {
        job_ids: stale.map((j) => j.id),
        run_ids: stale.map((j) => j.workflow_run_id).filter(Boolean),
        transcript_ids: stale.flatMap((j) => j.asr_transcript_ids ?? []),
      }, DELETE_BUDGET_MS);
      if (!w.ok) console.error('[sample-library-admin] sweep vendor purge failed:', w.detail);
      return json({ timed_out: stale.length, vendor_purged: w.ok });
    }

    case 'play_url': {
      const libraryId = String(body.library_id ?? '');
      const col = ARTIFACT_COLS[String(body.artifact ?? '')];
      if (!UUID_RE.test(libraryId) || !col) return json({ error: 'library_id + artifact required', error_code: 'BAD_INPUT' }, 400);
      const { data: row } = await admin.from('sample_library').select(`id, status, deleted_at, ${col}`).eq('id', libraryId).maybeSingle();
      const path = (row as any)?.[col];
      if (!row || !path || (row as any).deleted_at) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      const { data: signed, error } = await admin.storage.from('sample-library').createSignedUrl(path, 600);
      if (error || !signed) return json({ error: error?.message ?? 'sign failed', error_code: 'STORAGE' }, 500);
      const { error: logErr } = await admin.from('security_activity_log').insert({
        event_type: 'sample_library_access',
        user_id: userId,
        portal: 'admin',
        metadata: { library_id: libraryId, artifact: body.artifact, status: (row as any).status },
      });
      if (logErr) console.error('[sample-library-admin] access log failed:', logErr.message);
      return json({ url: signed.signedUrl, expires_in_s: 600 });
    }

    case 'approve': {
      const libraryId = String(body.library_id ?? '');
      const step = body.step === 'legal' ? 'legal' : body.step === 'qa' ? 'qa' : null;
      const decision = body.decision === 'approve' ? 'approve' : body.decision === 'reject' ? 'reject' : null;
      const listenedFull = body.listened_full === true;
      if (!UUID_RE.test(libraryId) || !step || !decision) return json({ error: 'library_id, step, decision required', error_code: 'BAD_INPUT' }, 400);
      const { data: row } = await admin.from('sample_library').select('id, status, deleted_at').eq('id', libraryId).maybeSingle();
      if (!row || row.deleted_at) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      const allowedFrom = step === 'qa' ? ['pending_qa'] : ['qa_passed'];
      if (!allowedFrom.includes(row.status)) {
        return json({ error: `${step} decision not allowed while ${row.status}`, error_code: 'BAD_STATE' }, 409);
      }
      if (decision === 'approve') {
        if (!listenedFull) return json({ error: 'approval needs a full listen', error_code: 'LISTEN_REQUIRED' }, 422);
        // evidence, not just a checkbox: this approver must have opened the full redacted audio
        const { data: heard } = await admin.from('security_activity_log').select('id')
          .eq('event_type', 'sample_library_access').eq('user_id', userId)
          .eq('metadata->>library_id', libraryId).eq('metadata->>artifact', 'redacted_audio').limit(1);
        if (!heard?.length) return json({ error: 'open and play the full redacted audio before approving', error_code: 'LISTEN_REQUIRED' }, 422);
        if (step === 'legal') {
          const { data: qa } = await admin.from('sample_library_approvals').select('actor')
            .eq('library_id', libraryId).eq('step', 'qa').order('at', { ascending: false }).limit(1);
          if (qa?.[0]?.actor === userId) return json({ error: 'legal sign-off must come from a different person than QA', error_code: 'SAME_ACTOR' }, 409);
        }
      }
      const { error: insErr } = await admin.from('sample_library_approvals').insert({
        library_id: libraryId, step, actor: userId, decision, listened_full: listenedFull,
        notes: body.notes ? String(body.notes).slice(0, 2000) : null,
      });
      if (insErr) return json({ error: insErr.message, error_code: 'DB' }, 500);
      const next = decision === 'reject' ? 'rejected' : step === 'qa' ? 'qa_passed' : 'legal_approved';
      const { error: updErr } = await admin.from('sample_library').update({ status: next }).eq('id', libraryId).eq('status', row.status);
      if (updErr) return json({ error: updErr.message, error_code: 'GATE' }, 409);
      return json({ ok: true, status: next });
    }

    case 'update': {
      const libraryId = String(body.library_id ?? '');
      if (!UUID_RE.test(libraryId)) return json({ error: 'library_id required', error_code: 'BAD_INPUT' }, 400);
      const { data: row } = await admin.from('sample_library').select('id, status, deleted_at').eq('id', libraryId).maybeSingle();
      if (!row) return json({ error: 'not found', error_code: 'NOT_FOUND' }, 404);
      if (row.deleted_at) return json({ error: 'deleted samples cannot be edited', error_code: 'DELETED' }, 409);
      const patch: Record<string, unknown> = {};
      if (typeof body.title === 'string') patch.title = body.title.slice(0, 200);
      if (Array.isArray(body.tags)) patch.tags = body.tags.map(String).map((t: string) => t.trim()).filter(Boolean).slice(0, 20);
      if (typeof body.consent_ref === 'string') patch.consent_ref = body.consent_ref.trim().slice(0, 200) || null;
      if (body.status === 'published') {
        if (row.status !== 'legal_approved') return json({ error: `publish needs legal_approved (is ${row.status})`, error_code: 'BAD_STATE' }, 409);
        patch.status = 'published';
      } else if (body.status === 'withdrawn') {
        if (row.status === 'withdrawn') return json({ ok: true, already: true });
        patch.status = 'withdrawn';
      } else if (body.status !== undefined) {
        return json({ error: 'status must be published or withdrawn', error_code: 'BAD_INPUT' }, 400);
      }
      if (!Object.keys(patch).length) return json({ error: 'nothing to update', error_code: 'BAD_INPUT' }, 400);
      // The publish gate (qa + legal by two people with listened_full, consent_ref) is the DB trigger.
      const { error } = await admin.from('sample_library').update(patch).eq('id', libraryId);
      if (error) return json({ error: error.message, error_code: 'GATE' }, 409);
      return json({ ok: true });
    }

    case 'delete': {
      const callId = String(body.call_id ?? '');
      if (!UUID_RE.test(callId)) return json({ error: 'call_id required', error_code: 'BAD_CALL_ID' }, 400);
      const nowIso = new Date().toISOString();

      // 1. tombstone FIRST: from here every bridge action, submit and retry refuses this call
      const { error: tombErr } = await admin.from('sample_redaction_jobs')
        .update({ delete_requested_at: nowIso, updated_at: nowIso }).eq('call_id', callId).is('delete_requested_at', null);
      if (tombErr) return json({ error: tombErr.message, error_code: 'DB' }, 500);
      await admin.from('sample_redaction_jobs').update({
        status: 'failed', error_code: 'internal', error_detail: 'deleted by admin', completed_at: nowIso, updated_at: nowIso,
      }).eq('call_id', callId).not('status', 'in', '(done,failed)');

      const { data: jobs, error: jobsErr } = await admin
        .from('sample_redaction_jobs').select('id, version, workflow_run_id').eq('call_id', callId);
      if (jobsErr) return json({ error: jobsErr.message, error_code: 'DB' }, 500);
      if (!jobs?.length) return json({ error: 'no samples for this call', error_code: 'NOT_FOUND' }, 404);

      // 2. the worker: cancel runs, wait for them to stop, delete vendor transcripts, schedule a late re-purge
      const w = await callWorker('/api/delete', {
        job_ids: jobs.map((j) => j.id),
        run_ids: jobs.map((j) => j.workflow_run_id).filter(Boolean),
        transcript_ids: [],   // re-read after the runs stopped:
      }, DELETE_BUDGET_MS);
      // ids recorded while runs were stopping are only visible now
      const { data: ids } = await admin.from('sample_redaction_jobs').select('asr_transcript_ids').eq('call_id', callId);
      const transcriptIds = (ids ?? []).flatMap((r) => r.asr_transcript_ids ?? []);
      const w2 = transcriptIds.length ? await callWorker('/api/delete', { job_ids: [], run_ids: [], transcript_ids: transcriptIds }, DELETE_BUDGET_MS) : { ok: true, detail: undefined };
      const vendor = { ok: w.ok && w2.ok, detail: w.detail ?? w2.detail ?? null };

      // 3. TR copies: every version's artifacts and every job's scratch
      const removed: Record<string, number> = { 'sample-library': 0, 'sample-work': 0 };
      try {
        for (const j of jobs) {
          removed['sample-library'] += await purge('sample-library', `${callId}/v${j.version}`);
          removed['sample-work'] += await purge('sample-work', j.id);
        }
      } catch (e) {
        return json({ error: `storage purge failed: ${e instanceof Error ? e.message : String(e)}`, error_code: 'STORAGE', removed }, 500);
      }

      // 4. rows stay as the take-down record; the gate keeps a deleted sample withdrawn forever
      await admin.from('sample_library').update({ status: 'withdrawn', deleted_at: nowIso }).eq('call_id', callId).is('deleted_at', null);
      if (vendor.ok) {
        await admin.from('sample_redaction_jobs').update({ deleted_at: nowIso, updated_at: nowIso }).eq('call_id', callId).is('deleted_at', null);
      }
      const { error: logErr } = await admin.from('security_activity_log').insert({
        event_type: 'sample_library_deleted',
        user_id: userId,
        portal: 'admin',
        metadata: { call_id: callId, jobs: jobs.length, removed, vendor_purged: vendor.ok, vendor_detail: vendor.detail },
      });
      if (logErr) console.error('[sample-library-admin] delete log failed:', logErr.message);
      // Not fully done until the vendor copy is gone: the action is idempotent, so the UI offers it again.
      return json({ ok: vendor.ok, removed, vendor_purged: vendor.ok, vendor_detail: vendor.detail }, vendor.ok ? 200 : 207);
    }

    default:
      return json({ error: `unknown action ${action}`, error_code: 'BAD_ACTION' }, 400);
  }
});
