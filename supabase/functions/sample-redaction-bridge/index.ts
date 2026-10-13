// sample-redaction-bridge — the ONLY door the sample-redactor worker (separate
// Vercel project) has into TR. The worker holds no Supabase key: every read,
// status write and storage URL goes through here, scoped to ONE job.
//
// Auth: X-TR-Signature HMAC with SAMPLE_REDACTOR_BRIDGE_SECRET (_shared/sampleSignature.ts);
// a missing secret rejects. Every action names a job_id and can only touch that
// job's row, its sample-work/<job_id>/ scratch prefix and its
// sample-library/<call_id>/v<version>/ artifact prefix.
//
// Exactly-once: the first workflow run to `claim` a queued job owns it
// (compare-and-swap on status + workflow_run_id). Every later action must carry
// that run_id, so a duplicate start, a replayed step from a stale run, or a
// repeated `complete` / `fail` cannot act twice.
//
// Takedown: once sample-library-admin's delete sets delete_requested_at, every
// action except `purge` (and `asr`, which only records ids for deletion) refuses the job.
//
// Caps: SAMPLE_JOB_CAP_USD (default 2) per job; SAMPLE_MONTH_CAP_USD (default 100)
// per UTC month over public.sample_month_committed_usd() (running jobs count their
// reservation). `claim` and `cost` both enforce the month.
//
// Never writes calls/agents. Never returns a Supabase key. Audio bytes never
// pass through this function (150MB worker): the worker moves files with the
// signed URLs it gets here. Error text it stores is never transcript content.
//
// Actions: job | claim | source | sign | status | cost | asr | complete | fail | purge

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { verifySampleSignature } from '../_shared/sampleSignature.ts';
import { freshTelnyxRecordingUrl, isTelnyxRecordingUrl } from '../_shared/telnyxRecording.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const TERMINAL = new Set(['done', 'failed']);
const ORDER = ['queued', 'fetching', 'transcribing', 'redacting', 'verifying', 'done'];
const ERROR_CODES = new Set(['fetch_expired', 'bad_audio', 'asr_failed', 'timeout', 'unsupported_source', 'cost_cap', 'internal']);
const NAME_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const JOB_DEADLINE_MS = 2 * 60 * 60 * 1000;   // a job running over 2h is failed:timeout
const UPLOAD_TYPES: Record<string, string> = { mp3: 'audio/mpeg', wav: 'audio/wav', json: 'application/json', txt: 'text/plain' };
const ARTIFACTS = ['redacted_audio', 'highlight_audio', 'transcript_json', 'transcript_txt', 'pii_spans_json', 'labels_json', 'coaching_json'];

