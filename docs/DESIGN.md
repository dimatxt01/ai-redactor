# Design: pipeline, requirements, deviations

The contract is SPEC v0.2 ([`truering/docs/recording-library/SPEC.md`](../truering/docs/recording-library/SPEC.md), byte-identical to TrueRing main) and TR_PLAN ([`truering/docs/recording-library/TR_PLAN.md`](../truering/docs/recording-library/TR_PLAN.md)).
Paths below are in this repo; TrueRing-side files live under `truering/` at their TrueRing paths.

## Pipeline (one run per job inside the worker process, `lib/job.ts`)

1. **claim**: the worker's `poll` hands out queued jobs; `claim` is a compare-and-swap on the job, and the key must match the job row. Only one run can own a job; a worker that loses the race drops it at once. Re-checks the month cap and starts the heartbeat.
2. **fetch**: a fresh Telnyx link via the bridge, downloaded at once and never stored.
   - Probe: 2 channels, ≤60 min, length within ±5% of `calls.duration` (a miss is a QA flag).
   - Over 60 min fails as `bad_audio: too_long`.
3. **ASR pass 1**: AssemblyAI with a pinned model, `multichannel`, entity detection and word timestamps. The worker polls the status with its own key (no inbound webhook).
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
   - `sample_library_ingest` then writes, in one transaction: the job as `done`, plus `training_library_calls` (`pending_qa`), `_call_sources` (`consent_id` stays NULL: no consent gate, Dmitry 12:44 PM) and `_clips`, with the job's vertical.
   - Scratch is emptied and AssemblyAI's transcripts are deleted.

**Human gate.** The publish gate allows publish only when the latest review is `approve` with `listened_full` (no consent check). On top of that, `training-library-admin` requires that the reviewer opened the full call **and every exported clip**, checked against the access log. The UI also unlocks the checkbox only after ≥98% continuous playback of each.

Every JSON result is an envelope `{schema, schema_version: "1.0", pipeline_version, job_version, call_id, items}`, and every job row carries `schema_version` too. Audio carries `"<pipeline_version> job_v<n>"` in its ID3 comment.

## How the service notes and SPEC v0.2 are met

| Requirement | Where |
|---|---|
| Separate channels; TR says which is the customer | **Submit dialog:** the channel choice is stored in `call_meta.channel_map`. Every result is QA-flagged `channel_map_unverified` until the pilot confirms the order. |
| Same call or a duplicate start does nothing twice | **Key:** `call:<id>:v<n>` (DB check: key = call_id + version), and submit returns the existing job. **Bridge:** `claim` is a compare-and-swap and checks the key; `run_id` is required on every action. **Idempotent:** `complete` (ingest replay) and `fail`, and the cost ledger per item. |
| ≤60 min calls, 2 h per job | Submit and fetch reject calls over 60 min (`too_long`). The bridge fails any job older than 2 h; the admin `sweep` does the same. |
| Dedicated transcriber; OpenRouter for text only; pinned | `lib/config.ts` `MODELS` (one id each, no fallbacks). OpenRouter runs with `provider.zdr=true, data_collection=deny`, temperature 0 and seed 7. The `engine` field records the models on every job. |
| $2/job, $100/month, alert | **Reserve:** submit and retry reserve the estimate atomically (advisory lock). Running jobs count `max(cost, reserved)`. **Re-checks:** the bridge `claim` and every `cost` re-check the month. **Worker:** `guard` runs before each paid call and `charge` after. **Browser:** browser roles can't touch those columns (trigger). **Alert:** a month-cap block logs `sample_cost_cap_blocked`, which raises ops-alert key `sample_cost_cap`. |
| Fixed labels, versions | `CLIP_LABELS` = the v0.2 taxonomy; objection sub-labels are fixed; `schema_version` 1.0; `PIPELINE_VERSION` sr-2.0.0. |
| Smart clips + coaching (§2.6–2.7) | `lib/labels.ts`, step `clipsAndCoaching`; tests in `test/pipeline.test.ts` |
| Second pass on clips + coaching (§2.8) | `lib/qa.ts` `clipReasons`, `textPiiReasons`; step `verifySecondPass` |
| Test fixtures (§7) | **The set:** 12 synthetic dual-channel calls in `fixtures/calls`, with planted fictional PII. They include crosstalk, spoken dashes, bank and card numbers, health details, objections, a 47-min call, a numbers-not-PII control and long numbers spoken as words. **Rule tests:** `npm test`. **Real vendors:** `npm run eval` checks for 0 leaks and that labels are stable across 3 reruns. |
| Logs with no PII | `lib/log.ts` (ids and numbers only). Nothing the worker holds between steps is text: transcripts, clips and coaching live in TR's private `sample-src/<job_id>/` between steps. Errors keep only a code. |
| Cancel and delete (TR side only) | **Cancel** (admin): TR sets the call's queued and running jobs to `failed: cancelled`. The worker sees them in its next poll's `stop` list and aborts. It doesn't call `fail`, purges, deletes its AssemblyAI copies and reports `vendor_purged`, which clears the heartbeat. **Delete** (admin): a hard delete in TR; the worker is never called. It is refused (`409 IN_FLIGHT`) while a job runs, a heartbeat is fresh, or AssemblyAI ids are still recorded. So the worker's vendor cleanup (end of job, the `cleanup` list for dead runs) is what unblocks it. Afterwards the bridge answers `404 NO_JOB`, which the worker treats as stopped (no `fail`, no report). **Orphans:** a transcript whose id never reached TR (a worker killed between submit and the `asr` record) is deleted by the worker's orphan sweep: anything on its dedicated AssemblyAI account older than 2 h 15 m. |

