# sample-redactor — PII-bleeped sales-call samples

Built in-house (no n8n) from [`SPEC.md`](SPEC.md) v0.1 (2026-10-12, copied here unchanged) plus the service notes of
the same day. **Status: STAGED, NOTHING DEPLOYED OR APPLIED.** Every live step below
needs its own explicit go (`CLAUDE.md` rule 5, `prod-change` skill).

## Shape

```
/admin/sample-library (TR frontend)
   │  supabase.functions.invoke
   ▼
sample-library-admin  (edge fn, admin JWT) ──HMAC(START)──►  sample-redactor (this project, Vercel)
   │ writes sample_* rows, signed play URLs,                    POST /api/jobs → Workflow run per job
   │ caps, delete-every-copy                                    POST /api/delete → cancel runs + purge vendor
   ▼                                                                │
sample_redaction_jobs / sample_library / sample_library_approvals  │ every read/write/URL, HMAC(BRIDGE)
storage: sample-work (scratch), sample-library (artifacts)  ◄── sample-redaction-bridge (edge fn)
```

The worker holds **no Supabase key**. The bridge is its only door into TR, and each
call is scoped to one job, its scratch prefix and its artifact prefix.

### Pipeline (one durable Workflow run per job, `workflows/redact-call.ts`)

1. **claim** — compare-and-swap on the job. Only one run can own it; a duplicate start exits at once. Re-checks the month cap.
2. **fetch** — fresh Telnyx link via the bridge, downloaded at once, never stored. Probe: 2 channels, ≤60 min, length within ±5% of `calls.duration` (a miss is a QA flag).
3. **ASR pass 1** — AssemblyAI, pinned model, `multichannel`, entity detection, word timestamps. The webhook only wakes the run; the status is always read back with our key.
4. **detect** — rules (digit runs ≥4 within 8 s across speakers, spoken digits/letters, MBI, spelled-out runs, emails, addresses, dates, ages, TR's agent/caller names, carrier terms), AssemblyAI entities, and OpenRouter labels (quotes mapped back to ASR words; the LLM never makes timestamps). Every name found is bleeped wherever it's said.
5. **render** — PII silenced on both legs **on the source timeline**. Then the customer is pitch-shifted (−3 st, in 30 s chunks so timing can't drift), mixed to mono, a 1 kHz −12 dBFS tone laid over every interval (pad 250 ms, merged under 500 ms), and encoded as mp3 44.1 kHz/128 kbps.
6. **transcript files** — `transcript.json/.txt` with `[REDACTED:TYPE]`, and `pii_spans.json` (positions only, no text).
7. **labels + coaching + highlight** — one OpenRouter call on the **redacted** transcript. Fixed clip labels (`lib/config.ts` `CLIP_LABELS`), coaching notes, and a 3–8 min highlight snapped outside bleeps with 1 s fades.
8. **ASR pass 2** on the redacted audio. Any digit run, MBI, known name or PII entity outside a bleep → `qa_flag` with reasons.
9. **complete** — the bridge verifies every artifact is uploaded, writes `sample_library` (`pending_qa`) and empties scratch. AssemblyAI transcripts are deleted.

Human gate (DB trigger `sample_library_status_gate` + admin function): QA and legal by **two different
people**, each approval only after that person opened the full redacted audio (checked against the access
log) and played it through (the UI unlocks the checkbox at ≥98% continuous playback). Publishing also needs
the agent's `consent_ref`. Blanking it later, or reviving a deleted sample, is refused.

Every JSON result is an envelope `{schema, pipeline_version, job_version, call_id, items}`.
Audio carries `"<pipeline_version> job_v<n>"` in its ID3 comment.

### How the service notes are met

| Note | Where |
|---|---|
| Channels separate; TR says which is the customer | submit dialog → `call_meta.channel_map`; every result QA-flagged `channel_map_unverified` until the pilot confirms the order |
| Same call / duplicate callback does nothing twice | `call:<id>:v<n>` key (submit returns the existing job); bridge `claim` CAS + `run_id` on every action; `complete`/`fail` idempotent; cost ledger idempotent per item |
| ≤60 min calls, 2 h per job | submit + fetch reject >60 min; bridge fails any job older than 2 h; admin `sweep` |
| Dedicated transcriber; OpenRouter only for labels/coaching; pinned | `lib/config.ts` `MODELS` (one id each, no fallbacks); OpenRouter `provider.zdr=true, data_collection=deny`; text only |
| $2/job, $100/month | submit/retry **reserve** the estimate atomically (`sample_job_insert` / `sample_job_retry` under an advisory lock; running jobs count `max(cost, reserved)`); bridge `claim` and every `cost` re-check the month; worker `guard` before each paid call + `charge` after (OpenRouter `usage.cost`, billed even on failed attempts) |
| Fixed clip labels + version on every result | `CLIP_LABELS`; `PIPELINE_VERSION` in envelopes, ID3, job row, library row |
| Test calls with planted fake PII | `fixtures/calls/*.txt` → `npm run make-test-calls` (real dual-channel mp3) → `npm test` (rules) and `npm run eval` (real vendors, leak report) |
| Logs with no PII | `lib/log.ts` (ids/numbers only); step I/O carries no text (transcripts live in the private bucket between steps); errors keep only a code |
| Delete endpoint removes every copy | admin `delete {call_id}`: **tombstone first** (bridge, submit and retry refuse the call from then on) → worker `/api/delete` cancels runs and waits for them to stop → AssemblyAI transcripts deleted (ids re-read after the runs stopped) → both buckets purged → a durable `purgeLater` run re-purges after 2h15m, once every signed upload URL has expired. Rows stay as the take-down record. The 2h sweep and every failed run take the same purge path |

### Deliberate deviations from SPEC.md

- **No callback, no service-side copies, no 7-day retention.** The worker writes straight into TR's private buckets through the bridge. Scratch is deleted when the job ends (done *or* failed). AssemblyAI copies are deleted at the end of the run.
- **No n8n.** Vercel Workflow does the orchestration and ffmpeg runs inside the workflow route.
- **Digit runs skip counts and amounts** ("two kids", "ten thousand dollars", "$45.50"). Otherwise ordinary talk within 8 s gets bleeped and coverage/premium amounts vanish from sales samples. Ages still have their own rule. Revert by deleting `isQuantity` in `lib/pii/detect.ts`.
- **Twilio-era recordings are out of v1.** The bridge returns `unsupported_source`.
- **Spelled-out letter runs (≥3) are always PII.** This isn't in the spec; it catches spelled names and emails.
- **Pitch-shift fallback:** without rubberband in the ffmpeg build, it uses resample+atempo, which isn't formant-preserving. `GET /api/health` reports which one the deployment has, and `engine.pitch` records it per job.

## First validation (one command, nothing live)

```bash
cd sample-redactor
npm run validate                 # every check below; the vendor eval runs only if keys are set
npm run validate -- --offline    # never call the vendors
npm run validate -- --fresh      # clean npm ci for the worker and the frontend first
```

Keys come from the environment or `sample-redactor/.env.local` (gitignored); they are never printed.
It writes `fixtures/out/validation-<time>.md` (gitignored) plus per-check logs. Send that file back.

| Check | Proves |
|---|---|
| worker typecheck, 44 unit tests, `next build` | detectors, DSP (incl. the drift test), HMAC, no-PII logs; the workflow bundle compiles |
| test calls | 4 synthetic dual-channel calls with planted fictional PII, one no-PII control |
| local server | `/api/health` answers; `/api/jobs` and `/api/delete` refuse unsigned, wrong-secret, 10-min-old and tampered requests; the secret never reaches the log |
| `deno check` + HMAC parity | both edge functions typecheck; TR's Deno signer and the worker's Node signer produce the same header and refuse the same bad ones |
| migration on a throwaway Postgres (`supabase/tests/run_sample_library_tests.sh`) | the self-verify block passes; publish gate (two people, listened in full, consent, no insert straight to published); append-only approvals; deleted stays withdrawn; month cap holds under a two-session race (fails without the advisory lock); RLS: admins read, nobody else reads or writes; re-apply is idempotent; rollback leaves nothing |
| repo wiring + hygiene | manifest triggers, `verify_jwt` entries, rollback present; no secret-shaped strings, env files or audio in the branch |
| frontend | `tsc -p tsconfig.app.json` adds no errors (baseline 5), new files lint clean, edited files no worse than `main`, `vite build` |
| vendor eval (`npm run eval`, keys needed) | real AssemblyAI pass 1 → rules + entities + OpenRouter PII pass → bleeps → render → AssemblyAI pass 2. Fails on any planted value audible or left in the redacted transcript, any second-pass hit, a label outside `CLIP_LABELS`, or a crash. About 2.5 min of audio, twice: well under $0.10 |

Outputs to listen to and read: `fixtures/out/*.redacted.mp3`, `*.redacted.txt`, `*.labels.json`, `*.coaching.json`, `eval-report.json`.

Single pieces: `npm test`, `npm run make-test-calls`, `npm run eval [-- 01-classic-sale]`, `npm run build`,
`bash supabase/tests/run_sample_library_tests.sh` (from the repo root).

## For reviewers

Everything is on branch `feat/sample-redaction`: `git diff origin/main...feat/sample-redaction`. Suggested order:

1. `supabase/migrations/20261012230000_sample_library.sql`: tables, publish gate, budget functions, RLS, buckets. Tests: `supabase/tests/sample_library_test.sql`.
2. `supabase/functions/sample-redaction-bridge/index.ts`: the worker's only way into TR (claim CAS, run ownership, tombstone, cost ledger, 2h deadline, purge).
3. `supabase/functions/sample-library-admin/index.ts`: submit/retry/approve/publish/delete-every-copy, admin JWT.
4. `sample-redactor/workflows/redact-call.ts` + `steps.ts`: the durable pipeline and its failure path.
5. `sample-redactor/lib/pii/detect.ts`, `lib/audio.ts`, `lib/qa.ts`: what gets bleeped, how, and how leaks are caught.
6. `src/pages/admin/SampleLibrary.tsx`, `src/components/admin/sample-library/QaPlayer.tsx`: the admin page and listen-in-full gate.

Status: nothing applied or deployed. The deviations below are deliberate; anything else that differs from `SPEC.md` is a finding.

## Configuration

Worker (Vercel project `sample-redactor`, env vars by name only):
`TR_BRIDGE_URL` (= `https://<project>.supabase.co/functions/v1/sample-redaction-bridge`),
`SAMPLE_REDACTOR_BRIDGE_SECRET`, `SAMPLE_REDACTOR_START_SECRET`, `ASSEMBLYAI_API_KEY`,
`OPENROUTER_API_KEY`; optional `ASSEMBLYAI_SPEECH_MODEL`, `OPENROUTER_MODEL` (changing either = bump `PIPELINE_VERSION`).

TR (Supabase function secrets): `SAMPLE_REDACTOR_URL`, `SAMPLE_REDACTOR_START_SECRET`,
`SAMPLE_REDACTOR_BRIDGE_SECRET` (each direction its own secret), optional
`SAMPLE_JOB_CAP_USD` (2), `SAMPLE_MONTH_CAP_USD` (100), `SAMPLE_ASR_USD_PER_HOUR` (0.45: set it
to AssemblyAI's contracted rate incl. entity detection). `TELNYX_API_KEY` already exists.

Prerequisites outside the repo:
- AssemblyAI and OpenRouter data agreements: zero retention, no training. Confirm the pinned OpenRouter model has a ZDR endpoint, otherwise every call fails closed.
- Supabase project upload limit ≥200 MB (60-min sources and outputs pass 50 MB).
- Vercel: the worker's production domain must not sit behind Deployment Protection for `/.well-known/workflow/v1/webhook/*` (AssemblyAI calls it) and `/api/*` (HMAC-protected).

## Rollout order (each step its own go)

1. Apply `supabase/migrations/20261012230000_sample_library.sql` (`apply-migration` skill). Then redeploy `integrity-audit`: the manifest now expects the two new triggers, so deploying it before the migration would alarm.
2. Set the TR secrets, then deploy `sample-library-admin` and `sample-redaction-bridge`.
3. Create the Vercel project from `sample-redactor/`, set its env, deploy, and check `GET /api/health`.
4. Deploy the frontend (`/admin/sample-library` is new; nothing existing changes).
5. Pilot: 5 internal calls. `ffprobe` channel order and sample rate, then listen to every file end to end. Then mark the channel map verified (follow-up).

Rollback: delete the Vercel project, or unset `SAMPLE_REDACTOR_URL` so submit fails closed. Undeploy the two functions. Run `scripts/rollbacks/rollback_20261012230000_sample_library.sql` after emptying both buckets. Revert the manifest entries.
