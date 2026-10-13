# ai-redactor

The PII-redacted call-sample service for TrueRing. This is an extract for review from the private
TrueRing monorepo, branch `feat/sample-redaction` @ `734e251d`, based on `ef56fd65`.
**Nothing here is applied or deployed.**

Every file keeps its monorepo path, so this tree overlays the TrueRing repo one to one.

| Path | What |
|---|---|
| `sample-redactor/` | The worker: a separate Vercel project (Next.js + Vercel Workflow + ffmpeg). **Start with `sample-redactor/README.md`.** The original spec is `sample-redactor/SPEC.md`. |
| `supabase/migrations/20261012230000_sample_library.sql` | Tables, publish gate, month-budget functions, RLS, private buckets. Rollback: `scripts/rollbacks/…` |
| `supabase/functions/sample-redaction-bridge/` | The worker's only way into TR (HMAC). |
| `supabase/functions/sample-library-admin/` | Admin actions: submit, retry, approve, publish, delete every copy. |
| `supabase/functions/_shared/sampleSignature.ts`, `telnyxRecording.ts` | New shared helpers. |
| `supabase/tests/run_sample_library_tests.sh` + `sample_library_*.sql` | The migration on a throwaway Postgres: gate, cap race, RLS, rollback. |
| `supabase/tests/sample_signature_parity.ts` | TR (Deno) ↔ worker (Node) signature parity. |
| `src/pages/admin/SampleLibrary.tsx`, `src/components/admin/sample-library/` | The `/admin/sample-library` page and QA player. |
| `tr-edits/existing-files.patch` | The only edits to existing TR files: route and nav entry, two `config.toml` `verify_jwt` entries, two `manifest.json` trigger entries. |

## What runs standalone here

- `cd sample-redactor && npm ci && npm test && npx tsc --noEmit && npx next build`. These are the worker's own tests and build.
- `bash supabase/tests/run_sample_library_tests.sh`, with local PostgreSQL 15+.
- `npx -y deno@2.9.6 run supabase/tests/sample_signature_parity.ts`.

The edge functions and the frontend page import TrueRing code that is not in this extract: the Supabase client, `has_role`, shadcn components and `extractFnError`. The full `npm run validate` therefore needs the monorepo around it. Its last run passed all 17 offline checks, with 3 skipped. The skips were the two installs and the real-vendor eval, which needs API keys.

## Review focus

The reading order and the deliberate deviations from the spec are in `sample-redactor/README.md` ("For reviewers"). Anything else that differs from `SPEC.md` is a finding. The test calls contain only fictional values.