## Deliberate deviations from SPEC v0.2

- ~~The bridge replaces the signed callback~~: no longer a deviation. SPEC v0.2's delivery was revised on 2026-10-13 to the pull-through-bridge flow as built (review of 4f7ad9a). There are no service-side copies, no 7-day retention, no `GET /jobs/:id` and no callback; status lives on the job row in TR.
- **Second pass on clips is mapped, not re-transcribed.** Each clip is a cut of the redacted full audio that pass 2 transcribed, so a hit inside a clip window is the clip's hit. A third ASR pass per clip would add cost and find nothing new.
- **Digit runs skip counts and amounts** ("two kids", "$45.50 a month", "ten thousand dollars", "the 10,000 plan"). This applies only when the run is ≤4 digits or said as an amount. A long number is bleeped whatever word follows it.
- **Twilio-era recordings are out of v1.** The bridge returns `unsupported_source`.
- **Spelled-out letter runs (≥3) are always PII.**
- **Pitch-shift fallback:** without rubberband in the ffmpeg build, it uses resample+atempo, which isn't formant-preserving. It's off by default now.

## Review 2026-10-13 (head 31682c4), item by item

| # | Finding | Done |
|---|---|---|
| B1 | `create table if not exists` no-ops on RL-1 | Removed. `truering/supabase/migrations/20261013090000_sample_redaction_worker.sql` uses `ALTER TABLE … ADD COLUMN` on RL-1 with no `if not exists`. It has preconditions (RL-1 applied, table empty, re-run refused) and keeps RL-1's status list (incl. `deleted`) and key check. |
| B2 | Own library tables | Dropped. Writes go to `training_library_calls` (`pending_qa`, `coaching` jsonb), `_call_sources` (`consent_id` FK) and `_clips`. Reviews go to `training_library_reviews`. |
| B3 | Own buckets | Dropped. RL-1's `sample-src` and `training-library` are used. |
| B4 | v0.2 §6–7 clips + coaching | Built (pipeline steps 7–8 above). The highlight is gone. |
| B5 | SPEC copy + defaults | `truering/docs/recording-library/SPEC.md` = main's v0.2 byte for byte. Defaults: `pitch_shift_customer:false`; `clips {enabled, max_per_call 6, min_s 20, max_s 240}`; `coaching {enabled, rubric fe_v1}`. |
| B6 | Bridge vs callback | Dmitry chose the bridge. TR_PLAN is updated (RL-2 = `training-library-admin`, RL-3 = bridge), and `schema_version` "1.0" is on envelopes and job rows. |
| B7 | Patch based on ef56fd65 | Rebased on main. The migration version is new (the old `20261012230000` collided with `wl_m3_operator_telephony_flag`). Manifest is 2026-10-12.3. |
| N1 | Replay cache on `/api/delete` | Moot since the pull model: the worker has no endpoints. |
| N2 | `/api/jobs` key vs job row | The bridge `claim` compares the key (`KEY_MISMATCH`); since the pull model the key also comes from the bridge itself. |
| N3 | 207 handling | Moot: there is no worker delete endpoint any more. TR refuses a delete until the worker has reported every AssemblyAI copy gone (`409 IN_FLIGHT`). |
| N4 | `isQuantity` | Limited to runs ≤4 digits or said as an amount; regression tests cover the 11-digit spoken account number and the amounts. |
| N5 | MBI | Comment on the upper-case matching; the spoken-dash MBI is in a regression test and fixture 05. |
| N6 | Cap alert + estimate | ops-alert key `sample_cost_cap`. The admin and worker estimates use one formula (`lib/cost.ts` = `training-library-admin` `estimateJobUsd`). |
| N7 | ffmpeg binary ships | `scripts/check-ffmpeg.mjs` runs as `postinstall` (so `npm ci` and the Docker build fail without the binary) and before tests; the worker's startup self-check runs it too. |

