// deno test supabase/functions/_shared/recordingLibraryGate.test.ts
import { strict as assert } from 'node:assert';
import { FLAG_GATED_ACTIONS, FLAG_UNGATED_ACTIONS, recordingLibraryGate } from './recordingLibraryGate.ts';

const on = () => Promise.resolve(true);
const off = () => Promise.resolve(false);
const boom = () => Promise.reject(new Error('flag read failed'));

Deno.test('every write action is refused with FLAG_OFF when the flag is OFF', async () => {
  for (const a of ['submit', 'retry', 'pick', 'link', 'review', 'publish', 'edit']) {
    const r = await recordingLibraryGate(a, off);
    assert.equal(r?.error_code, 'FLAG_OFF', a);
  }
});

Deno.test('write actions pass when the flag is ON', async () => {
  for (const a of FLAG_GATED_ACTIONS) assert.equal(await recordingLibraryGate(a, on), null, a);
});

Deno.test('cancel, delete, sweep (and withdraw) work with the flag OFF and never read the flag', async () => {
  for (const a of ['cancel', 'delete', 'sweep', 'withdraw']) {
    let read = false;
    const r = await recordingLibraryGate(a, () => { read = true; return off(); });
    assert.equal(r, null, a);
    assert.equal(read, false, a);
  }
});

Deno.test('gated and ungated sets are disjoint and cover every action', () => {
  for (const a of FLAG_UNGATED_ACTIONS) assert.ok(!FLAG_GATED_ACTIONS.has(a), a);
  const all = new Set([...FLAG_GATED_ACTIONS, ...FLAG_UNGATED_ACTIONS]);
  const src = Deno.readTextFileSync(new URL('../training-library-admin/index.ts', import.meta.url));
  const cases = [...src.matchAll(/^\s*case '([a-z_]+)':/gm)].map((m) => m[1]);
  assert.ok(cases.length >= 11);
  for (const c of cases) assert.ok(all.has(c), `action ${c} is in neither set`);
});

Deno.test('a rejecting flag reader never opens the gate (flagEnabled itself fails closed: unreadable = OFF)', async () => {
  await assert.rejects(recordingLibraryGate('submit', boom));
});

Deno.test('bridge poll claim capacity is 0 while the flag is OFF, unchanged while ON', async () => {
  const { pollClaimCapacity } = await import('./recordingLibraryGate.ts');
  assert.equal(pollClaimCapacity(3, false), 0);
  assert.equal(pollClaimCapacity(3, true), 3);
  assert.equal(pollClaimCapacity(0, true), 0);
});
