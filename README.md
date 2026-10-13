# ai-redactor

TrueRing's Recording Library worker. It takes a Final Expense sale call, bleeps every piece of personal data, and cuts up to 6 coaching clips, for internal training. This repo is its own **Vercel project**, deployed separately from TrueRing. It talks to TrueRing only through two signed HTTP endpoints.

**Status: nothing deployed or applied.** Built to SPEC v0.2 ([`truering/docs/recording-library/SPEC.md`](truering/docs/recording-library/SPEC.md)). It sits on top of TrueRing's RL-1 (live since 2026-10-13).

## How it connects to TrueRing

```
TrueRing (Supabase)                                               ai-redactor (this repo, Vercel)
───────────────────                                               ──────────────────────────────
/am/recording-library, /admin/recording-library  (flag recording_library)
   │
   ▼
training-library-admin  ── POST /api/jobs, /api/delete ──────────► app/api/jobs, app/api/delete
 (edge function)           HMAC: SAMPLE_REDACTOR_START_SECRET          │ one durable Workflow run per job
                                                                       ▼
sample-redaction-bridge ◄── every read, status write, signed URL ── workflows/redact-call.ts
 (edge function)            HMAC: SAMPLE_REDACTOR_BRIDGE_SECRET        ├─ AssemblyAI (transcribe ×2)
   │                                                                   └─ OpenRouter (PII labels, clips, coaching)
   ▼
sample_redaction_jobs · training_library_* (RL-1) · storage sample-src/<job_id>/, training-library/<job_id>/
```

- **The worker holds no Supabase key.** The bridge is its only way into TrueRing, and each call is scoped to one job.
- **Each direction has its own secret.** Requests are signed `X-TR-Signature: t=<unix>,v1=<hmac>` and accepted for ±300 s.
- **The TrueRing side lives in [`truering/`](truering/), at its TrueRing paths:** the migration, the two edge functions, the curation page and the wiring edits. It is byte-identical to TrueRing branch `feat/sample-redaction`. [`truering/install.sh`](truering/install.sh) puts it into a TrueRing checkout; see [`truering/README.md`](truering/README.md).

## Test it

```bash
npm ci
npm run simulate                  # the whole system on this machine, no keys, nothing live (~1 min)
npm run validate -- --offline     # every check incl. the simulation; no vendor calls
npm run validate                  # + the real-vendor eval if ASSEMBLYAI_API_KEY / OPENROUTER_API_KEY are set (~$1.60)
bash truering/check.sh /path/to/truering   # TrueRing-side checks inside a TrueRing checkout (after install.sh)
```

Prerequisites: Node ≥22 and PostgreSQL 15+ (`brew install postgresql@17`). Deno comes via `npx`. Generating the test calls needs macOS `say`.

### `npm run simulate`: how it would work, end to end

It runs the real code on both sides and fakes only what lives outside both repos:

| Real | Faked (`sim/`) |
|---|---|
| The worker: `next build` + `next start`, on the local Workflow runtime | Supabase's HTTP layer: the same queries, on a throwaway Postgres (`sim/supabase/fake-supabase.ts`); storage on disk |
| `training-library-admin` and `sample-redaction-bridge`, unchanged, under Deno | Telnyx: serves the test call's mp3 |
| RL-1 plus this repo's migration, on Postgres 17 | AssemblyAI: returns the call's words. On the second pass it **listens** to the redacted mp3 for the bleep tone, so an unbleeped value stays audible, as it would with the real vendor |
| | OpenRouter: a valid clips and coaching answer. Each job's first answer is deliberately invalid, so the worker's one retry gets exercised |

It plays an AM through the real admin function and checks every outcome from TrueRing's side:

1. Wrong secrets in either direction are refused, and non-staff users are refused.
2. Submit rules:
   - flag off → refused;
   - Twilio-era call → refused;
   - agent with no consent → refused;
   - the $100/month cap → refused, and the ops alert event is logged.
3. A submit runs through every stage: queued → fetching → transcribing → redacting → verifying → done. The result is a `pending_qa` library row, ≤6 clips with the fixed labels (`application` clips are never exported), and call coaching. Scratch files are emptied and the vendor copies deleted. The cost is recorded under $2.
4. A start that pairs a job with another call's key leaves the job untouched. The same start delivered twice: exactly one run does the work.
5. When the recording is gone, the job fails with `fetch_expired` and leaves nothing behind. A retry then succeeds.
6. QA: approve is refused until the call and every clip have been played; then approve and publish work.
7. Delete every copy:
   - both storage buckets are emptied, the library row is withdrawn and emptied, and the vendor copies are gone;
   - the call can't be sampled again, and the bridge refuses the deleted job.