Also fixed: calls RLS limits an AM to their own book, so the pick list is server-side (`pick`), because AM curation is global.

## After the review: repo split (2026-10-13)

The worker is its own repo (this one), deployed separately. TrueRing's side now lives on `Mahamadou2004/truering` `prb/rl-worker` (it replaced `feat/sample-redaction` / #348); `truering/` here is a mirror of it (refreshed TrueRing → here with `refresh.sh`; never applied from here), and `check.sh` verifies a TrueRing checkout.
The end-to-end simulation (`npm run simulate`) found one worker defect, now fixed: a job row whose `options` lacked `bleep_pad_ms` produced NaN bleep intervals, i.e. nothing bleeped (the second pass did flag it). `lib/options.ts` now fails every redaction setting safe, with tests in `test/options.test.ts`.

## Review of 4f7ad9a (2026-10-13), item by item

Decision: results come back by pull through `sample-redaction-bridge`, as built. No callback.

| # | Asked | Done |
|---|---|---|
| 1 | SPEC.md: drop the signed callback, describe pull-through-bridge | SPEC is TrueRing's document, so it changed on TrueRing branch `feat/sample-redaction` and this repo's copy was refreshed. **Changed:** the start body (ids only); the bridge `job` / `sign` / `status` / `complete` / `fail` actions, with the actual `complete` payload; storage on TR's side only; takedown via `/api/delete`. **Removed:** the callback, `GET /jobs/:id`, the 7-day service copies and the n8n section. TR_PLAN's status line was updated to match. |
| 2 | `truering/` is a reference copy only | `truering/README.md` and the root README say so first. `install.sh` (which applied it from here) is removed. `refresh.sh` copies one way, TrueRing → here, and `check.sh` only reads a TrueRing checkout. Applying happens only from `Mahamadou2004/truering`. |
| 3 | (superseded: no Vercel, no Workflow log; see below) Minimum Workflow log retention; ids, hashes and counts only | Every `start()` (the job run, and both `purgeLater` starts) passes `RUN_OPTIONS = { experimental_retention: 0 }`. The World deletes a run's inputs, outputs and event payloads as soon as it ends, keeping only ids, timestamps, status and step names. The simulation checks every run carries `$retention: "0"` and that finished runs keep no payloads. Still-sleeping `purgeLater` runs keep theirs (job ids) until they end. Step I/O stays ids, hashes, counts and offsets, checked by the simulation's decoded event-log scan. |
| 4 | (superseded: Docker image; see below) ffmpeg ships in the Vercel build | **Verified on Vercel:** the build log shows `ffmpeg-static ok: /vercel/path0/node_modules/ffmpeg-static/ffmpeg`. On the preview, `GET /api/health` (served by the same function bundle as `/api/jobs` and `/api/delete`) reported `ffmpeg: { ok, version 7.0.2-static, linux-x64, 79.8 MB }` and `rubberband: true`. **Per function:** a `vercel build` shows every function traces `node_modules/ffmpeg-static/ffmpeg`, including the workflow's `flow.func`. **Health:** now answers 503 when the binary is missing. **package.json:** gets `allowScripts` for `ffmpeg-static@5.3.0`, because Vercel's npm 11 warned that its install script wasn't approved (it still ran), and `engines.node` is pinned to `22.x`, because `>=22` had built on Node 24. |
| 5 | Stale "sample-work bucket" comment | `lib/steps.ts` (was `workflows/steps.ts`) now says TR's `sample-src/<job_id>/` scratch prefix. |
| Rule | Input/output only | Unchanged and still met: no database, tables, buckets or Supabase key in the worker. |

