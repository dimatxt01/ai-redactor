// sample-redaction-bridge — the ONLY door the ai-redactor worker (separate repo; a background
// process that polls this function) has into TR. The worker holds no Supabase key: every read,
// status write and storage URL goes through here, scoped to ONE job.
//
// TR_PLAN RL-3 (Dmitry 2026-10-13: the bridge replaces the signed callback).
// Auth: X-TR-Signature HMAC with SAMPLE_REDACTOR_BRIDGE_SECRET (_shared/sampleSignature.ts);
// a missing secret rejects. Every action names a job_id and can only touch that
// job's row, its sample-src/<job_id>/ scratch prefix and its training-library/<job_id>/
// artifact prefix (RL-1 buckets; paths carry the job id, never calls.id, because agents
// can read published training_library_calls rows).
//
// Pull model: TR never calls the worker. The worker (a plain Node process) calls `poll` every ~20 s:
// it gets queued jobs to claim, refreshes the heartbeat of the jobs it runs, learns which of them to stop
// (takedown / failed elsewhere), and gets the jobs whose AssemblyAI copies still need deleting.
//
// Exactly-once: the first worker run to `claim` a queued job owns it
// (compare-and-swap on status + workflow_run_id). Every later action must carry
// that run_id, so two workers polling at once, a retried request, or a
// repeated `complete` / `fail` cannot act twice.
//
// Liveness: the owning run's polls keep heartbeat_at fresh. A running job whose heartbeat is older than
// SAMPLE_WORKER_STALE_S (default 300) is failed here (`internal: worker stopped responding`), its copies
// purged, and its vendor transcripts handed to the next poll's cleanup list.
//
// Takedown: once training-library-admin's delete sets delete_requested_at, every
// action except `purge`, `asr` (records ids for deletion) and `vendor_purged` refuses the job.
// The job becomes 'deleted' when the worker reports its vendor copies gone (`vendor_purged`).
//
// Caps: SAMPLE_JOB_CAP_USD (default 2) per job; SAMPLE_MONTH_CAP_USD (default 100)
// per UTC month over public.sample_month_committed_usd() (running jobs count their
// reservation). `claim` and `cost` both enforce the month.
//
// Never writes calls/agents. Never returns a Supabase key. Audio bytes never
// pass through this function (150MB worker): the worker moves files with the
// signed URLs it gets here. Error text it stores is never transcript content.
//
// `complete` hands everything to public.sample_library_ingest: job -> done plus the RL-1
// training_library_calls / _call_sources / _clips rows, in one transaction, idempotent per job.
//
// Actions: poll (no job_id) | job | claim | source | sign | status | cost | asr | complete | fail | purge | vendor_purged

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifySampleSignature } from '../_shared/sampleSignature.ts';
import { freshTelnyxRecordingUrl, isTelnyxRecordingUrl } from '../_shared/telnyxRecording.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TERMINAL = new Set(['done', 'failed', 'deleted']);
const ORDER = ['queued', 'fetching', 'transcribing', 'redacting', 'verifying', 'done'];
const ERROR_CODES = new Set(['fetch_expired', 'bad_audio', 'asr_failed', 'timeout', 'unsupported_source', 'cost_cap', 'internal']);
const NAME_RE = /^(clips\/)?[a-z0-9][a-z0-9_.-]{0,63}$/;
const SRC = 'sample-src';         // RL-1 bucket: scratch, deleted when the job ends
const LIB = 'training-library';   // RL-1 bucket: artifacts
const JOB_DEADLINE_MS = 2 * 60 * 60 * 1000;   // a job running over 2h is failed:timeout
const UPLOAD_TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', json: 'application/json', txt: 'text/plain' };
const ARTIFACTS = ['redacted_audio', 'transcript_json', 'transcript_txt', 'pii_spans_json', 'clips_json', 'coaching_json'];
const REQUIRED = ['redacted_audio', 'transcript_json', 'pii_spans_json', 'clips_json', 'coaching_json'];

type Job = {
  id: string; call_id: string; version: number; idempotency_key: string; status: string; options: Record<string, unknown>;
  call_meta: Record<string, unknown>; created_at: string; workflow_run_id: string | null; cost_usd: number;
  asr_transcript_ids: string[]; delete_requested_at: string | null; metrics: Record<string, unknown>; heartbeat_at: string | null;
};

