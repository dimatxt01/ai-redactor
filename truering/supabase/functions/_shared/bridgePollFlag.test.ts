// deno test --allow-env --allow-read --allow-net=esm.sh supabase/functions/_shared/bridgePollFlag.test.ts
// (needs --allow-env and --allow-net=esm.sh: the bridge reads env at load and imports supabase-js from esm.sh)
// Critic C1 b: with flag recording_library OFF, a signed poll hands out jobs: [] (the queued query is never run),
// while stop and cleanup still work. No network to Supabase: fetch is stubbed with PostgREST-shaped answers.
import { strict as assert } from 'node:assert';
import { signSampleBody } from './sampleSignature.ts';

const SECRET = 'test-secret-not-real';
Deno.env.set('SAMPLE_REDACTOR_BRIDGE_SECRET', SECRET);
Deno.env.set('SUPABASE_URL', 'http://stub.local');
Deno.env.set('SUPABASE_SERVICE_ROLE_KEY', 'stub-key');

const seen: string[] = [];
const patches: string[] = [];
let failCancel = false;
const CLAIM_JOB = { id: '44444444-4444-4444-4444-444444444444', call_id: 'c', version: 1, idempotency_key: 'call:c:v1', status: 'queued',
  options: {}, call_meta: {}, created_at: new Date().toISOString(), workflow_run_id: null, cost_usd: 0, asr_transcript_ids: [], metrics: {}, heartbeat_at: null };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = input instanceof Request ? input : new Request(String(input), init);
  const u = new URL(req.url);
  if (u.host !== 'stub.local') return realFetch(input as Request, init);
  const m = req.method;
  const q = decodeURIComponent(u.search);
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (u.pathname.endsWith('/feature_flags')) { seen.push('flags'); return ok([{ key: 'recording_library', enabled: false, value: {} }]); }
  if (u.pathname.endsWith('/sample_redaction_jobs')) {
    if (m === 'GET' && q.includes('id=eq.44444444')) { seen.push('job'); return ok([CLAIM_JOB]); }
    if (m === 'PATCH' && q.includes('id=eq.44444444') && failCancel) { seen.push('claim-patch-fail'); return new Response(JSON.stringify({ message: 'boom', code: 'XX000' }), { status: 500, headers: { 'content-type': 'application/json' } }); }
    if (m === 'PATCH' && q.includes('id=eq.44444444')) { seen.push(`claim-patch ${req.headers.get('x-test') ?? ''}${q}`); patches.push(await req.text()); return ok([]); }
    if (m === 'PATCH' && q.includes('workflow_run_id=eq.')) { seen.push('heartbeat'); return ok({ status: 'failed' }); }
    if (m === 'PATCH') { seen.push('lost'); return ok([]); }
    if (q.includes('status=in.(done,failed)')) { seen.push('cleanup'); return ok([{ id: '22222222-2222-2222-2222-222222222222', asr_transcript_ids: ['t1'] }]); }
    if (q.includes('status=eq.queued')) { seen.push('queued'); return ok([{ id: '33333333-3333-3333-3333-333333333333', idempotency_key: 'call:x:v1' }]); }
  }
  seen.push(`unexpected ${m} ${u.pathname}${q}`);
  return ok([]);
}) as typeof fetch;

let handler: ((req: Request) => Promise<Response>) | null = null;
(Deno as unknown as { serve: unknown }).serve = (h: (req: Request) => Promise<Response>) => { handler = h; return {}; };
await import('../sample-redaction-bridge/index.ts');
// (lives in _shared so the function dir holds only deployed source)

Deno.test('flag OFF: poll returns jobs [] and never queries queued jobs; stop and cleanup still work', async () => {
  assert.ok(handler, 'handler captured');
  const raw = JSON.stringify({ action: 'poll', worker: 'w1', capacity: 3,
    running: [{ job_id: '11111111-1111-1111-1111-111111111111', run_id: 'wrun_1' }] });
  const res = await handler!(new Request('http://bridge/', {
    method: 'POST', body: raw, headers: { 'x-tr-signature': await signSampleBody(SECRET, raw) } }));
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.jobs, []);
  assert.deepEqual(body.stop, ['11111111-1111-1111-1111-111111111111']);
  assert.deepEqual(body.cleanup, [{ job_id: '22222222-2222-2222-2222-222222222222', transcript_ids: ['t1'] }]);
  assert.ok(seen.includes('flags'), 'flag read');
  assert.ok(!seen.includes('queued'), 'queued jobs must not be queried while OFF');
  assert.ok(!seen.some((s) => s.startsWith('unexpected')), seen.join(' | '));
});

Deno.test('flag OFF: claim of a queued job ends it as cancelled (only while queued) and answers JOB_TERMINAL', async () => {
  const raw = JSON.stringify({ action: 'claim', job_id: CLAIM_JOB.id, run_id: 'wrun_2', idempotency_key: CLAIM_JOB.idempotency_key });
  const res = await handler!(new Request('http://bridge/', {
    method: 'POST', body: raw, headers: { 'x-tr-signature': await signSampleBody(SECRET, raw) } }));
  assert.equal(res.status, 409);
  assert.equal((await res.json()).error_code, 'JOB_TERMINAL');
  const p = seen.filter((x) => x.startsWith('claim-patch'));
  assert.equal(p.length, 1, seen.join(' | '));
  assert.ok(p[0].includes('status=eq.queued'), p[0]);
  const body = JSON.parse(patches[0]);
  assert.equal(body.status, 'failed'); assert.equal(body.error_code, 'cancelled');
  assert.ok(!('workflow_run_id' in body), 'the run never takes ownership');
});

Deno.test('flag OFF: claim answers 500 DB when the cancel write fails (never a silent JOB_TERMINAL)', async () => {
  failCancel = true;
  try {
    const raw = JSON.stringify({ action: 'claim', job_id: CLAIM_JOB.id, run_id: 'wrun_3', idempotency_key: CLAIM_JOB.idempotency_key });
    const res = await handler!(new Request('http://bridge/', {
      method: 'POST', body: raw, headers: { 'x-tr-signature': await signSampleBody(SECRET, raw) } }));
    assert.equal(res.status, 500);
    assert.equal((await res.json()).error_code, 'DB');
    assert.ok(seen.includes('claim-patch-fail'));
  } finally { failCancel = false; }
});
