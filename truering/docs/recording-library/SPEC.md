# True Ring: Recording Redaction + Coaching Service, spec v0.2 (2026-10-12, revised after Dmitry's 6:27 PM answers)

This is an external service that Dmitry builds separately (dimatxt01/ai-redactor: a plain Node background worker in one container, with ffmpeg, AssemblyAI and OpenRouter text models; it opens no port, polls TR's `sample-redaction-bridge` for work and returns results through it, no callback). True Ring (TR) sends it calls privately; it returns PII-bleeped audio and transcripts; TR AMs/admins pick sales calls and, after a human QA listen, publish the results to an internal **training** Recording Library (smart clips of the key sale moments plus AI coaching notes).
Status: draft. **2026-10-13: return path is PULL via `sample-redaction-bridge` (no signed callback), see §3/§4.** Based on read-only prod/repo scoping on 2026-10-12. SPEC is design. TR-side code is *in `prb/rl-worker` (PR #347), not on main, not deployed* (pull model, ai-redactor f282201); nothing on main, nothing in prod.

## 1. Input contract (from real data)

Source: `public.calls`. 44,072 rows have a recording. Fields:

| field | type | notes |
|---|---|---|
| `id` | uuid | the TR call id; the idempotency key is built from it |
| `recording_url` | text | Telnyx S3 presigned link `https://s3.amazonaws.com/telephony-recorder-prod/<conn>/<YYYY-MM-DD>/<uuid>-<ts>.mp3?X-Amz-...&X-Amz-Expires=600`. **Expires after 10 min.** 1,644 older rows are `api.twilio.com` links. |
| `duration` | int, seconds | Sales average ~36 min; 955 sales are 10–40 min |
| `disposition_id` | uuid | → `call_dispositions.name` (`Sale`, `Quoted/Did Not Close`, `Callback Requested`, …). 1,837 recorded sales. |
| `agent_id` | uuid | → `agents`. 537 agents have recordings; the top agents have 38–82 sales each. |
| vertical | text[] | `agents.verticals` (`final_expense`, `medicare`, `aca`); almost all are `{final_expense}`. `calls.campaign_id` is usually null. |
| `transcription`, `ai_summary` | text | the existing Gemini output; it can help pick calls but is **not** used for redaction |

Audio:
- Container/codec: **MP3**, recorded with Telnyx `record_start {format:'mp3', channels:'dual'}` (from telnyx-voice and lane-router).
- Channels: **2, one leg per channel**. Which channel is the customer and which is the agent: **unknown/verify**.
- Sample rate and bitrate: **unknown/verify**. The latest URL had already expired when probed, so no headers could be read. Expect 8 kHz telephony audio.

Fetching:
- TR never sends a stored URL as-is.
- Before submitting, TR gets a fresh link from Telnyx, the same way `recording-proxy` / `_shared/recordingUrl.ts` do.
- Preferred: copy the file into a private TR bucket (`sample-src/`) and send a **Supabase signed URL, valid 15 min**.
- The service must download it right away and must not store the URL.

Sample submit payload:
```json
{
  "job_id": "srj_01J…",
  "idempotency_key": "call:2948f3a3-d352-4e3b-8976-1af6b7fb0230:v1",
  "call": {
    "id": "2948f3a3-d352-4e3b-8976-1af6b7fb0230",
    "duration_s": 764,
    "disposition": "Sale",
    "agent_ref": "agent_7",
    "vertical": "final_expense",
    "recorded_at": "2026-10-12T22:44:01Z"
  },
  "audio": {
    "url": "https://<project>.supabase.co/storage/v1/object/sign/sample-src/…?token=…",
    "expires_at": "2026-10-12T23:10:00Z",
    "format": "mp3",
    "channels": 2,
    "channel_map": { "customer": 0, "agent": 1 }
  },
  "options": {
    "bleep_pad_ms": 250,
    "pitch_shift_customer": false,
    "clips": { "enabled": true, "max_per_call": 6, "min_s": 20, "max_s": 240 },
    "coaching": { "enabled": true, "rubric": "fe_v1" },
    "extra_terms": ["<agent first/last name>", "<carrier names>"]
  },
  "bridge": "the worker reads this job and writes results only via sample-redaction-bridge (§4); there is no callback_url"
}
```
- `agent_ref` is a pseudonym. The service never receives agent names except in `extra_terms`, which are the terms to bleep.
- `channel_map` stays "verify" until the pilot has confirmed it.

## 2. Processing

1. Download the audio, check the duration against `duration_s` (±5%), and split it into its two channels.
2. **Transcribe** each channel with **word-level timestamps** and diarization by channel. Options: AssemblyAI (with built-in PII audio redaction), Deepgram Nova (`redact=pii,numbers`), or AWS Transcribe Call Analytics. An LLM via OpenRouter can be used **only** for classifying entities on top of a timestamped transcript, never for producing the timestamps.
3. **PII entities:**
   - person names (the customer's and the agent's, plus `extra_terms`);
   - phone numbers;
   - street address, city and ZIP;
   - date of birth and age plus birthday;
   - SSN;
   - card and bank numbers (PAN, routing, account), CVV and expiry;
   - email;
   - policy and application numbers;
   - health conditions and medications (on by default);
   - beneficiary names.
   - **MBI** (Medicare ID), normalized after removing spaces and dashes: `\b[1-9][AC-HJKMNP-RT-Yac-hjkmnp-rt-y][AC-HJKMNP-RT-Yac-hjkmnp-rt-y0-9][0-9][AC-HJKMNP-RT-Yac-hjkmnp-rt-y][AC-HJKMNP-RT-Yac-hjkmnp-rt-y0-9][0-9][AC-HJKMNP-RT-Yac-hjkmnp-rt-y]{2}[0-9]{2}\b`.
   - **Spelled-out digits and letters:** before matching, turn number words into digits ("five five five", "double-oh", "oh" → 0) and phonetic alphabets ("A as in apple") into characters. Then treat any run of **≥4 digits within 8 s**, even across speaker turns, as PII.
4. **Bleep:**
   - Replace each span with a 1 kHz tone at -12 dBFS, padded **250 ms** each side (allowed range 200–300 ms).
   - Merge spans less than 500 ms apart.
   - Apply the bleep on **both channels** at the same time, because the read-back echo also leaks.
5. **Optional pitch-shift** of the customer channel (±2–3 semitones; default **off** for internal training), then mix down to mono.
6. **Smart clips (segmentation):**
   - An LLM (via OpenRouter; text only) reads the timestamped, already-redacted transcript and labels segments from a fixed set: `opener`, `rapport`, `discovery` (health/needs), `budget`, `presentation` (quote/benefits), `objection` (with sub-label, e.g. `price`, `think_about_it`, `spouse`), `close` (ask/commitment), `application` (data capture), `wrap_up`.
   - Each segment snaps to sentence boundaries, gets a 1 s fade, and must not start or end inside a bleep. There are 20–240 s per clip and at most 6 clips per call.
   - Segments are cut from the **redacted** audio only.
   - The `application` segment is the densest in PII. Default: label it but **do not export audio** (`audio_exported:false`), coaching text only.
7. **Coaching notes:**
   - **Per clip:** what the agent did, what worked, what to improve, a quote of 1–2 key lines (redacted text), and a score of 1–5 on a fixed rubric (`fe_v1`: rapport, discovery depth, objection handling, assumptive close, compliance language).
   - **Per call:** the outcome (`Sale`), a 3–5 sentence summary of how the sale went, top 3 strengths, top 3 improvements, overall rubric scores, and the key turning point (with clip reference).
   - Coaching is generated from the redacted transcript only and must not invent or restore PII. The output is checked by the same regex pass as step 8.
8. **Second pass:**
   - Transcribe the *redacted* audio again.
   - Rerun the digit-run and MBI checks and the name list, on the full redacted audio, every clip, and all coaching text.
   - Any hit → `qa_flag=true`, with the reasons listed.
9. **QA flag** is also set when:
   - average word confidence is under 0.85;
   - any PII span has confidence under 0.7;
   - crosstalk is over 10%;
   - the length check fails.
   - Every output still needs a human listen in TR (§5), whatever the flag says.

## 3. Output contract

- **Audio:** `redacted.mp3` (full call, mono, 44.1 kHz/128 kbps) for QA, plus `clips/<n>.mp3` for each exported clip. Optionally a lossless `redacted.wav` for QA.
- **Clips:** `clips.json` = `[{clip_id, label, sub_label, start_ms, end_ms, audio_exported, title, coaching:{did, worked, improve, key_lines[], scores{}}, confidence}]`.
- **Coaching:** `coaching.json` = `{summary, strengths[], improvements[], scores{rapport,discovery,objections,close,compliance}, turning_point_clip_id, rubric:"fe_v1", model}`.
- **Transcript:** JSON of `[{channel, speaker:"customer"|"agent", start_ms, end_ms, text}]`. Redacted words appear as `[REDACTED:<TYPE>]`. A `.txt` render is also provided.
- **PII spans:** `[{type, start_ms, end_ms, channel, confidence, detector:"model"|"regex"|"digit_run"|"extra_term", padded_start_ms, padded_end_ms}]`. They contain **no original text**.
- **Status:** `queued` → `fetching` → `transcribing` → `redacting` → `verifying` → `done` | `failed` (with `error_code`: `fetch_expired` | `bad_audio` | `asr_failed` | `timeout`).

**Return path: PULL through `sample-redaction-bridge` (decided by Dmitry 2026-10-13; there is no signed callback).**
- The worker holds no Supabase key and no storage of its own. It calls TR's HMAC edge function `sample-redaction-bridge` with one `job_id` per call. Actions: `poll` (no job id) and, per job, `job | claim | source | sign | status | cost | asr | complete | fail | purge | vendor_purged`.
- **TR never calls the worker.** Every ~20 s (`POLL_S`) the worker calls `poll`: it gets queued jobs to claim, refreshes `heartbeat_at` on the jobs it runs, gets the ones to `stop` (failed elsewhere, cancelled or gone), and gets finished jobs whose AssemblyAI copies still need deleting. A running job whose heartbeat is older than `SAMPLE_WORKER_STALE_S` (default 300) is failed by the bridge. Load: about 130k function calls a month.
- `claim` is a compare-and-swap on status + `workflow_run_id`: the first run owns the job, and every later action must carry that run id (exactly-once).
- `source` returns a fresh Telnyx link; `sign` returns signed upload/download URLs scoped to `sample-src/<job_id>/` and `training-library/<job_id>/` only. Audio never passes through the bridge.
- The worker uploads `redacted.mp3`, `clips/<n>.mp3`, `clips.json`, `coaching.json`, transcript and `pii_spans.json` straight into `training-library/<job_id>/`.
- `complete` checks every file is uploaded, then `public.sample_library_ingest` writes the job row, `training_library_calls`, `_call_sources` and `_clips` in one transaction (idempotent per job). `fail` records `error_code`. The `sample-src` scratch is deleted when the job ends.
- Every payload carries `schema_version` "1.0", `qa_flag`, `qa_reasons`, `metrics` and `engine` as above.

## 4. Integration

**Auth:**
- Worker → bridge uses an HMAC-SHA256 header: `X-TR-Signature: t=<unix>,v1=<hex(hmac(secret, t + "." + raw_body))>`.
- Reject requests outside ±5 min.
- One secret, `SAMPLE_REDACTOR_BRIDGE_SECRET`, in Supabase function secrets and the worker container's env only. There is no TR → worker direction (the worker opens no port), so no `SAMPLE_REDACTOR_URL` / `SAMPLE_REDACTOR_START_SECRET`.

**Lifecycle:**
- Submit (`training-library-admin`) only queues the job; the same `idempotency_key` returns the existing job; `:v2` forces a reprocess. The worker claims it on its next poll.
- There is no callback. The worker reports `status`, `complete` and `fail` through the bridge; its steps retry (4 tries) and bridge actions are idempotent per job and run.
- `fetch_expired` → retry queues the job again with the same key; the bridge's `source` hands out a fresh link.
- **Cancel** (admin/superadmin, Dmitry 2026-10-13 1:41 PM): marks the call's queued/running jobs `failed:cancelled`; the worker aborts the run when the next poll lists it in `stop`. The worker has no cancel endpoint and nothing is deleted on its side; the run may still report spend already incurred.
- A job running over 2 h is marked `failed:timeout`.
- **Flag `recording_library`:** gates submit, retry, pick, link, review, publish and edit (403 `FLAG_OFF`). The bridge's `poll` hands out no jobs while OFF (`jobs: []`); stop and cleanup still run. `claim` while OFF ends a still-queued job as `failed:cancelled` (409 `JOB_TERMINAL`). Browser roles have no INSERT/UPDATE on `sample_redaction_jobs` or on the library rows (calls, call sources, clips, reviews); all those writes are service_role through the edge functions. Cancel, delete, sweep and withdraw stay ungated, so stopping and cleanup work with the flag OFF. The flag goes ON only after the worker's `check.ts --bridge` printed `"ok": true` and its alive file is fresh (≤180 s); otherwise submits sit queued and hold their cost reservation until the 2 h sweep.
- **Deploy order:** the migration goes before the `integrity-audit` redeploy (manifest 2026-10-12.3).

**Storage:**
- RL-1 private buckets only: `sample-src/<job_id>/` (scratch, deleted when the job ends) and `training-library/<job_id>/` (results). Served only as short-lived signed URLs.
- **The service keeps nothing**: no database, tables, buckets or KV; `/tmp` scratch per step is removed; AssemblyAI copies are deleted on success and failure. Container logs hold ids, hashes and counts only.

**Proposed TR tables (not created):**
- `sample_redaction_jobs`: id, call_id, idempotency_key unique, status, qa_flag, qa_reasons jsonb, metrics jsonb, engine jsonb, submitted_by, timestamps.
- `training_library_calls`: id, call_id, job_id, version, agent_ref (pseudonym), source_agent_id (admin-only column), vertical, duration_s, full-audio path and sha256, `coaching` jsonb, title, tags, `status` (`pending_qa` | `published` | `rejected` | `withdrawn`).
- `training_library_clips`: id, library_call_id, label, sub_label, start_ms, end_ms, audio path (nullable when not exported), sha256, title, `coaching` jsonb, sort order.
- **Staff-only columns (RL-1 rule):** `call_id` and `source_agent_id` are readable by AMs/admins only; agents never read them (RLS/view excludes them; storage paths use `job_id`, never `call_id`).
- `training_library_reviews`: append-only `(library_call_id, reviewer, decision, listened_full bool, notes, at)`. **Publishing requires one QA review with `listened_full=true`** (full call plus every clip).
- `training_library_ratings`:
  - Columns: id, agent_id, item_type (`call` | `clip`), item_id, `vote smallint check (vote in (-1,1))` (+1 = green up arrow, -1 = red down arrow), comment text (optional, ≤1000 chars), created_at, updated_at.
  - Unique `(agent_id, item_type, item_id)`, so a repeat rating is an upsert.
  - RLS: an agent can select/insert/update only rows where `agent_id = auth.uid()`; AM/admin can select all. No delete for agents (they can edit instead).
  - Internal record only. **Never shown to other agents**: no aggregates in the agent UI. This table is TR-side only; the service never sees it.
- Manifest: a view joining the above with hashes, for audits and withdrawal.
- `sample_spend_ledger` (service_role only): job_id, UTC month, usd of hard-deleted jobs, so a delete never resets the month cap. No call content.

**UI** (see TR_PLAN.md): an AM/admin curation page (pick, submit, status, QA listen, publish/withdraw) and a read-only **Recording Library** tab for agents (clip list by label, player, coaching notes).

## 5. Security and compliance (internal training only)

- **Scope:** ended `Sale` calls of **every vertical** (final_expense, medicare, aca), Dmitry 2026-10-13 12:44 PM. The vertical comes from the call's agent (`agents.verticals`); an agent with no or several verticals is refused, never defaulted (Dmitry 1:41 PM).
- **Use:** internal training for logged-in TR agents, AMs and admins only. No marketing, public or buyer-facing use. That removes the CMS marketing-material question, the external legal approval of each item, and the public player. If use ever becomes external, the old marketing controls come back.
- **Still required:**
  - **PII redaction + a human QA listen of every published full call and clip.** One miss exposes a consumer's PII to the whole agent base.
  - **Agent consent: not required** (Dmitry 2026-10-13 12:44 PM): no consent UI, no consent check on submit, ingest or publish. Agent names are still bleeped and shown as pseudonyms.
  - **Caller side:** callers were told calls are recorded; internal training/quality use usually fits that disclosure. Confirm the actual disclosure wording once (one-time review, not per item). Exclude calls from all-party consent states if the disclosure wording does not clearly cover training.
  - **Health details:** bleep conditions and medications in the audio. The `application` clip has no audio by default.
  - **Access:** RLS-gated, short signed links, no downloads in the UI, access logged.
- **Retention:**
  - Service: keeps nothing (no 7-day retention); see §4 Storage.
  - TR `sample-src` copies: deleted after the job finishes.
  - Library: reviewed every 12 months; withdrawn on agent revoke or a consumer request.
- **Vendors:** zero data retention, no training on the data. LLM calls get transcript text only, never audio.

## 6. n8n feasibility (superseded)

**Superseded 2026-10-13:** the service is built without n8n (a plain Node worker + ffmpeg in dimatxt01/ai-redactor) and returns results by pull through `sample-redaction-bridge`, not a callback. The original n8n analysis is kept below for history only.

<details><summary>Superseded n8n analysis</summary>

**Fits:** orchestration.
- Webhook node: submit, plus an HMAC check in a Code node.
- HTTP Request node: download the binary, then call AssemblyAI/Deepgram.
- Wait node or polling loop: wait for the async speech-to-text result, or use the vendor's own webhook.
- Code node: regex, digit runs and span merging.
- OpenRouter: an HTTP or AI node for the entity check, clip segmentation and coaching.
- HTTP Request: the signed callback.
- Postgres or Data Table: job state.

**Limits:**
- n8n has **no audio DSP**. Bleeping, padding, channel split, pitch-shift and clipping need ffmpeg: Execute Command (self-hosted only) or a small ffmpeg worker container called by HTTP.
- **Long audio:** 30–40 min mp3s are ~30–60 MB. With default in-memory binary mode memory blows up, so set `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` or use S3 mode.
- **Timeouts:** speech-to-text for a 40-min call takes minutes. Use async with a vendor webhook or Wait-node polling, never a blocking HTTP call. Raise `EXECUTIONS_TIMEOUT`.
- **n8n Cloud:** limits on executions and binary size, and no Execute Command, so **self-hosted is recommended**.
- **Retries and idempotency:** store them in the DB yourself; n8n's retry-on-fail alone is not enough.
- **Clips and coaching:** one LLM call per call (segmentation + coaching JSON with a schema check in a Code node), then an ffmpeg cut per clip. This adds about 1–2 min per call.
- **Recommended shape:** n8n for orchestration, AssemblyAI (audio redaction built in) or Deepgram plus an ffmpeg worker, regex and LLM in Code/HTTP nodes.

</details>

## Open items to verify
- Customer and agent channel order in the dual-channel mp3.
- Sample rate and bitrate. Probe with `ffprobe` on a freshly re-signed link during the pilot.
- How long Telnyx keeps recordings (older calls may already be gone).
- The caller recording-disclosure wording (does it cover training use?) and the agent release text.

## 7. Notes for the service builder

- **Dual channel:**
  - TR records `mp3`, `channels:'dual'` (Telnyx `record_start`). Each leg is on its own channel.
  - Which channel is the customer is **not yet verified**. Telnyx maps channels by call leg; check their `record_start` docs.
  - Run `ffprobe -show_streams` on a few freshly signed pilot files, listen to the first 10 s of each channel, and record the result as `channel_map` in the submit payload. Don't infer it at runtime.
  - Transcribe each channel separately; this gives speaker labels for free.
- **Idempotency:**
  - `POST /jobs` with an existing `idempotency_key` returns the existing job (same `job_id`); the job never runs twice.
  - No callbacks. Bridge `claim` is compare-and-swap; repeated `complete`/`fail` from the owning run are no-ops, other runs are refused.
- **Length and timeouts:**
  - Plan for **60 min max** (49-min calls exist), about 60 MB mp3. Reject anything over 90 min with `bad_audio:too_long`.
  - Everything is async: speech-to-text through the vendor's async API with a webhook or polling, never a synchronous HTTP call.
  - Per-job wall clock is 2 h. Stream the download to disk, not memory.
- **Models:**
  - **Speech-to-text needs word-level timestamps.** Use a dedicated STT API (AssemblyAI, Deepgram, AWS). General LLM audio models via OpenRouter do not give reliable word timestamps, so don't use them for bleep placement.
  - OpenRouter LLMs are for **text tasks only**: labeling clips, coaching, and the second-opinion PII check.
  - **Pin versions:** the STT model/tier and the exact OpenRouter model slug (no `:latest` or auto-routing), and a provider allowlist with zero data retention.
  - Record every model used in `engine` on each job.
- **Cost caps:**
  - Per job: estimate before running (minutes × rate plus tokens) and abort with `failed:cost_cap` over **$2**.
  - Monthly: stop accepting jobs over **$100** (configurable) and alert.
  - Report `metrics.cost_usd` per job.
- **Deterministic labels:**
  - Fixed clip taxonomy (§2.6) and rubric `fe_v1`, temperature 0, fixed seed if the model supports it.
  - Validate the output against a JSON Schema. On failure, retry once with the validation error included; if it still fails, return `qa_flag` + `labels_invalid`. Never return free-form labels.
- **Schema versioning:**
  - Every output carries `schema_version` (start at `1.0`). Adding fields is a minor version; renaming or removing is a major version, announced and kept running side by side for 30 days.
  - TR stores `schema_version` on each job.
- **Test fixtures:**
  - 10–15 **synthetic** two-channel calls (TTS or staff role-play) with PII planted at known timestamps: names, phone, address, DOB, SSN, card, MBI, digits spelled out and read back, crosstalk, and a 45–50 min long call.
  - Optionally a few real internal calls.
  - CI target: 100% of planted PII bleeped (with padding), 0 PII in the second pass, clip labels stable across 3 reruns.
  - Never use real customer calls as fixtures.
- **Retries:**
  - Fetch: 3× with backoff 30 s / 2 m / 10 m. If the signed URL expired, return `fetch_expired` so TR re-signs; don't retry.
  - STT and LLM: 3× with exponential backoff and jitter.
  - Bridge calls: retried by the worker's step retry; every bridge action is idempotent.
- **Logging:** log job_id, call_id, status, timings, counts and cost only. **Never** transcripts, PII text, signed URLs or secrets. Redact URLs to the host.
- **Secrets:**
  - Separate HMAC secrets for each direction. Rotate every 90 days or on suspected exposure, with a 24 h overlap where both old and new are accepted (`v1=` signature header supports several keys).
  - Vendor keys stay in the worker container's env only.
- **Deletion:**
  - TR-initiated (Dmitry 2026-10-13 12:44 PM): **hard delete on TR's side only**, admin/superadmin only. Every `training_library_*` row and file of the call goes; no takedown record; job status `deleted` is never written. Refused (409 `IN_FLIGHT`) while a job is queued/running (cancel first), while a worker run still owns a job (heartbeat), or while its AssemblyAI copies wait for the worker's normal cleanup. Each job's spend moves to `sample_spend_ledger` first. Nothing is deleted on the service side; the service holds nothing. No `DELETE /jobs/:id` callback and no 7-day service cleanup.
  - **Known limits (critic 5508438349):**
    - **AssemblyAI deletion failing:** a call cannot be deleted while its AssemblyAI copies are still listed on a job (`vendor_pending`). If AssemblyAI deletion keeps failing, delete keeps answering 409 `IN_FLIGHT` until the worker's cleanup succeeds; the error says to retry. Raise it with AssemblyAI if it persists.
    - **Retry window:** the blockers are checked before the first purge and again under the lock. A `retry` landing in the few ms between the pre-check and purge 1 can lose that job's TR files (the delete is then refused under the lock and the retried run re-fetches). Refusing `retry` during a delete would need a lock; it is admin-driven and tiny, so it is documented, not locked.
    - **Stale zombie run:** a run whose heartbeat has been stale for more than `SAMPLE_WORKER_STALE_S` (default 300 s) is treated as dead. If it later posts `cost` after the call was deleted, it gets `NO_JOB` and that spend is not recorded in the month cap. Inherent to the hard delete; expected to be cents.
    - **Follow-up (not done):** service_role keeps RL-1's `GRANT ALL` on `sample_redaction_jobs` and `training_library_reviews`, so a direct `DELETE`/`TRUNCATE` with the service key bypasses the spend ledger and append-only reviews. The edge functions only use the RPCs. Hardening service_role's rights is a later PR.
