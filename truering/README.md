# truering/: REFERENCE COPY ONLY. Never applied from here.

> **Do not apply, deploy or copy anything in this folder into TrueRing.**
> The migration, both edge functions and the admin page are applied **only from TrueRing's own repo, `Mahamadou2004/truering`** (branch `feat/sample-redaction`), through TrueRing's normal PR, migration and deploy process.
> This folder mirrors that branch so the worker's tests and `npm run simulate` can run here. It is refreshed one way, TrueRing → here, with `refresh.sh`.

| Path | What (as it is on the TrueRing branch) |
|---|---|
| `supabase/migrations/20261013090000_sample_redaction_worker.sql` | Extends RL-1 with `ALTER TABLE`. Adds the worker, cap and takedown columns; `sample_job_insert` / `_retry` / `sample_library_ingest`; the month cap; two guard triggers. Rollback: `scripts/rollbacks/rollback_20261013090000_…`. |
| `supabase/functions/sample-redaction-bridge/` | The worker's only door into TrueRing (HMAC). Every action is scoped to one job. |
| `supabase/functions/training-library-admin/` | Staff actions: pick, submit, retry, sweep, link, review, publish, withdraw, edit, delete every copy. |
| `supabase/functions/_shared/sampleSignature.ts`, `telnyxRecording.ts` | Shared helpers. |
| `supabase/tests/sample_redaction/` | The migration on a throwaway Postgres on top of RL-1. |
| `src/pages/admin/RecordingLibrary.tsx`, `src/components/recording-library/`, `src/lib/recordingLibraryFlag.ts` | The curation page at `/am/recording-library` and `/admin/recording-library`. |
| `docs/recording-library/SPEC.md`, `TR_PLAN.md` | The contract. SPEC v0.2 has delivery revised 2026-10-13: results are pulled through the bridge, with no callback. |
| `existing-files.patch` | For reading only: the branch's edits to existing TrueRing files. |
| `FILES` | The branch's new files. |
| RL-1 copies: `supabase/migrations/20261012180000_training_library.sql`, `supabase/tests/training_library/`, `scripts/{rollbacks,verify}/…20261012180000…` | Unchanged from TrueRing main (RL-1 is live). The tests and the simulation build on them. |

```bash
bash truering/refresh.sh /path/to/truering   # refresh this copy from a TrueRing checkout of feat/sample-redaction
bash truering/check.sh   /path/to/truering   # read-only checks INSIDE that checkout: deno check, migration tests, wiring, frontend build
```
