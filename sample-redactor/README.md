# sample-redactor: the Recording Library's redaction + coaching worker

Built in-house, without n8n, to [`SPEC.md`](SPEC.md) v0.2. That file is a byte-for-byte copy of `docs/recording-library/SPEC.md`.
TR side: `docs/recording-library/TR_PLAN.md` (RL-2…RL-5, revised 2026-10-13).
**Status: STAGED, NOTHING DEPLOYED OR APPLIED.** It sits on top of RL-1 (`20261012180000_training_library`, applied 2026-10-13).
Every live step below needs its own explicit go (`CLAUDE.md` rule 5, `prod-change` skill).

## Shape

```
/am/recording-library + /admin/recording-library (TR frontend, flag recording_library)
   │  supabase.functions.invoke('training-library-admin')       reads: RL-1 tables under RLS
   ▼
training-library-admin (edge fn, staff JWT) ──HMAC(START)──►  sample-redactor (this project, Vercel)
   │ pick, submit (caps), retry, sweep, link (logged),            POST /api/jobs   → one Workflow run per job
   │ review, publish, withdraw, edit, delete-every-copy           POST /api/delete → cancel runs + purge AssemblyAI
   ▼                                                                   │
sample_redaction_jobs (RL-1 + worker columns)                          │ every read / write / URL, HMAC(BRIDGE)
training_library_calls / _call_sources / _clips / _reviews (RL-1)  ◄── sample-redaction-bridge (edge fn, RL-3)
storage (RL-1, private): sample-src/<job_id>/ (scratch) · training-library/<job_id>/ (artifacts)
```

The worker holds **no Supabase key**. The bridge is its only way into TR, and each call is scoped to one job and its two prefixes.
Paths carry the job id, never `calls.id`, because agents can read published `training_library_calls` rows (RL-1).

### Pipeline (one durable Workflow run per job, `workflows/redact-call.ts`)

1. **claim**: compare-and-swap on the job, and the start's `idempotency_key` must match the job row. Only one run can own a job; a duplicate start exits at once. Re-checks the month cap.
2. **fetch**: a fresh Telnyx link via the bridge, downloaded at once and never stored.
   - Probe: 2 channels, ≤60 min, length within ±5% of `calls.duration` (a miss is a QA flag).
   - Over 60 min fails as `bad_audio: too_long`.
3. **ASR pass 1**: AssemblyAI with a pinned model, `multichannel`, entity detection and word timestamps. The webhook only wakes the run; the status is always read back with our key.
4. **detect** (SPEC §2.3), three sources:
   - **Rules:** digit runs ≥4 within 8 s across speakers; spoken digits and letters; MBI; spelled-out runs; emails; addresses; dates; ages; TR's agent and caller names; `extra_terms`.
   - **AssemblyAI entities.**
   - **An OpenRouter PII pass:** quotes are mapped back to ASR words, so the LLM never makes timestamps.

   Every name found is bleeped wherever it's said.
5. **render**:
   - PII is silenced on both legs **on the source timeline**.
   - The pitch shift is optional and **off by default** (v0.2).
   - Then a mono mix, with a 1 kHz −12 dBFS tone over every interval (250 ms pad, spans under 500 ms apart merged).
   - Encoded as mp3 44.1 kHz/128 kbps.
6. **transcript files**:
   - `transcript.json` and `transcript.txt`, with `[REDACTED:TYPE]` in place of PII;
   - `pii_spans.json` (positions only, no text).
