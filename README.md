# ai-redactor

The Recording Library's in-house redaction + coaching worker for TrueRing. This is an extract for review from the private TrueRing
monorepo: branch `feat/sample-redaction` @ `0adfdaa1`, rebased on main `390ea1f5`.
**Nothing here is applied or deployed.** It builds on RL-1, which is already live on main.

Every file keeps its monorepo path, so this tree overlays the TrueRing repo one to one.
**Start with `sample-redactor/README.md`.** Its section "Review 2026-10-13" answers the previous review item by item.

| Path | What |
|---|---|
| `sample-redactor/` | The worker: a separate Vercel project (Next.js + Vercel Workflow + ffmpeg). `SPEC.md` is main's v0.2, byte for byte. |
| `supabase/migrations/20261013050000_sample_redaction_worker.sql` | **New.** Extends RL-1 with `ALTER TABLE`: worker, cap and takedown columns, month-cap functions, `sample_library_ingest`, two guard triggers. Rollback: `scripts/rollbacks/rollback_20261013050000_…` |
| `supabase/functions/sample-redaction-bridge/` | RL-3: the worker's only way into TR (HMAC). It replaces the signed callback (Dmitry, 2026-10-13). |
| `supabase/functions/training-library-admin/` | RL-2/4/5 staff actions: pick, submit, retry, sweep, link, review, publish, withdraw, edit, delete every copy. |
| `supabase/functions/_shared/sampleSignature.ts`, `telnyxRecording.ts` | New shared helpers. |
| `supabase/tests/sample_redaction/` | The new migration on a throwaway Postgres on top of RL-1; it also re-runs RL-1's own cases. |
| `supabase/tests/sample_signature_parity.ts` | TR (Deno) ↔ worker (Node) signature parity. |
| `src/pages/admin/RecordingLibrary.tsx`, `src/components/recording-library/`, `src/lib/recordingLibraryFlag.ts` | The curation page at `/am/recording-library` and `/admin/recording-library`. |
| `tr-edits/existing-files.patch` | Every edit to an existing TR file, as a diff against main: `App.tsx` and the two layouts (routes and nav), `config.toml` (2 `verify_jwt` entries), `manifest.json` (2026-10-12.3, 2 triggers), `ops-alert` (key `sample_cost_cap`), FLAGS §76, TR_PLAN (bridge decision). |
| **Reference copies from main (unchanged):** `supabase/migrations/20261012180000_training_library.sql`, `supabase/tests/training_library/`, `scripts/rollbacks/rollback_20261012180000_…`, `scripts/verify/verify_20261012180000_…`, `docs/recording-library/SPEC.md` | RL-1, so the migration tests run here. `docs/recording-library/TR_PLAN.md` is the edited version (diff in the patch). |

## What runs standalone here

- `cd sample-redactor && npm ci && npm test && npm run typecheck && npm run build`: the worker's tests and build.
- `bash supabase/tests/sample_redaction/run.sh` and `bash supabase/tests/training_library/run.sh`, with local PostgreSQL 15+.
- `npx -y deno@2.9.6 run supabase/tests/sample_signature_parity.ts`.

The edge functions and the frontend page import TrueRing code that isn't in this extract, so the full `npm run validate` runs from the monorepo worktree. Its last run on `0adfdaa1` passed all 18 offline checks, with 3 skipped: the two installs, and the real-vendor eval, which needs API keys. The eval's plumbing was dry-run against local fake vendors.

## Review focus

Reading order and deliberate deviations: `sample-redactor/README.md`. Anything else that differs from `SPEC.md` v0.2 / `TR_PLAN.md` is a finding. Test calls contain only fictional values.
