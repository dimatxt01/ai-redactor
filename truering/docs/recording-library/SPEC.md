# True Ring: Recording Redaction + Coaching Service, spec v0.2 (2026-10-12, revised after Dmitry's 6:27 PM answers; delivery revised 2026-10-13: pull through the bridge, no callback)

This is a separate service, the `ai-redactor` worker (its own repo and Vercel project; Vercel Workflow + ffmpeg, AssemblyAI for speech, OpenRouter for text). True Ring (TR) starts it per call; the worker pulls the call's inputs and pushes its results **through one TR edge function, `sample-redaction-bridge`**, straight into TR's storage and tables. TR AMs/admins pick sales calls and, after a human QA listen, publish the results to an internal **training** Recording Library (smart clips of the key sale moments plus AI coaching notes).
Status: built (worker + TR side on branch `feat/sample-redaction`), not deployed. TR_PLAN.md RL-2/RL-3 describe the TR side.

**The service is input/output only.** It has no database, tables, buckets or Supabase key. Every recording, clip, transcript and coaching note is stored on TR's side (RL-1 buckets and tables). Its temp files and AssemblyAI's copies are deleted every run; OpenRouter keeps nothing (zero data retention, no training). Its only state is the Workflow run log, which carries ids, hashes and counts, never content, and is deleted when the run ends (§4).

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
- TR never sends a stored URL, and nothing is copied in advance.
- When the worker reaches its fetch step it asks the bridge (`source`) for a **fresh Telnyx link**, the same lookup `recording-proxy` does, and downloads it at once. It never stores the URL. A new link is fetched on every attempt (they expire in ~10 min).
- Twilio-era recordings are out of v1 (`unsupported_source`).

Start (TR `training-library-admin` → worker `POST /api/jobs`, HMAC). The body is ids only:
```json
{ "job_id": "6e1e1645-67cc-4cb1-9a0e-2c1f0d6f9e11", "idempotency_key": "call:2948f3a3-d352-4e3b-8976-1af6b7fb0230:v1" }
```
TR first writes the job row (`sample_job_insert`: the key, options, call meta, the reserved cost). The worker then pulls the job's inputs from the bridge (`job`):
```json
{
  "job": {
    "id": "6e1e1645-…", "call_id": "2948f3a3-…", "version": 1, "status": "queued",
    "options": {
      "bleep_pad_ms": 250,
      "pitch_shift_customer": false,
      "redact_health": true,
      "clips": { "enabled": true, "max_per_call": 6, "min_s": 20, "max_s": 240 },
      "coaching": { "enabled": true, "rubric": "fe_v1" },
      "extra_terms": ["<carrier names the AM added>"],
      "customer_channel": 0
    },
    "call_meta": {
      "duration_s": 764, "disposition": "Sale", "vertical": "final_expense", "caller_state": "TX",
      "recorded_at": "2026-10-12T22:44:01Z",
      "channel_map": { "customer": 0, "agent": 1, "verified": false }
    }
  },
  "extra_terms": ["<agent first/last name>", "<caller first/last name>", "<carrier names the AM added>"],
  "idempotency_key": "call:2948f3a3-…:v1",
  "caps": { "job_usd": 2, "month_usd": 100, "spent_usd": 0, "asr_usd_per_hour": 0.45 }
}
```
- Top-level `extra_terms` = the agent's and caller's names, read from TR rows at request time and never stored on the job, plus the AM's own terms from `options`.
- `channel_map` stays `verified:false` until the pilot has confirmed it; every result is QA-flagged `channel_map_unverified` until then.
- Missing or malformed options fall back to the defaults above; redaction settings fail safe.

## 2. Processing

1. Download the audio, check the duration against `duration_s` (±5%), and split it into its two channels.
2. **Transcribe** each channel with **word-level timestamps** and diarization by channel: AssemblyAI, one pinned model, `multichannel`, entity detection. An LLM via OpenRouter is used **only** for classifying entities on top of the timestamped transcript, never for producing the timestamps.
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
- **Status:** `queued` → `fetching` → `transcribing` → `redacting` → `verifying` → `done` | `failed` (with `error_code`: `fetch_expired` | `bad_audio` | `asr_failed` | `timeout` | `unsupported_source` | `cost_cap` | `internal`), and `deleted` after a takedown. The worker moves the status forward through the bridge (`status`); it lives on TR's job row.