type Job = {
  id: string; call_id: string; version: number; status: string; options: Record<string, unknown>;
  call_meta: Record<string, unknown>; created_at: string; workflow_run_id: string | null; cost_usd: number;
  asr_transcript_ids: string[]; delete_requested_at: string | null; metrics: Record<string, unknown>;
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
  const jobId = String(body.job_id ?? '');
  const runId = typeof body.run_id === 'string' ? body.run_id : '';
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return json({ error: 'job_id required', error_code: 'BAD_JOB_ID' }, 400);

  const { data: job, error: jobErr } = await supabase
    .from('sample_redaction_jobs')
    .select('id, call_id, version, status, options, call_meta, created_at, workflow_run_id, cost_usd, asr_transcript_ids, delete_requested_at, metrics')
    .eq('id', jobId)
    .maybeSingle<Job>();
  if (jobErr) return json({ error: jobErr.message, error_code: 'DB' }, 500);
  if (!job) return json({ error: 'no such job', error_code: 'NO_JOB' }, 404);

  const workPrefix = `${job.id}`;
  const libPrefix = `${job.call_id}/v${job.version}`;
  const jobCap = numEnv('SAMPLE_JOB_CAP_USD', 2);
  const monthCap = numEnv('SAMPLE_MONTH_CAP_USD', 100);
  const tombstoned = !!job.delete_requested_at;

  const removePrefix = async (bucket: string, prefix: string) => {
    const { data: files } = await supabase.storage.from(bucket).list(prefix, { limit: 1000 });
    if (files?.length) {
      const { error } = await supabase.storage.from(bucket).remove(files.map((f) => `${prefix}/${f.name}`));
      if (error) console.error('[sample-redaction-bridge] cleanup failed:', bucket, job.id, error.message);
    }
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
    await removePrefix('sample-work', workPrefix);
    if (job.status === 'failed' || tombstoned) await removePrefix('sample-library', libPrefix);
    if (tombstoned) {
      await supabase.from('sample_library').update({ status: 'withdrawn', deleted_at: new Date().toISOString() })
        .eq('job_id', job.id).is('deleted_at', null);
    }
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
      caps: { job_usd: jobCap, month_usd: monthCap, spent_usd: Number(job.cost_usd ?? 0), asr_usd_per_hour: numEnv('SAMPLE_ASR_USD_PER_HOUR', 0.45) },
    });
  }

  // ── run ownership ─────────────────────────────────────────────────────────
  if (!/^[A-Za-z0-9_-]{4,100}$/.test(runId)) return json({ error: 'run_id required', error_code: 'BAD_RUN_ID' }, 400);
  if (action === 'claim') {
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
        completed_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }).eq('id', job.id).eq('status', 'queued');
      return json({ error: 'month cap reached', error_code: 'JOB_TERMINAL', status: 'failed' }, 409);
    }
    const nowIso = new Date().toISOString();
    const { data: claimed, error } = await supabase.from('sample_redaction_jobs')
      .update({ status: 'fetching', workflow_run_id: runId, started_at: nowIso, updated_at: nowIso })
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
      updated_at: new Date().toISOString(),
    }).eq('id', job.id).not('status', 'in', '(done,failed)');
    await removePrefix('sample-work', workPrefix);
    await removePrefix('sample-library', libPrefix);
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
        const bucket = target === 'work' ? 'sample-work' : 'sample-library';
        const path = `${target === 'work' ? workPrefix : libPrefix}/${name}`;
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
      const patch: Record<string, unknown> = { status: next, updated_at: new Date().toISOString() };
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
          updated_at: new Date().toISOString(),
        }).eq('id', job.id).eq('cost_usd', job.cost_usd ?? 0).select('id');
        if (error) return json({ error: error.message, error_code: 'DB' }, 500);
        if (!wrote?.length) return json({ error: 'cost ledger moved; retry', error_code: 'RETRY' }, 409);
      }
      const committed = await monthCommitted();
      const overMonth = committed !== null && committed > monthCap;
      return json({ ok: true, spent_usd: spent, job_cap_usd: jobCap, over_cap: spent > jobCap || overMonth, over_month: overMonth });
    }

    case 'complete': {
      const a = body.artifacts ?? {};
      for (const k of ['redacted_audio', 'transcript_json', 'pii_spans_json']) {
        if (!a[k]?.name) return json({ error: `artifact ${k} missing`, error_code: 'BAD_ARTIFACTS' }, 400);
      }
      for (const k of Object.keys(a)) {
        if (!ARTIFACTS.includes(k)) return json({ error: `unknown artifact ${k}`, error_code: 'BAD_ARTIFACTS' }, 400);
        if (!/^[0-9a-f]{64}$/.test(String(a[k]?.sha256 ?? ''))) return json({ error: `artifact ${k} sha256 missing`, error_code: 'BAD_ARTIFACTS' }, 400);
      }
      const pipelineVersion = String(body.pipeline_version ?? '');
      if (!/^sr-\d+\.\d+\.\d+$/.test(pipelineVersion)) return json({ error: 'pipeline_version required', error_code: 'BAD_VERSION' }, 400);
      // Every named artifact must actually be in this job's library prefix.
      const { data: files, error: listErr } = await supabase.storage.from('sample-library').list(libPrefix, { limit: 100 });
      if (listErr) return json({ error: listErr.message, error_code: 'STORAGE' }, 500);
      const present = new Set((files ?? []).map((f) => f.name));
      for (const k of Object.keys(a)) {
        if (!present.has(String(a[k].name))) return json({ error: `artifact ${k} not uploaded`, error_code: 'BAD_ARTIFACTS' }, 400);
      }
      const qaReasons = Array.isArray(body.qa_reasons) ? body.qa_reasons.slice(0, 200).map(String) : [];
      const nowIso = new Date().toISOString();

      // 1. the job first, guarded: a delete that landed in between wins and no library row is created
      if (job.status !== 'done') {
        const { data: done, error: jobUpdErr } = await supabase.from('sample_redaction_jobs').update({
          status: 'done',
          qa_flag: body.qa_flag !== false,
          qa_reasons: qaReasons,
          metrics: { ...(body.metrics && typeof body.metrics === 'object' ? body.metrics : {}), cost_items: (job.metrics as any)?.cost_items ?? {} },
          engine: body.engine && typeof body.engine === 'object' ? body.engine : {},
          pipeline_version: pipelineVersion,
          completed_at: nowIso,
          updated_at: nowIso,
        }).eq('id', job.id).eq('workflow_run_id', runId).not('status', 'in', '(done,failed)').is('delete_requested_at', null).select('id');
        if (jobUpdErr) return json({ error: jobUpdErr.message, error_code: 'DB' }, 500);
        if (!done?.length) return json({ error: 'job ended or was deleted', error_code: 'JOB_TERMINAL' }, 409);
      }

      // 2. the library row (idempotent on job_id)
      const meta = job.call_meta ?? {};
      const p = (k: string) => (a[k]?.name ? `${libPrefix}/${a[k].name}` : null);
      const h = (k: string) => a[k]?.sha256 ?? null;
      const n = (v: unknown) => (Number.isFinite(Number(v)) && v !== null && v !== undefined ? Number(v) : null);
      const { error: libErr } = await supabase.from('sample_library').upsert({
        call_id: job.call_id,
        job_id: job.id,
        version: job.version,
        agent_ref: String(meta.agent_ref ?? 'agent_unknown'),
        vertical: String(meta.vertical ?? 'final_expense'),
        disposition: meta.disposition ? String(meta.disposition) : null,
        duration_s: n(meta.duration_s),
        redacted_audio_path: p('redacted_audio'),
        redacted_audio_sha256: h('redacted_audio'),
        redacted_audio_bytes: n(a.redacted_audio.bytes),
        highlight_audio_path: p('highlight_audio'),
        highlight_audio_sha256: h('highlight_audio'),
        highlight_start_ms: n(a.highlight_audio?.start_ms),
        highlight_end_ms: n(a.highlight_audio?.end_ms),
        transcript_json_path: p('transcript_json'),
        transcript_json_sha256: h('transcript_json'),
        transcript_txt_path: p('transcript_txt'),
        pii_spans_json_path: p('pii_spans_json'),
        pii_spans_json_sha256: h('pii_spans_json'),
        labels_json_path: p('labels_json'),
        labels_json_sha256: h('labels_json'),
        coaching_json_path: p('coaching_json'),
        coaching_json_sha256: h('coaching_json'),
        pipeline_version: pipelineVersion,
        qa_flag: body.qa_flag !== false,
        qa_reasons: qaReasons,
      }, { onConflict: 'job_id', ignoreDuplicates: true });
      if (libErr) return json({ error: libErr.message, error_code: 'DB' }, 500);

      await removePrefix('sample-work', workPrefix);   // TR scratch copies deleted when the job finishes
      return json({ ok: true });
    }

    case 'fail': {
      const code = ERROR_CODES.has(String(body.error_code)) ? String(body.error_code) : 'internal';
      const nowIso = new Date().toISOString();
      const { error } = await supabase.from('sample_redaction_jobs').update({
        status: 'failed',
        error_code: code,
        error_detail: String(body.error_detail ?? '').slice(0, 500),
        engine: body.engine && typeof body.engine === 'object' ? body.engine : undefined,
        pipeline_version: typeof body.pipeline_version === 'string' ? body.pipeline_version : undefined,
        completed_at: nowIso,
        updated_at: nowIso,
      }).eq('id', job.id).not('status', 'in', '(done,failed)');
      if (error) return json({ error: error.message, error_code: 'DB' }, 500);
      // A failed run leaves nothing behind: scratch AND any partial artifacts of this version.
      await removePrefix('sample-work', workPrefix);
      await removePrefix('sample-library', libPrefix);
      return json({ ok: true });
    }

    default:
      return json({ error: `unknown action ${action}`, error_code: 'BAD_ACTION' }, 400);
  }
});