8. Privacy:
   - **Audio:** every planted value is checked in the redacted call and in every clip. A control run of the same listener on the original recording must hear all of them.
   - **Text:** every artifact and table is searched for planted values.
   - **Logs and Workflow event log:** searched too; the event log's step inputs are decoded first, with a control that must find the job ids.

The output goes to `sim-out/<time>/`:
- `report.md`;
- `storage/`, every file TrueRing would hold, so you can listen to `training-library/<job_id>/redacted.mp3` and `clips/cN.mp3`;
- `logs/`.

## Deploy (each step its own go)

1. **TrueRing:**
   - `bash truering/install.sh <truering checkout>` on a branch, then `bash truering/check.sh <checkout>`; review and merge.
   - Apply migration `20261013090000_sample_redaction_worker.sql` (TrueRing's `apply-migration` skill), then redeploy `integrity-audit`.
   - Set the secrets below, then deploy `training-library-admin`, `sample-redaction-bridge` and `ops-alert`.
2. **This repo:**
   - Create the Vercel project from the repo root (framework Next.js; `vercel.json` sets the function sizes).
   - Set the env below, deploy, and check `GET /api/health`: `configured` should show all true, plus the pinned models.
3. **TrueRing frontend:** deploy it. The page stays hidden while the flag is off.
4. **Pilot:** arm `recording_library` (TrueRing FLAGS §76) and run 5 internal calls with offline consent. Listen to every file and clip. Confirm the Telnyx channel order.

| Where | Required | Optional |
|---|---|---|
| Vercel (this repo) | `TR_BRIDGE_URL` = `https://<project>.supabase.co/functions/v1/sample-redaction-bridge`, `SAMPLE_REDACTOR_BRIDGE_SECRET`, `SAMPLE_REDACTOR_START_SECRET`, `ASSEMBLYAI_API_KEY`, `OPENROUTER_API_KEY` | `ASSEMBLYAI_SPEECH_MODEL`, `OPENROUTER_MODEL` (changing one = bump `PIPELINE_VERSION`) |
| TrueRing function secrets | `SAMPLE_REDACTOR_URL` (this deployment's URL), `SAMPLE_REDACTOR_START_SECRET`, `SAMPLE_REDACTOR_BRIDGE_SECRET` (same values as Vercel) | `SAMPLE_JOB_CAP_USD` (2), `SAMPLE_MONTH_CAP_USD` (100), `SAMPLE_ASR_USD_PER_HOUR` (0.45; set it to the contracted rate). `TELNYX_API_KEY` already exists. |

Outside the repo:
- AssemblyAI and OpenRouter zero-retention and no-training agreements. The pinned OpenRouter model must have a ZDR endpoint, or every call fails closed.
- A Supabase upload limit of at least 200 MB.
- Vercel Deployment Protection off for `/.well-known/workflow/v1/webhook/*` (AssemblyAI calls it) and `/api/*` (HMAC-protected).

Rollback, in order:
1. Disarm `recording_library`.
2. Unset `SAMPLE_REDACTOR_URL`, or delete the Vercel project.
3. Undeploy the two functions.
4. Run `truering/scripts/rollbacks/rollback_20261013090000_sample_redaction_worker.sql`. RL-1 stays.

## Layout

| Path | What |
|---|---|
| `app/api/{jobs,delete,health}` | The worker's HTTP surface: start a job, delete every vendor copy, health. |
| `workflows/` | The durable pipeline: claim → fetch → transcribe → detect → render → clips + coaching → verify → complete. |
| `lib/` | Detectors (`pii/`), audio DSP (`audio.ts`), clips + coaching (`labels.ts`), QA (`qa.ts`), the bridge client, option defaults, costs, logs. |
| `test/` | Unit tests (`npm test`). |
| `fixtures/calls/` | 12 synthetic two-voice calls with planted, fictional PII (`npm run make-test-calls` renders them). |
| `scripts/` | `validate.sh`, `eval-test-calls.ts` (real vendors), `signature-parity.ts` (TrueRing ↔ worker HMAC), `check-ffmpeg.mjs`. |
| `sim/` | The end-to-end simulation (`npm run simulate`). |
| `truering/` | The TrueRing side + `install.sh`, `check.sh`, `FILES`, `existing-files.patch`. |
| `docs/DESIGN.md` | The pipeline in detail, how each requirement is met, deliberate deviations from SPEC v0.2, the 2026-10-13 review item by item. |
