// Sample-library spec §4: HMAC-SHA256 between TR and the ai-redactor worker.
//   X-TR-Signature: t=<unix>,v1=<hex(hmac(secret, t + "." + raw_body))>
// Replay window ±300s. Each direction has its own secret:
//   SAMPLE_REDACTOR_START_SECRET   TR → worker (sample-library-admin starts a job)
//   SAMPLE_REDACTOR_BRIDGE_SECRET  worker → TR (sample-redaction-bridge)
// A missing secret REJECTS (never fail-open). The worker has a byte-identical
// Node copy in the ai-redactor repo, lib/signature.ts (its scripts/signature-parity.ts checks both agree).

const enc = new TextEncoder();
const WINDOW_S = 300;

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
  return Array.from(sig, (b) => b.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function signSampleBody(secret: string, rawBody: string, nowS = Math.floor(Date.now() / 1000)): Promise<string> {
  return `t=${nowS},v1=${await hmacHex(secret, `${nowS}.${rawBody}`)}`;
}

export async function verifySampleSignature(
  secret: string | undefined,
  header: string | null,
  rawBody: string,
  nowS = Math.floor(Date.now() / 1000),
): Promise<{ ok: true } | { ok: false; reason: 'unconfigured' | 'missing' | 'malformed' | 'stale' | 'mismatch' }> {
  if (!secret) return { ok: false, reason: 'unconfigured' };
  if (!header) return { ok: false, reason: 'missing' };
  const parts = Object.fromEntries(header.split(',').map((p) => {
    const i = p.indexOf('=');
    return i < 0 ? [p.trim(), ''] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
  }));
  const t = Number(parts.t);
  const v1 = parts.v1 ?? '';
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowS - t) > WINDOW_S) return { ok: false, reason: 'stale' };
  const expected = await hmacHex(secret, `${t}.${rawBody}`);
  return timingSafeEqual(expected, v1) ? { ok: true } : { ok: false, reason: 'mismatch' };
}