**Delivery (pull through the bridge; there is no callback).**
1. The worker asks the bridge (`sign`) for signed upload URLs under `training-library/<job_id>/` and PUTs each file there: `redacted.mp3`, `clips/cN.mp3`, `transcript.json`, `transcript.txt`, `pii_spans.json`, `clips.json`, `coaching.json`. Nothing is uploaded anywhere else, and the worker keeps no copy.
2. It then calls the bridge's `complete`. The bridge checks every named file is in the job's prefix, and `sample_library_ingest` writes, in one transaction, the job as `done` plus `training_library_calls` (`pending_qa`), `_call_sources` and `_clips`. A repeat by the same run returns the same library row.
```json
{
  "action": "complete", "job_id": "6e1e1645-…", "run_id": "wrun_01J…",
  "pipeline_version": "sr-2.0.0", "schema_version": "1.0",
  "qa_flag": true,
  "qa_reasons": ["channel_map_unverified", "second_pass_digit_run@612340ms"],
  "metrics": { "asr_confidence": 0.91, "clips": 6, "pii_spans": 37, "bleeped_ms": 18450, "duration_ms": 764000 },
  "artifacts": {
    "redacted_audio": { "name": "redacted.mp3", "sha256": "…", "bytes": 12345678 },
    "transcript_json": { "name": "transcript.json", "sha256": "…" },
    "transcript_txt": { "name": "transcript.txt", "sha256": "…" },
    "pii_spans_json": { "name": "pii_spans.json", "sha256": "…" },
    "clips_json": { "name": "clips.json", "sha256": "…" },
    "coaching_json": { "name": "coaching.json", "sha256": "…" }
  },
  "clips": [
    { "clip_id": "c1", "label": "opener", "sub_label": null, "start_ms": 2100, "end_ms": 48300, "audio_exported": true,
      "audio": { "name": "clips/c1.mp3", "sha256": "…" }, "title": "Warm opener, sets agenda",
      "coaching": { "did": "…", "worked": "…", "improve": "…", "key_lines": ["…"], "scores": { "rapport": 4 } }, "confidence": 0.82 },
    { "clip_id": "c6", "label": "application", "sub_label": null, "start_ms": 1490000, "end_ms": 1820000, "audio_exported": false, "audio": null, "coaching": { "…": "…" } }
  ],
  "coaching": { "summary": "…", "strengths": ["…"], "improvements": ["…"], "scores": { "…": 4 }, "turning_point_clip_id": "c4", "rubric": "fe_v1", "model": "…" },
  "engine": { "asr": "assemblyai:<model>", "pii": "assemblyai-entities+rules+openrouter sr-2.0.0", "llm": "openrouter:<model>", "pipeline": "sr-2.0.0" }
}
```
3. On a failure the worker calls `fail` with the code; the bridge ends the job and deletes both the scratch copy and any partial artifacts.

## 4. Integration

**Auth:**
- Both directions use an HMAC-SHA256 header: `X-TR-Signature: t=<unix>,v1=<hex(hmac(secret, t + "." + raw_body))>`.
- Reject requests outside ±5 min.
- Each direction has its own secret: `SAMPLE_REDACTOR_START_SECRET` (TR → worker) and `SAMPLE_REDACTOR_BRIDGE_SECRET` (worker → bridge). They live only in Supabase function secrets and the worker's Vercel env. A missing secret rejects.