## 2026-10-13: plain Node worker, pull model (Vercel and the Workflow SDK removed)

Asked by Dmitry: "I was envisioning the service as just a node background worker".
- **Runtime.** `src/worker.ts` is one long-running process. `lib/job.ts` runs a job start to finish, and `lib/retry.ts` retries steps with the old rule (anything but `FatalError`, up to 4 tries).
- **Waiting on AssemblyAI.** The worker polls AssemblyAI's status with its own key, so there's no webhook. Detection, DSP, clips, coaching and QA in `lib/` are unchanged.
- **Gone:** the Next.js routes `/api/jobs`, `/api/delete` and `/api/health`, the `purgeLater` timer runs, the Workflow event log and its retention setting, `vercel.json` and the Vercel project.
- **Connection.** The worker calls the bridge's new `poll` action every 20 s. It holds no URL TrueRing calls, and needs one secret (`SAMPLE_REDACTOR_BRIDGE_SECRET`); `SAMPLE_REDACTOR_URL` and `SAMPLE_REDACTOR_START_SECRET` are gone.
- **Liveness.** `heartbeat_at`, a new column in the staged migration, guarded like the other worker columns, is refreshed by every poll. A running job whose heartbeat is older than `SAMPLE_WORKER_STALE_S` (300) is failed by the bridge, with its files purged. Its vendor ids go to the next poll's cleanup list. A job's own run reports `vendor_purged` last, which ends its heartbeat (and is what lets TR delete the call).
- **Why no late re-purge any more.** The Workflow design re-purged 2h15m later because a retried step elsewhere could still upload. Here a job's steps run in one process and every upload is awaited, so when a run returns nothing of it is in flight. TR's hard delete also purges both buckets before and after removing the rows.
- **Restarts.** SIGTERM aborts running jobs, which fail as `internal: worker restarted` (the AM retries) and report their vendor copies before the process exits. SIGKILL is covered by the stale-heartbeat path.
- **Proof** (`npm run simulate`, 96 checks at the time): two workers racing, a takedown mid-run (since replaced by cancel), a worker killed mid-run (the bridge fails it, the other worker cleans up, retry finishes it), and SIGTERM. A production-only install (`npm ci --omit=dev`, the Dockerfile's steps) passes the self-check. The Docker image itself was not built here, because Docker Desktop was waiting on a prompt.

## 2026-10-13: aligned with TrueRing `prb/rl-worker` @ 1ea55f37 (cancel, hard delete, every vertical, no consent)

The TrueRing side's source of truth is now `prb/rl-worker`; it merged #347/#349 and replaced #348. The mirror was refreshed from it (`truering/SOURCE`).
- **Protocol unchanged.** Pull model, one HMAC direction, `poll` plus the per-job actions; `lib/bridge.ts` `Poll` matches.
- **Cancel.** It reaches the worker through `poll` (`stop`); the existing sequence is kept exactly: abort as "stop", no `fail`, purge, delete the AssemblyAI copies, `vendor_purged`.
- **Hard delete on TR's side.** A missing row answers `404 NO_JOB`. `lib/bridge.ts` maps it to a fatal `NO_JOB` error, and `lib/job.ts` treats it as stopped: no `fail`, no `purge`, no report. The worker still deletes its AssemblyAI copies. The cleanup path logs `cleanup_job_gone`. Tests: `test/bridge.test.ts`.
- **Every vertical.** The job's `call_meta.vertical` (`final_expense` | `medicare` | `aca`, set by TR) is read at claim and never defaulted; an unknown one fails the job. The clips + coaching prompt names the job's line of insurance. Rubric `fe_v1` for all three until Dmitry rules on per-vertical rubrics.
- **No consent.** The worker never touched consent; the docs and the simulation no longer mention it.
- **New: AssemblyAI orphan sweep.** The new crash scenario showed it was needed: a worker killed between AssemblyAI's submit and the bridge `asr` record leaves a transcript whose id TR never learns. It would sit at the vendor forever, and it doesn't block a delete, since the row shows no ids. Every `ORPHAN_SWEEP_S` (1800) the worker lists its account's transcripts and deletes those older than `ORPHAN_AGE_S` (8100 = 2 h 15 m, past the 2 h job deadline), never touching ids of its own running jobs. This requires an AssemblyAI key used by this worker only. Tests: `test/assemblyai-list.test.ts`, plus a deterministic simulation case.
- **Hosting.** `deploy/docker-compose.yml` (restart unless-stopped, read-only root, tmpfs `/tmp`, json-file log rotation) and `deploy/ai-redactor.service` (systemd, `Restart=always`, the self-check before every start). ffmpeg-static is per-architecture; `npm run check` runs on the host or inside the image.
- **Proof.** `npm run simulate`, 102 checks: hard delete (admin only, rows and files gone, spend kept in the ledger, then `NO_JOB`); cancel mid-run → stop → `vendor_purged` → delete (refused while in flight); refusal of not-ended calls and of agents with two or no verticals; a Medicare call whose prompt names Medicare; the orphan sweep. TR-side checks (`truering/check.sh`) pass on `prb/rl-worker` @ 1ea55f37.

## 2026-10-13: first real-vendor eval (AssemblyAI universal-3-5-pro, OpenRouter gemini-2.5-flash), and sr-2.1.0

**Redaction passed on all 12 synthetic calls.** No planted value was audible in any redacted call or clip, none was left in a transcript or in coaching text, and the second pass found nothing.

**Clip labeling failed on 6 calls, all of them labeling problems, none a privacy problem:**
1. **11 (44 s): invented line ids.** The prompt allowed 6 clips of ≥20 s in a 44 s call, so the model invented ids to fill the quota, and the whole answer was rejected.
2. **03, 12 (85% bleeped): no clip.** No window existed that didn't start or end inside a bleep.
3. **05, 09, 10: labels unstable across 3 reruns,** with one label differing.

**Fixed in sr-2.1.0:**
- **Clip cap** (`clipCap`): one minimum-length clip per 20 s of audio, and the prompt says "never more".
- **Repair, not reject** (`repairAnswer`): a bad clip is repaired (sub-label, confidence, scores, key lines) or dropped, with the reason recorded. The rest of the answer stands, and only call-level problems are retried.
- **One preferred provider:** OpenRouter `provider.order = ["google-vertex"]` (fallbacks still allowed, ZDR still required). Reruns see the same model build.
- **Eval rule narrowed:** a call may have no clip when it can hold at most one, or when every proposed window would start or end inside a bleep. My earlier "always ≥1 clip" was a heuristic of mine, not SPEC ("up to 6").
- **`npm run eval -- --llm-only`:** re-checks labels on the cached redacted lines (`fixtures/out/<call>.lines.json`, gitignored) for cents.

**Result on sr-2.1.0:** the five failing short calls (03, 05, 09, 11, 12) passed, stable across 3 reruns (09 now gives the same 6 labels every time), still with no leaks. Not yet rerun on sr-2.1.0: the 47-min call 10 (its own failure was one unstable label) and the six calls that already passed on sr-2.0.0.
