# truering/: the TrueRing side

Everything the worker needs inside TrueRing, at its TrueRing paths. It is byte-identical to TrueRing branch `feat/sample-redaction`. TrueRing's own rules still apply: stage on a branch, apply migrations one at a time with the `apply-migration` skill, and give each deploy its own go.

| Path | What |
|---|---|
| `supabase/migrations/20261013090000_sample_redaction_worker.sql` | Extends RL-1 with `ALTER TABLE`. Adds the worker, cap and takedown columns; `sample_job_insert` / `_retry` / `sample_library_ingest`; the month cap; two guard triggers. Rollback: `scripts/rollbacks/rollback_20261013090000_…`. |
| `supabase/functions/sample-redaction-bridge/` | The worker's only door into TrueRing (HMAC). Every action is scoped to one job. |
| `supabase/functions/training-library-admin/` | Staff actions: pick, submit, retry, sweep, link, review, publish, withdraw, edit, delete every copy. |
| `supabase/functions/_shared/sampleSignature.ts`, `telnyxRecording.ts` | New shared helpers. |
| `supabase/tests/sample_redaction/` | The migration on a throwaway Postgres on top of RL-1. |
| `src/pages/admin/RecordingLibrary.tsx`, `src/components/recording-library/`, `src/lib/recordingLibraryFlag.ts` | The curation page at `/am/recording-library` and `/admin/recording-library`. |
| `existing-files.patch` | Edits to existing TrueRing files: `App.tsx` and both layouts (routes and nav), `config.toml` (2 `verify_jwt` entries), the integrity manifest (2 triggers), `ops-alert` (key `sample_cost_cap`), FLAGS §76, TR_PLAN. |
| `FILES` | The new files `install.sh` copies. |
| RL-1 copies: `supabase/migrations/20261012180000_training_library.sql`, `supabase/tests/training_library/`, `scripts/{rollbacks,verify}/…20261012180000…`, `docs/recording-library/SPEC.md` | Unchanged from TrueRing main. They are here so the tests and the simulation run in this repo. `install.sh` refuses a checkout whose RL-1 differs. |

```bash
git -C /path/to/truering switch -c feat/sample-redaction   # or an existing branch
bash truering/install.sh /path/to/truering                  # copies FILES, applies the patch; never commits or deploys
bash truering/check.sh   /path/to/truering                  # deno check, migration tests, wiring, frontend tsc/eslint/vite build
```

`install.sh` also refuses to run on `main`, on a dirty tree, or when migration version `20261013090000` has been taken in the meantime.