**Endpoints:**
- Worker (called by TR): `POST /api/jobs` (start a run), `POST /api/delete` (cancel runs, delete AssemblyAI's copies), `GET /api/health` (no data).
- Bridge (called by the worker; the worker's only way into TR): `job` (inputs), `claim`, `source` (fresh Telnyx link), `sign` (signed URLs, only under `sample-src/<job_id>/` and `training-library/<job_id>/`), `status`, `cost`, `asr` (records a vendor transcript id for deletion), `complete`, `fail`, `purge`. Every action names one job; after `claim`, every action must come from the run that claimed it.

**Lifecycle:**
- Submit: TR writes the job (key `call:<id>:v<n>`; the same key returns the existing job, `:v2` reprocesses) and calls `POST /api/jobs`.
- Exactly once: the first run to `claim` a queued job owns it (compare-and-swap); a duplicate start, or a start whose key does not match the job, exits without touching it.
- Status: there is no `GET /jobs/:id`; TR reads its own job row.
- `fetch_expired` → TR's `retry` restarts the job with the same key (the next attempt fetches a fresh link).
- A job running over 2 h is marked `failed:timeout` (bridge, and TR's sweep).

**Storage (TR side only; RL-1 buckets, private):**
- `sample-src/<job_id>/`: the worker's scratch between steps (source copy, names, spans, clip windows). Deleted when the job ends, done or failed.
- `training-library/<job_id>/`: the artifacts. Served only as short-lived signed links (staff via `training-library-admin` `link`, access logged).
- Paths carry the job id, never `calls.id`.

**Deletion (takedown):** TR's `delete` tombstones the call first (every bridge action then refuses it), calls the worker's `POST /api/delete` (cancel runs, wait for them to stop, delete AssemblyAI's transcripts), purges both buckets, and withdraws and empties the library rows. The job is `deleted` only after the worker answers 200; a 207 means try again.

**TR tables (built: RL-1 `20261012180000_training_library` + worker columns `20261013090000_sample_redaction_worker`):**
- `sample_redaction_jobs`: id, call_id, idempotency_key unique, status, qa_flag, qa_reasons jsonb, metrics jsonb, engine jsonb, submitted_by, timestamps.
- `training_library_calls`: id, call_id, job_id, version, agent_ref (pseudonym), source_agent_id (admin-only column), vertical, duration_s, full-audio path and sha256, `coaching` jsonb, title, tags, `status` (`pending_qa` | `published` | `rejected` | `withdrawn`).
- `training_library_clips`: id, library_call_id, label, sub_label, start_ms, end_ms, audio path (nullable when not exported), sha256, title, `coaching` jsonb, sort order.
- `training_library_reviews`: append-only `(library_call_id, reviewer, decision, listened_full bool, notes, at)`. **Publishing requires one QA review with `listened_full=true`** (full call plus every clip).
- `training_library_ratings`:
  - Columns: id, agent_id, item_type (`call` | `clip`), item_id, `vote smallint check (vote in (-1,1))` (+1 = green up arrow, -1 = red down arrow), comment text (optional, ≤1000 chars), created_at, updated_at.
  - Unique `(agent_id, item_type, item_id)`, so a repeat rating is an upsert.
  - RLS: an agent can select/insert/update only rows where `agent_id = auth.uid()`; AM/admin can select all. No delete for agents (they can edit instead).
  - Internal record only. **Never shown to other agents**: no aggregates in the agent UI. This table is TR-side only; the service never sees it.
- Manifest: a view joining the above with consent refs and hashes, for audits and withdrawal.

**UI** (see TR_PLAN.md): an AM/admin curation page (pick, submit, status, QA listen, publish/withdraw) and a read-only **Recording Library** tab for agents (clip list by label, player, coaching notes).

## 5. Security and compliance (internal training only)

- **Scope:** Final Expense `Sale` calls only, confirmed by Dmitry. Medicare and ACA are excluded.
- **Use:** internal training for logged-in TR agents, AMs and admins only. No marketing, public or buyer-facing use. That removes the CMS marketing-material question, the external legal approval of each item, and the public player. If use ever becomes external, the old marketing controls come back.
- **Still required:**
  - **PII redaction + a human QA listen of every published full call and clip.** One miss exposes a consumer's PII to the whole agent base.
  - **Agent consent:** a featured agent's voice and performance are shown to peers and coached on. Get a one-time training-use release (portal checkbox), revocable; revoking withdraws their items. Agent names are bleeped and shown as pseudonyms.
  - **Caller side:** callers were told calls are recorded; internal training/quality use usually fits that disclosure. Confirm the actual disclosure wording once (one-time review, not per item). Exclude calls from all-party consent states if the disclosure wording does not clearly cover training.
  - **Health details:** bleep conditions and medications in the audio. The `application` clip has no audio by default.
  - **Access:** RLS-gated, short signed links, no downloads in the UI, access logged.
- **Retention:**
  - Service: none. Temp files are deleted at the end of every step; AssemblyAI transcripts are deleted when the job ends (and again on takedown). The Workflow run log holds ids, hashes and counts only, and each run is started with retention 0, so its inputs, outputs and event payloads are deleted as soon as it ends.
  - TR `sample-src` copies: deleted after the job finishes.
  - Library: reviewed every 12 months; withdrawn on agent revoke or a consumer request.
- **Vendors:** zero data retention, no training on the data. LLM calls get transcript text only, never audio.

## 6. Implementation (in-house, no n8n)

- `ai-redactor`, a separate repo and Vercel project: Next.js routes for the three endpoints, one durable Vercel Workflow run per job (claim → fetch → transcribe → detect → render → clips + coaching → verify → complete), ffmpeg (`ffmpeg-static`, shipped with every function) for bleeping, mixing and clips.
- Long calls: the run sleeps while AssemblyAI works (vendor webhook to wake it, polling as a fallback); no function holds a long request open.
- The run passes only ids, hashes, counts and offsets between steps; text lives in TR's `sample-src/<job_id>/` scratch in between.

## Open items to verify
- Customer and agent channel order in the dual-channel mp3.
- Sample rate and bitrate. Probe with `ffprobe` on a freshly re-signed link during the pilot.
- How long Telnyx keeps recordings (older calls may already be gone).
- The caller recording-disclosure wording (does it cover training use?) and the agent release text.

## 7. Notes for the service builder

- **Dual channel:**
  - TR records `mp3`, `channels:'dual'` (Telnyx `record_start`). Each leg is on its own channel.
  - Which channel is the customer is **not yet verified**. Telnyx maps channels by call leg; check their `record_start` docs.
  - Run `ffprobe -show_streams` on a few freshly signed pilot files, listen to the first 10 s of each channel, and record the result as `channel_map` on the job (the AM's choice on submit). Don't infer it at runtime.
  - Transcribe each channel separately; this gives speaker labels for free.
- **Idempotency:**
  - Submitting an existing `idempotency_key` returns the existing job (same `job_id`); the job never runs twice.
  - A duplicate `POST /api/jobs` starts a run that loses the `claim` and exits. `complete`, `fail` and the cost ledger (per item) are idempotent, so a replayed step does nothing twice.
- **Length and timeouts:**
  - Plan for **60 min max** (49-min calls exist), about 60 MB mp3. Reject anything over 60 min (±5%) with `bad_audio:too_long`.
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
  - Optionally a few real calls with consent.
  - CI target: 100% of planted PII bleeped (with padding), 0 PII in the second pass, clip labels stable across 3 reruns.
  - Never use real customer calls as fixtures.
- **Retries:**
  - Fetch: a fresh link per attempt. If Telnyx no longer has the recording (or the download is refused), fail with `fetch_expired`; TR's retry restarts the job.
  - STT, LLM and bridge calls: retried with backoff by the workflow step (transient errors only).
- **Logging:** log job_id, call_id, status, timings, counts and cost only. **Never** transcripts, PII text, signed URLs or secrets. Redact URLs to the host.
- **Secrets:**
  - Separate HMAC secrets for each direction. Rotate every 90 days or on suspected exposure, with a 24 h overlap where both old and new are accepted (`v1=` signature header supports several keys).
  - Vendor keys stay in the worker's Vercel env only.
- **Deletion:**
  - `POST /api/delete` (HMAC) cancels the job's runs, waits for them to stop, deletes AssemblyAI's transcripts and schedules one more purge of TR scratch after every signed upload URL has expired. It answers 200 when everything is gone, 207 when something must be retried. The service holds no other copy.