7. **smart clips + coaching** (SPEC §2.6–2.7, `lib/labels.ts`). One OpenRouter call reads the **redacted** transcript.
   - **Input:** fixed taxonomy (`CLIP_LABELS`, objection sub-labels), rubric `fe_v1`, temperature 0, seed 7.
   - **Validation:** zod schema plus rules (≤6 clips, ids that exist, sub-label only on objections, scores 1–5, exactly 3 strengths and 3 improvements, a valid turning point).
   - **Retry:** if the answer fails validation, it is retried **once** with the error included. If it still fails, there are no clips and the job gets `labels_invalid`.
   - **Clip windows:** snapped to utterance boundaries, 20–240 s, never starting or ending inside a bleep (`snapClip`).
   - **Clip audio:** cut from the **redacted** audio with 1 s fades. `application` clips are labelled and coached, but their audio is not exported.
   - **Key lines:** copied from the redacted lines by id, so no output text can restore a bleeped value.
   - **Outputs:** `clips.json`, `coaching.json`, and `clips/cN.mp3`.
8. **ASR pass 2** on the redacted audio (SPEC §2.8):
   - Any digit run, MBI, known name or PII entity outside a bleep → `qa_flag` with reasons.
   - The same hits are mapped onto every exported clip (`second_pass_clip:cN:…`; each clip is a cut of this audio).
   - The same digit-run, MBI and name checks run on **all coaching text** (`coaching_pii:…`).