const numEnv = (k: string, d: number) => {
  const v = Number(Deno.env.get(k));
  return Number.isFinite(v) && v > 0 ? v : d;
};

function nameParts(full: string | null | undefined): string[] {
  return String(full ?? '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/[^\p{L}'-]/gu, ''))
    .filter((s) => s.length >= 2);
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'method not allowed', error_code: 'METHOD' }, 405);
  const raw = await req.text();

  const sig = await verifySampleSignature(Deno.env.get('SAMPLE_REDACTOR_BRIDGE_SECRET'), req.headers.get('x-tr-signature'), raw);
  if (!sig.ok) {
    // console only: an unauthenticated caller must not be able to grow a table
    console.error('[sample-redaction-bridge] signature rejected:', sig.reason);
    return json({ error: 'unauthorized', error_code: 'BAD_SIGNATURE' }, 401);
  }
  const supabase = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

  let body: Record<string, any>;
  try { body = JSON.parse(raw); } catch { return json({ error: 'bad json', error_code: 'BAD_JSON' }, 400); }
  const action = String(body.action ?? '');
  const staleMs = numEnv('SAMPLE_WORKER_STALE_S', 300) * 1000;

  const removePrefixOf = async (bucket: string, prefix: string) => {
    for (const p of [prefix, `${prefix}/clips`]) {
      const { data: files } = await supabase.storage.from(bucket).list(p, { limit: 1000 });
      const names = (files ?? []).filter((f) => f.id).map((f) => `${p}/${f.name}`);   // folders have no id
      if (!names.length) continue;
      const { error } = await supabase.storage.from(bucket).remove(names);
      if (error) console.error('[sample-redaction-bridge] cleanup failed:', bucket, prefix, error.message);
    }
  };

  // ── poll: the worker's only way to learn about work (no job_id) ──────────
  if (action === 'poll') {
    const nowIso = new Date().toISOString();
    const staleCut = new Date(Date.now() - staleMs).toISOString();
    const running = (Array.isArray(body.running) ? body.running : []).slice(0, 20)
      .filter((r: any) => /^[0-9a-f-]{36}$/i.test(String(r?.job_id)) && /^[A-Za-z0-9_-]{4,100}$/.test(String(r?.run_id)));
    const capacity = Math.max(0, Math.min(10, Math.floor(Number(body.capacity) || 0)));

    // 1. heartbeats of the jobs this worker runs; stop the ones taken down or failed elsewhere
    const stop: string[] = [];
    for (const r of running) {
      const { data: hb, error } = await supabase.from('sample_redaction_jobs').update({ heartbeat_at: nowIso })
        .eq('id', r.job_id).eq('workflow_run_id', r.run_id).select('status, delete_requested_at').maybeSingle();
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      if (!hb || hb.delete_requested_at || hb.status === 'failed' || hb.status === 'deleted') stop.push(r.job_id);
    }

    // 2. running jobs whose worker went quiet: fail them and purge what they left in TR storage
    const { data: lost, error: lostErr } = await supabase.from('sample_redaction_jobs').update({
      status: 'failed', error_code: 'internal', error_detail: 'worker stopped responding', completed_at: nowIso,
    }).not('status', 'in', '(queued,done,failed,deleted)').lt('heartbeat_at', staleCut).select('id');
    if (lostErr) return json({ error: lostErr.message, error_code: 'DB' }, 500);
    for (const j of lost ?? []) { await removePrefixOf(SRC, j.id); await removePrefixOf(LIB, j.id); }

    // 3. cleanup: vendor copies still to delete, or a takedown waiting for the worker; no live run owns them
    const quiet = `heartbeat_at.is.null,heartbeat_at.lt.${staleCut}`;
    const [{ data: takedowns }, { data: leftovers }] = await Promise.all([
      supabase.from('sample_redaction_jobs').select('id, asr_transcript_ids')
        .not('delete_requested_at', 'is', null).neq('status', 'deleted').in('status', ['done', 'failed']).or(quiet).limit(25),
      supabase.from('sample_redaction_jobs').select('id, asr_transcript_ids')
        .in('status', ['done', 'failed']).neq('asr_transcript_ids', '{}').or(quiet).limit(25),
    ]);
    const cleanup = new Map<string, string[]>();
    for (const j of [...(takedowns ?? []), ...(leftovers ?? [])]) cleanup.set(j.id, j.asr_transcript_ids ?? []);

    // 4. queued jobs to claim, oldest first, inside the 2 h window
    let jobs: { job_id: string; idempotency_key: string }[] = [];
    if (capacity > 0) {
      const { data: q, error: qErr } = await supabase.from('sample_redaction_jobs').select('id, idempotency_key')
        .eq('status', 'queued').is('delete_requested_at', null)
        .gte('created_at', new Date(Date.now() - JOB_DEADLINE_MS).toISOString())
        .order('created_at', { ascending: true }).limit(capacity);
      if (qErr) return json({ error: qErr.message, error_code: 'DB' }, 500);
      jobs = (q ?? []).map((j) => ({ job_id: j.id, idempotency_key: j.idempotency_key }));
    }
    return json({
      jobs, stop, lost: (lost ?? []).length,
      cleanup: [...cleanup].map(([job_id, transcript_ids]) => ({ job_id, transcript_ids })),
    });
  }

  const jobId = String(body.job_id ?? '');
  const runId = typeof body.run_id === 'string' ? body.run_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: 'job_id required', error_code: 'BAD_JOB_ID' }, 400);

  const { data: job, error: jobErr } = await supabase
    .from('sample_redaction_jobs')
    .select('id, call_id, version, idempotency_key, status, options, call_meta, created_at, workflow_run_id, cost_usd, asr_transcript_ids, delete_requested_at, metrics, heartbeat_at')
    .eq('id', jobId)
    .maybeSingle<Job>();
  if (jobErr) return json({ error: jobErr.message, error_code: 'DB' }, 500);
  if (!job) return json({ error: 'no such job', error_code: 'NO_JOB' }, 404);

  const prefix = job.id;   // same prefix in both buckets
  const jobCap = numEnv('SAMPLE_JOB_CAP_USD', 2);
  const monthCap = numEnv('SAMPLE_MONTH_CAP_USD', 100);
  const tombstoned = !!job.delete_requested_at;

  const removePrefix = (bucket: string) => removePrefixOf(bucket, prefix);
  const logEvent = async (event_type: string, metadata: Record<string, unknown>) => {
    const { error } = await supabase.from('security_activity_log').insert({ event_type, metadata });
    if (error) console.error('[sample-redaction-bridge] log failed:', event_type, error.message);
  };
  const monthCommitted = async (): Promise<number | null> => {
    const { data, error } = await supabase.rpc('sample_month_committed_usd');
    if (error) { console.error('[sample-redaction-bridge] month spend read failed:', error.message); return null; }
    return Number(data ?? 0);
  };

  // ── purge: delayed / post-failure cleanup (worker purgeLater, stopped runs) ──
  // Never touches a live job. Scratch always goes; artifacts go for failed or deleted jobs.
  if (action === 'purge') {
    if (!TERMINAL.has(job.status) && !tombstoned) return json({ error: 'job still running', error_code: 'JOB_LIVE' }, 409);
    await removePrefix(SRC);
    // artifacts go for failed or taken-down jobs (training-library-admin's delete already emptied the library rows)
    if (job.status === 'failed' || job.status === 'deleted' || tombstoned) await removePrefix(LIB);
    return json({ ok: true, asr_transcript_ids: job.asr_transcript_ids ?? [] });
  }

  // ── asr: record a vendor transcript id even if the job just ended, so it can be purged ──
  if (action === 'asr') {
    if (!runId || job.workflow_run_id !== runId) return json({ error: 'run does not own this job', error_code: 'DUPLICATE_RUN' }, 409);
    const tid = String(body.transcript_id ?? '');
    if (!/^[A-Za-z0-9_-]{6,80}$/.test(tid)) return json({ error: 'bad transcript_id', error_code: 'BAD_INPUT' }, 400);
    if (!job.asr_transcript_ids?.includes(tid)) {
      const { error } = await supabase.from('sample_redaction_jobs')
        .update({ asr_transcript_ids: [...(job.asr_transcript_ids ?? []), tid].slice(-100) }).eq('id', job.id);
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
    }
    return json({ ok: true });
  }

  // ── vendor_purged: the worker deleted these AssemblyAI transcripts; a run that ended reports here last ──
  // From the owning run (it has stopped), or from any worker once no live run owns the job (heartbeat stale).
  // A takedown completes here: once no vendor copy is left, TR storage is purged again and the job is 'deleted'.
  if (action === 'vendor_purged') {
    const owner = !!runId && job.workflow_run_id === runId;
    const quiet = !job.heartbeat_at || Date.now() - new Date(job.heartbeat_at).getTime() > staleMs;
    if (!owner && !(quiet && TERMINAL.has(job.status))) return json({ error: 'a live run owns this job', error_code: 'RUN_LIVE' }, 409);
    const gone = new Set((Array.isArray(body.transcript_ids) ? body.transcript_ids : []).map(String));
    const left = (job.asr_transcript_ids ?? []).filter((t) => !gone.has(t));
    const patch: Record<string, unknown> = { asr_transcript_ids: left };
    if (owner) patch.heartbeat_at = null;   // the run has ended
    const finish = tombstoned && left.length === 0 && TERMINAL.has(job.status);
    if (finish) {
      await removePrefix(SRC);
      await removePrefix(LIB);
      Object.assign(patch, { status: 'deleted', deleted_at: new Date().toISOString(), heartbeat_at: null });
    }
    const { error } = await supabase.from('sample_redaction_jobs').update(patch).eq('id', job.id);
    if (error) return json({ error: error.message, error_code: 'DB' }, 500);
    return json({ ok: true, left: left.length, deleted: finish });
  }

  if (tombstoned) return json({ error: 'sample was deleted', error_code: 'JOB_TERMINAL', status: job.status }, 409);

  // ── terminal jobs only answer idempotent repeats ──────────────────────────
  // complete on a done job falls through to re-ensure the library row (the first attempt may have died mid-way).
  if (TERMINAL.has(job.status)) {
    if (action === 'fail' && job.status === 'failed') return json({ ok: true, already: true });
    if (!(action === 'complete' && job.status === 'done' && job.workflow_run_id === runId)) {
      return json({ error: `job is ${job.status}`, error_code: 'JOB_TERMINAL', status: job.status }, 409);
    }
  }

  // ── read-only: the job's inputs ───────────────────────────────────────────
  if (action === 'job') {
    // Names to bleep come from TR rows at read time; they are never stored on the job.
    const { data: call } = await supabase.from('calls').select('agent_id, caller_name').eq('id', job.call_id).maybeSingle();
    let agentName: string | null = null;
    if (call?.agent_id) {
      const { data: agent } = await supabase.from('agents').select('full_name').eq('id', call.agent_id).maybeSingle();
      agentName = agent?.full_name ?? null;
    }
    const adminTerms = Array.isArray(job.options?.extra_terms) ? (job.options.extra_terms as unknown[]).map(String) : [];
    const extra_terms = [...new Set([
      ...nameParts(agentName),
      ...nameParts(call?.caller_name),
      ...adminTerms.map((t) => t.trim()).filter(Boolean),
    ])].slice(0, 200);
    return json({
      job: {
        id: job.id, call_id: job.call_id, version: job.version, status: job.status, options: job.options,
        call_meta: job.call_meta, created_at: job.created_at, workflow_run_id: job.workflow_run_id,
      },
      extra_terms,
      idempotency_key: job.idempotency_key,
      caps: { job_usd: jobCap, month_usd: monthCap, spent_usd: Number(job.cost_usd ?? 0), asr_usd_per_hour: numEnv('SAMPLE_ASR_USD_PER_HOUR', 0.45) },
    });
  }

  // ── run ownership ─────────────────────────────────────────────────────────
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(runId)) return json({ error: 'run_id required', error_code: 'BAD_RUN_ID' }, 400);
  if (action === 'claim') {
    // the start request's key must be this job's key (a signed start for job A cannot carry job B's key)
    if (body.idempotency_key !== undefined && body.idempotency_key !== job.idempotency_key) {
      return json({ error: 'idempotency_key does not match the job', error_code: 'KEY_MISMATCH' }, 409);
    }
    if (job.status !== 'queued') {
      return job.workflow_run_id === runId
        ? json({ ok: true, replay: true })
        : json({ error: 'job already owned by another run', error_code: 'DUPLICATE_RUN' }, 409);
    }
    const committed = await monthCommitted();
    if (committed === null) return json({ error: 'month spend unreadable', error_code: 'DB' }, 500);
    if (committed > monthCap) {
      // refuse AND end the job here, so a refused run never needs to own the job to fail it
      await supabase.from('sample_redaction_jobs').update({
        status: 'failed', error_code: 'cost_cap', error_detail: `month committed $${committed.toFixed(2)} > cap $${monthCap}`,
        completed_at: new Date().toISOString(),
      }).eq('id', job.id).eq('status', 'queued');
      await logEvent('sample_cost_cap_blocked', { where: 'claim', job_id: job.id, spent_usd: committed, month_cap_usd: monthCap });
      return json({ error: 'month cap reached', error_code: 'JOB_TERMINAL', status: 'failed' }, 409);
    }
    const nowIso = new Date().toISOString();
    const { data: claimed, error } = await supabase.from('sample_redaction_jobs')
      .update({ status: 'fetching', workflow_run_id: runId, started_at: nowIso, heartbeat_at: nowIso })
      .eq('id', job.id).eq('status', 'queued')
      .or(`workflow_run_id.is.null,workflow_run_id.eq.${runId}`)
      .select('id').maybeSingle();
    if (error) return json({ error: error.message, error_code: 'DB' }, 500);
    if (!claimed) return json({ error: 'job already owned by another run', error_code: 'DUPLICATE_RUN' }, 409);
    return json({ ok: true, month_committed_usd: committed });
  }
  if (job.workflow_run_id !== runId) {
    return json({ error: 'run does not own this job', error_code: 'DUPLICATE_RUN' }, 409);
  }

  if (!TERMINAL.has(job.status) && Date.now() - new Date(job.created_at).getTime() > JOB_DEADLINE_MS && action !== 'fail') {
    await supabase.from('sample_redaction_jobs').update({
      status: 'failed', error_code: 'timeout', error_detail: 'job exceeded 2h', completed_at: new Date().toISOString(),
    }).eq('id', job.id).not('status', 'in', '(done,failed,deleted)');
    await removePrefix(SRC);
    await removePrefix(LIB);
    return json({ error: 'job exceeded 2h', error_code: 'JOB_TERMINAL', status: 'failed' }, 409);
  }

  switch (action) {
    case 'source': {
      const { data: call } = await supabase
        .from('calls')
        .select('recording_url, telnyx_call_control_id')
        .eq('id', job.call_id)
        .maybeSingle();
      const stored = String(call?.recording_url ?? '');
      if (!stored) return json({ error: 'call has no recording', error_code: 'unsupported_source' }, 422);
      if (!isTelnyxRecordingUrl(stored)) {
        return json({ error: 'only Telnyx recordings are supported in v1', error_code: 'unsupported_source' }, 422);
      }
      try {
        const url = await freshTelnyxRecordingUrl(stored, call?.telnyx_call_control_id ?? null);
        if (!url) return json({ error: 'Telnyx no longer has this recording', error_code: 'fetch_expired' }, 422);
        return json({ url, expires_in_s: 600 });
      } catch (e) {
        console.error('[sample-redaction-bridge] telnyx lookup failed:', job.id, e instanceof Error ? e.message : 'error');
        return json({ error: 'telnyx lookup failed', error_code: 'internal' }, 502);
      }
    }

    case 'sign': {
      const ops = Array.isArray(body.ops) ? body.ops.slice(0, 12) : [];
      const out: Record<string, { url: string; path: string }> = {};
      for (const op of ops) {
        const name = String(op?.name ?? '');
        const target = op?.target === 'library' ? 'library' : op?.target === 'work' ? 'work' : null;
        const mode = op?.mode === 'upload' ? 'upload' : op?.mode === 'download' ? 'download' : null;
        if (!target || !mode || !NAME_RE.test(name) || !UPLOAD_TYPES[name.split('.').pop() ?? '']) {
          return json({ error: `bad sign op ${JSON.stringify(op)}`, error_code: 'BAD_OP' }, 400);
        }
        if (target === 'work' && name.startsWith('clips/')) return json({ error: 'clips live in the library', error_code: 'BAD_OP' }, 400);
        const bucket = target === 'work' ? SRC : LIB;
        const path = `${prefix}/${name}`;
        if (mode === 'upload') {
          const { data, error } = await supabase.storage.from(bucket).createSignedUploadUrl(path, { upsert: true });
          if (error || !data) return json({ error: error?.message ?? 'sign failed', error_code: 'STORAGE' }, 500);
          out[`${target}:${name}:upload`] = { url: data.signedUrl, path };
        } else {
          const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 3600);
          if (error || !data) return json({ error: error?.message ?? 'sign failed', error_code: 'STORAGE' }, 500);
          out[`${target}:${name}:download`] = { url: data.signedUrl, path };
        }
      }
      return json({ urls: out });
    }

    case 'status': {
      const next = String(body.status ?? '');
      const from = ORDER.indexOf(job.status);
      const to = ORDER.indexOf(next);
      if (to < 2 || next === 'done') return json({ error: 'bad status', error_code: 'BAD_STATUS' }, 400);
      if (to <= from) return json({ ok: true, ignored: 'not forward' });   // a replayed step re-announcing a stage
      const patch: Record<string, unknown> = { status: next };
      if (body.engine && typeof body.engine === 'object') patch.engine = body.engine;
      const { error } = await supabase.from('sample_redaction_jobs').update(patch).eq('id', job.id).eq('status', job.status);
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      return json({ ok: true });
    }

    case 'cost': {
      // Idempotent per item: a replayed step re-posting the same item is a no-op.
      const add = Number(body.add_usd);
      const item = String(body.item ?? '').slice(0, 80);
      if (!Number.isFinite(add) || add < 0 || add > 50 || !item) return json({ error: 'bad cost', error_code: 'BAD_COST' }, 400);
      const ledger = (job.metrics as any)?.cost_items ?? {};
      let spent = Number(job.cost_usd ?? 0);
      if (ledger[item] === undefined) {
        spent += add;
        const { data: wrote, error } = await supabase.from('sample_redaction_jobs').update({
          cost_usd: Math.round(spent * 10000) / 10000,
          metrics: { ...(job.metrics ?? {}), cost_items: { ...ledger, [item]: add } },
        }).eq('id', job.id).eq('cost_usd', job.cost_usd ?? 0).select('id');
        if (error) return json({ error: error.message, error_code: 'DB' }, 500);
        if (!wrote?.length) return json({ error: 'cost ledger moved; retry', error_code: 'RETRY' }, 409);
      }
      const committed = await monthCommitted();
      const overMonth = committed !== null && committed > monthCap;
      if (overMonth) await logEvent('sample_cost_cap_blocked', { where: 'cost', job_id: job.id, spent_usd: committed, month_cap_usd: monthCap });
      return json({ ok: true, spent_usd: spent, job_cap_usd: jobCap, over_cap: spent > jobCap || overMonth, over_month: overMonth });
    }

    case 'complete': {
      const a = body.artifacts ?? {};
      for (const k of REQUIRED) {
        if (!a[k]?.name) return json({ error: `artifact ${k} missing`, error_code: 'BAD_ARTIFACTS' }, 400);
      }
      for (const k of Object.keys(a)) {
        if (!ARTIFACTS.includes(k)) return json({ error: `unknown artifact ${k}`, error_code: 'BAD_ARTIFACTS' }, 400);
        if (!/^[0-9a-f]{64}$/.test(String(a[k]?.sha256 ?? ''))) return json({ error: `artifact ${k} sha256 missing`, error_code: 'BAD_ARTIFACTS' }, 400);
      }
      const pipelineVersion = String(body.pipeline_version ?? '');
      if (!/^sr-\d+\.\d+\.\d+$/.test(pipelineVersion)) return json({ error: 'pipeline_version required', error_code: 'BAD_VERSION' }, 400);
      const schemaVersion = String(body.schema_version ?? '');
      if (!/^\d+\.\d+$/.test(schemaVersion)) return json({ error: 'schema_version required', error_code: 'BAD_VERSION' }, 400);
      const clips = Array.isArray(body.clips) ? body.clips : [];
      if (clips.length > 6) return json({ error: 'at most 6 clips', error_code: 'BAD_ARTIFACTS' }, 400);

      // Every named file must actually be in this job's library prefix.
      const present = new Set<string>();
      for (const p of [prefix, `${prefix}/clips`]) {
        const { data: files, error: listErr } = await supabase.storage.from(LIB).list(p, { limit: 200 });
        if (listErr) return json({ error: listErr.message, error_code: 'STORAGE' }, 500);
        for (const f of files ?? []) if (f.id) present.add(`${p}/${f.name}`);
      }
      for (const k of Object.keys(a)) {
        if (!present.has(`${prefix}/${a[k].name}`)) return json({ error: `artifact ${k} not uploaded`, error_code: 'BAD_ARTIFACTS' }, 400);
      }
      const clipRows = [];
      for (const [n, c] of clips.entries()) {
        const exported = c?.audio_exported === true;
        const name = String(c?.audio?.name ?? '');
        if (exported && (!/^clips\/c\d{1,2}\.mp3$/.test(name) || !present.has(`${prefix}/${name}`) || !/^[0-9a-f]{64}$/.test(String(c?.audio?.sha256 ?? '')))) {
          return json({ error: `clip ${n} audio not uploaded`, error_code: 'BAD_ARTIFACTS' }, 400);
        }
        clipRows.push({
          clip_key: String(c?.clip_id ?? `c${n + 1}`).slice(0, 8),
          label: String(c?.label ?? ''),
          sub_label: c?.sub_label ? String(c.sub_label).slice(0, 40) : null,
          start_ms: Math.max(0, Math.round(Number(c?.start_ms))),
          end_ms: Math.round(Number(c?.end_ms)),
          audio_exported: exported,
          audio_path: exported ? `${prefix}/${name}` : null,
          audio_sha256: exported ? String(c.audio.sha256) : null,
          title: c?.title ? String(c.title).slice(0, 200) : null,
          coaching: c?.coaching && typeof c.coaching === 'object' ? c.coaching : {},
          confidence: Number.isFinite(Number(c?.confidence)) ? Math.min(1, Math.max(0, Number(c.confidence))) : null,
          sort_order: n,
        });
      }

      const { data: r, error: ingErr } = await supabase.rpc('sample_library_ingest', {
        p_job_id: job.id,
        p_run_id: runId,
        p_payload: {
          qa_flag: body.qa_flag !== false,
          qa_reasons: Array.isArray(body.qa_reasons) ? body.qa_reasons.slice(0, 200).map(String) : [],
          metrics: body.metrics && typeof body.metrics === 'object' ? body.metrics : {},
          engine: body.engine && typeof body.engine === 'object' ? body.engine : {},
          pipeline_version: pipelineVersion,
          schema_version: schemaVersion,
          audio: { path: `${prefix}/${a.redacted_audio.name}`, sha256: a.redacted_audio.sha256 },
          coaching: body.coaching && typeof body.coaching === 'object' ? body.coaching : {},
          clips: clipRows,
        },
      });
      if (ingErr) return json({ error: ingErr.message, error_code: 'DB' }, 500);
      if (!r?.ok) {
        if (r?.reason === 'not_owner') return json({ error: 'run does not own this job', error_code: 'DUPLICATE_RUN' }, 409);
        return json({ error: `job ${r?.reason ?? 'refused'}`, error_code: 'JOB_TERMINAL' }, 409);
      }
      await removePrefix(SRC);   // TR scratch copies deleted when the job finishes
      return json({ ok: true, library_call_id: r.library_call_id, replay: !!r.replay });
    }

    case 'fail': {
      const code = ERROR_CODES.has(String(body.error_code)) ? String(body.error_code) : 'internal';
      const { error } = await supabase.from('sample_redaction_jobs').update({
        status: 'failed',
        error_code: code,
        error_detail: String(body.error_detail ?? '').slice(0, 500),
        engine: body.engine && typeof body.engine === 'object' ? body.engine : undefined,
        pipeline_version: typeof body.pipeline_version === 'string' ? body.pipeline_version : undefined,
        completed_at: new Date().toISOString(),
      }).eq('id', job.id).not('status', 'in', '(done,failed,deleted)');
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      // A failed run leaves nothing behind: scratch AND any partial artifacts.
      await removePrefix(SRC);
      await removePrefix(LIB);
      return json({ ok: true });
    }

    default:
      return json({ error: `unknown action ${action}`, error_code: 'BAD_ACTION' }, 400);
  }
});
