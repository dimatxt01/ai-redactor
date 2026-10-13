// Deno: the TR-side signer/verifier (_shared/sampleSignature.ts) and the worker's
// Node twin (sample-redactor/lib/signature.ts) must accept each other's headers
// and refuse the same bad ones. Run: deno run supabase/tests/sample_signature_parity.ts
import { signSampleBody, verifySampleSignature } from '../functions/_shared/sampleSignature.ts';
import { signBody, verifySignature } from '../../sample-redactor/lib/signature.ts';

const secret = crypto.randomUUID();
const body = JSON.stringify({ job_id: crypto.randomUUID(), action: 'claim' });
const now = Math.floor(Date.now() / 1000);
let failures = 0;
const check = (name: string, got: unknown, want: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
};

const fromDeno = await signSampleBody(secret, body, now);
const fromNode = signBody(secret, body, now);
check('same header from both signers', fromDeno, fromNode);
check('node accepts deno header', verifySignature(secret, fromDeno, body, now), { ok: true });
check('deno accepts node header', await verifySampleSignature(secret, fromNode, body, now), { ok: true });

for (const [name, s, h, b, t] of [
  ['tampered body', secret, fromNode, body + ' ', now],
  ['wrong secret', 'other', fromNode, body, now],
  ['stale (301 s)', secret, fromNode, body, now + 301],
  ['missing header', secret, null, body, now],
  ['unset secret', undefined, fromNode, body, now],
  ['malformed', secret, 't=1,v1=zz', body, now],
] as const) {
  check(`deno refuses: ${name}`, (await verifySampleSignature(s, h, b, t)).ok, false);
  check(`node refuses: ${name}`, verifySignature(s, h, b, t).ok, false);
}

if (failures) { console.log(`${failures} parity check(s) failed`); Deno.exit(1); }
console.log('signature parity: ok');
