# truering/: MIRROR ONLY. Never applied or deployed from here.

> **The source of truth is TrueRing's own repo: `Mahamadou2004/truering`, branch `prb/rl-worker`** (later main). It holds the migration, `sample-redaction-bridge`, `training-library-admin`, the curation page, SPEC and TR_PLAN, and it goes through TrueRing's own review, migration and deploy process.
> This folder copies that branch (exact commit in [`SOURCE`](SOURCE)) so the worker's tests and `npm run simulate` can run against the real TrueRing code. It is refreshed one way, TrueRing → here, with `refresh.sh`. Never edit files here: fix them in TrueRing, then refresh.

| Path | What (as it is on `prb/rl-worker`) |
|---|---|
| `supabase/migrations/20261013090000_sample_redaction_worker.sql` | Extends RL-1. **Columns:** the worker, cap, `heartbeat_at` and `vertical` columns. **Functions:** `sample_job_insert` / `_retry`, `sample_library_ingest`, `sample_month_committed_usd` over the `sample_spend_ledger`, `sample_call_delete_blockers`, and `sample_call_hard_delete`. **Guard:** the column guard trigger. Rollback: `scripts/rollbacks/rollback_20261013090000_…`. |
| `supabase/functions/sample-redaction-bridge/` | The worker's only door into TrueRing (HMAC). `poll` plus the per-job actions. |
| `supabase/functions/training-library-admin/` | Staff actions: pick, submit, retry, sweep, link, review, publish, withdraw, edit; and, admin only, cancel and hard delete. |
| `supabase/functions/_shared/sampleSignature.ts`, `telnyxRecording.ts` | Shared helpers. |
| `supabase/tests/sample_redaction/` | The migration on a throwaway Postgres on top of RL-1. |
| `src/pages/admin/RecordingLibrary.tsx`, `src/components/recording-library/`, `src/lib/recordingLibraryFlag.ts` | The curation page at `/am/recording-library` and `/admin/recording-library`. |
| `docs/recording-library/SPEC.md`, `TR_PLAN.md`, `DEPLOY_LIST.md` | The contract and the plan: pull through the bridge, Node container, every vertical, no consent gate, cancel, hard delete. |
| `existing-files.patch` | For reading only: the branch's edits to existing TrueRing files. |
| `FILES`, `SOURCE` | The branch's new files, and the exact commit mirrored. |
| RL-1 copies: `supabase/migrations/20261012180000_training_library.sql`, `supabase/tests/training_library/`, `scripts/{rollbacks,verify}/…20261012180000…` | As on TrueRing main (RL-1 is live). The tests and the simulation build on them. |

```bash
git -C /path/to/truering fetch origin prb/rl-worker && git -C /path/to/truering checkout --detach origin/prb/rl-worker
bash truering/refresh.sh /path/to/truering prb/rl-worker   # refresh this mirror (records the commit in SOURCE)
bash truering/check.sh   /path/to/truering                 # read-only checks INSIDE that checkout
```