9. **complete**:
   - The bridge checks every file is in `training-library/<job_id>/`.
   - `sample_library_ingest` then writes, in one transaction: the job as `done`, plus `training_library_calls` (`pending_qa`), `_call_sources` (with the agent's active `consent_id`) and `_clips`.
   - Scratch is emptied and AssemblyAI's transcripts are deleted.

**Human gate.** RL-1's trigger allows publish only when the latest review is `approve` with `listened_full`, and the source agent's consent is active. `training-library-admin` adds two things on top:
- The reviewer must have opened the full call **and every exported clip**; this is checked against the access log. The UI also unlocks the checkbox only after ≥98% continuous playback of each.
- A taken-down call can never be published again (trigger `sample_redaction_takedown_guard`).

Every JSON result is an envelope `{schema, schema_version: "1.0", pipeline_version, job_version, call_id, items}`, and every job row carries `schema_version` too. Audio carries `"<pipeline_version> job_v<n>"` in its ID3 comment.

### How the service notes and SPEC v0.2 are met

| Requirement | Where |
|---|---|
| Separate channels; TR says which is the customer | **Submit dialog:** the channel choice is stored in `call_meta.channel_map`. Every result is QA-flagged `channel_map_unverified` until the pilot confirms the order. |
| Same call or a duplicate callback does nothing twice | **Key:** `call:<id>:v<n>` (DB check: key = call_id + version), and submit returns the existing job. **Bridge:** `claim` is a compare-and-swap and checks the key; `run_id` is required on every action. **Idempotent:** `complete` (ingest replay) and `fail`, and the cost ledger per item. |
| ≤60 min calls, 2 h per job | Submit and fetch reject calls over 60 min (`too_long`). The bridge fails any job older than 2 h; the admin `sweep` does the same. |
| Dedicated transcriber; OpenRouter for text only; pinned | `lib/config.ts` `MODELS` (one id each, no fallbacks). OpenRouter runs with `provider.zdr=true, data_collection=deny`, temperature 0 and seed 7. The `engine` field records the models on every job. |
| $2/job, $100/month, alert | **Reserve:** submit and retry reserve the estimate atomically (advisory lock). Running jobs count `max(cost, reserved)`. **Re-checks:** the bridge `claim` and every `cost` re-check the month. **Worker:** `guard` runs before each paid call and `charge` after. **Browser:** browser roles can't touch those columns (trigger). **Alert:** a month-cap block logs `sample_cost_cap_blocked`, which raises ops-alert key `sample_cost_cap`. |
| Fixed labels, versions | `CLIP_LABELS` = the v0.2 taxonomy; objection sub-labels are fixed; `schema_version` 1.0; `PIPELINE_VERSION` sr-2.0.0. |
| Smart clips + coaching (§2.6–2.7) | `lib/labels.ts`, step `clipsAndCoaching`; tests in `test/pipeline.test.ts` |
| Second pass on clips + coaching (§2.8) | `lib/qa.ts` `clipReasons`, `textPiiReasons`; step `verifySecondPass` |
| Test fixtures (§7) | **The set:** 12 synthetic dual-channel calls in `fixtures/calls`, with planted fictional PII. They include crosstalk, spoken dashes, bank and card numbers, health details, objections, a 47-min call, a numbers-not-PII control and long numbers spoken as words. **Rule tests:** `npm test`. **Real vendors:** `npm run eval` checks for 0 leaks and that labels are stable across 3 reruns. |
| Logs with no PII | `lib/log.ts` (ids and numbers only). Step I/O carries no text: transcripts, clips and coaching live in the private bucket between steps. Errors keep only a code. |
| Delete removes every copy | **Order:** the admin `delete {call_id}` sets the **tombstone first**; then `/api/delete` cancels runs and waits for them to stop; then the AssemblyAI transcripts are deleted; then both buckets are purged. **Library rows** stay as the take-down record, `withdrawn` and emptied of audio paths and generated text. **Late re-purge:** a durable `purgeLater` run purges again after 2h15m. **Status:** the job becomes `deleted` only when the worker answered 200. A 207 means try again later. |

### Deliberate deviations from SPEC v0.2

- **The bridge replaces the signed callback** (decided 2026-10-13, TR_PLAN updated). There are no service-side copies, no 7-day retention and no `GET /jobs/:id`; status lives on the job row in TR.
- **Second pass on clips is mapped, not re-transcribed.** Each clip is a cut of the redacted full audio that pass 2 transcribed, so a hit inside a clip window is the clip's hit. A third ASR pass per clip would add cost and find nothing new.
- **Digit runs skip counts and amounts** ("two kids", "$45.50 a month", "ten thousand dollars", "the 10,000 plan"). This applies only when the run is ≤4 digits or said as an amount. A long number is bleeped whatever word follows it.
- **Twilio-era recordings are out of v1.** The bridge returns `unsupported_source`.
- **Spelled-out letter runs (≥3) are always PII.**
- **Pitch-shift fallback:** without rubberband in the ffmpeg build, it uses resample+atempo, which isn't formant-preserving. It's off by default now.

### Review 2026-10-13 (head 31682c4), item by item

| # | Finding | Done |
|---|---|---|
| B1 | `create table if not exists` no-ops on RL-1 | Removed. `20261013050000_sample_redaction_worker.sql` uses `ALTER TABLE … ADD COLUMN` on RL-1 with no `if not exists`. It has preconditions (RL-1 applied, table empty, re-run refused) and keeps RL-1's status list (incl. `deleted`) and key check. |
| B2 | Own library tables | Dropped. Writes go to `training_library_calls` (`pending_qa`, `coaching` jsonb), `_call_sources` (`consent_id` FK) and `_clips`. Reviews go to `training_library_reviews`. |
| B3 | Own buckets | Dropped. RL-1's `sample-src` and `training-library` are used. |
| B4 | v0.2 §6–7 clips + coaching | Built (pipeline steps 7–8 above). The highlight is gone. |
| B5 | SPEC copy + defaults | `SPEC.md` = main's v0.2 byte for byte. Defaults: `pitch_shift_customer:false`; `clips {enabled, max_per_call 6, min_s 20, max_s 240}`; `coaching {enabled, rubric fe_v1}`. |
| B6 | Bridge vs callback | Dmitry chose the bridge. TR_PLAN is updated (RL-2 = `training-library-admin`, RL-3 = bridge), and `schema_version` "1.0" is on envelopes and job rows. |
| B7 | Patch based on ef56fd65 | Rebased on main. The migration version is new (the old `20261012230000` collided with `wl_m3_operator_telephony_flag`). Manifest is 2026-10-12.3. |
| N1 | Replay cache on `/api/delete` | No cache: every effect is idempotent within the 300 s window, as documented in `app/api/delete/route.ts`. |
| N2 | `/api/jobs` key vs job row | The key is required and the bridge `claim` compares it (`KEY_MISMATCH`). |
| N3 | 207 handling | The job becomes `deleted` only after a 200 from the worker; on a 207 the UI offers delete again. |
| N4 | `isQuantity` | Limited to runs ≤4 digits or said as an amount; regression tests cover the 11-digit spoken account number and the amounts. |
| N5 | MBI | Comment on the upper-case matching; the spoken-dash MBI is in a regression test and fixture 05. |
| N6 | Cap alert + estimate | ops-alert key `sample_cost_cap`. The admin and worker estimates use one formula (`lib/cost.ts` = `training-library-admin` `estimateJobUsd`). |
| N7 | ffmpeg binary ships | A `prebuild`/`pretest` gate (`scripts/check-ffmpeg.mjs`) fails the build if the binary is missing. Vercel runs install scripts. |

Also fixed: calls RLS limits an AM to their own book, so the pick list is server-side (`pick`), because AM curation is global.

## First validation (one command, nothing live)

```bash
cd sample-redactor
npm run validate                   # every check; the vendor eval runs only if keys are set
npm run validate -- --offline      # never call the vendors
npm run validate -- --skip-long    # vendor eval without the 47-min call
npm run validate -- --fresh        # clean npm ci for the worker and the frontend first
```

Keys come from the environment or `sample-redactor/.env.local` (gitignored); they are never printed.
It writes `fixtures/out/validation-<time>.md` (gitignored) plus per-check logs. Send that file back.
The vendor eval covers about 70 min of audio, transcribed three times (two channels plus the second pass), plus about 40 short LLM calls: roughly **$1.60** at $0.45/audio-hour, of which about $1 is the long call.

| Check | Proves |
|---|---|
| Worker: typecheck, unit tests, `next build` | Detectors, DSP, clips and coaching validation, second pass on clips and coaching text, HMAC, no-PII logs; the workflow bundle compiles; the ffmpeg binary is present. |
| Test calls | 12 synthetic dual-channel calls. |
| Local server | `/api/health` answers. `/api/jobs` and `/api/delete` refuse unsigned, wrong-secret, 10-min-old and tampered requests, and a bad key. The secret never reaches the log. |
| `deno check` + HMAC parity | The bridge, `training-library-admin` and ops-alert typecheck; the Deno and Node signers agree. |
| Migration on RL-1, throwaway Postgres (`supabase/tests/sample_redaction/run.sh`) | Caps and reservations; the two-session cap race (exactly one passes); AMs can't touch the worker columns; ingest is owner-only, path- and count-checked and idempotent; a takedown blocks resubmit, ingest and republish; RL-1's own cases still pass on top; rollback leaves RL-1 intact; re-apply. |
| RL-1 tests | Unchanged, as on main. |
| Repo wiring + hygiene | Manifest 2026-10-12.3 has both triggers; `verify_jwt` entries; rollback; no duplicate migration versions; no secrets, env files or audio. |
| Frontend | No new type errors (baseline 5); new files lint clean; edited files no worse than `main`; `vite build`. |
| Vendor eval (`npm run eval`, keys needed) | Real AssemblyAI + OpenRouter on all 12 calls. Fails on any planted value audible or left in the redacted transcript, any second-pass hit, invalid or unstable clip labels across 3 runs, PII in coaching text, or a crash. Over-bleeping on the strict calls 10 and 11 is reported. |

Outputs: `fixtures/out/*.redacted.mp3`, `*.clips/cN.mp3`, `*.redacted.txt`, `*.clips.json`, `*.coaching.json`, `eval-report.json`.

## For reviewers

Branch `feat/sample-redaction`: `git diff origin/main...feat/sample-redaction`. Suggested order:

1. `supabase/migrations/20261013050000_sample_redaction_worker.sql` (on RL-1) + `supabase/tests/sample_redaction/`.
2. `supabase/functions/sample-redaction-bridge/index.ts`: claim CAS, key check, run ownership, tombstone, cost ledger, 2h deadline, `complete` → `sample_library_ingest`.
3. `supabase/functions/training-library-admin/index.ts`: pick, submit, review evidence, publish, takedown.
4. `sample-redactor/workflows/redact-call.ts` + `steps.ts`.
5. `sample-redactor/lib/labels.ts` (clips + coaching), `lib/pii/detect.ts`, `lib/audio.ts`, `lib/qa.ts`.
6. `src/pages/admin/RecordingLibrary.tsx`, `src/components/recording-library/`.

Status: nothing applied or deployed. The deviations above are deliberate; anything else that differs from `SPEC.md` is a finding.

## Configuration

Worker (Vercel project `sample-redactor`, env var names only):
- **Required:** `TR_BRIDGE_URL` (= `https://<project>.supabase.co/functions/v1/sample-redaction-bridge`), `SAMPLE_REDACTOR_BRIDGE_SECRET`, `SAMPLE_REDACTOR_START_SECRET`, `ASSEMBLYAI_API_KEY`, `OPENROUTER_API_KEY`.
- **Optional:** `ASSEMBLYAI_SPEECH_MODEL`, `OPENROUTER_MODEL`. Changing either means bumping `PIPELINE_VERSION`.

TR (Supabase function secrets):
- **Required:** `SAMPLE_REDACTOR_URL`, `SAMPLE_REDACTOR_START_SECRET`, `SAMPLE_REDACTOR_BRIDGE_SECRET`. Each direction has its own secret.
- **Optional:** `SAMPLE_JOB_CAP_USD` (2), `SAMPLE_MONTH_CAP_USD` (100), `SAMPLE_ASR_USD_PER_HOUR` (0.45; set it to AssemblyAI's contracted rate, entity detection included).
- `TELNYX_API_KEY` already exists.

Prerequisites outside the repo:
- AssemblyAI and OpenRouter data agreements: zero retention, no training. Confirm the pinned OpenRouter model has a ZDR endpoint; otherwise every call fails closed.
- Supabase project upload limit ≥200 MB. RL-1's buckets have no per-bucket limit, so the project limit applies.
- Vercel: the worker's production domain must not sit behind Deployment Protection for `/.well-known/workflow/v1/webhook/*` (AssemblyAI calls it) or `/api/*` (HMAC-protected).
- At least one `agent_training_consents` row (RL-6, or recorded offline) before the first submit.

## Rollout order (each step its own go)

1. Apply `supabase/migrations/20261013050000_sample_redaction_worker.sql` (`apply-migration` skill, after RL-1). Then redeploy `integrity-audit`: manifest 2026-10-12.3 expects the two new triggers, so deploying it first would alarm.
2. Set the TR secrets. Deploy `training-library-admin`, `sample-redaction-bridge` and `ops-alert` (new `sample_cost_cap` key).
3. Create the Vercel project from `sample-redactor/`, set its env, deploy, and check `GET /api/health`.
4. Deploy the frontend: `/am/recording-library` and `/admin/recording-library`, hidden while the flag is off.
5. Arm `recording_library` (FLAGS §76). Pilot: 5 internal calls with offline consent. `ffprobe` the channel order and sample rate, and listen to every file and clip end to end. Then mark the channel map verified (follow-up).

Rollback, in order:
1. Disarm `recording_library`. Submit is refused from then on.
2. Unset `SAMPLE_REDACTOR_URL`, or delete the Vercel project.
3. Undeploy the two functions and redeploy the previous `ops-alert`.
4. Run `scripts/rollbacks/rollback_20261013050000_sample_redaction_worker.sql`. RL-1 stays as it is.
5. Revert manifest 2026-10-12.3.
