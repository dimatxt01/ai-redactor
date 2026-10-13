# True Ring: Recording Redaction Service, spec v0.1 (2026-10-12)

This is an external service that Dmitry builds separately (n8n plus models via OpenRouter or a speech API). True Ring (TR) sends it calls privately; it returns PII-bleeped audio and transcripts; TR admins approve results into a sample library.
Status: draft. Based on read-only prod/repo scoping on 2026-10-12. Nothing built.

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
    "pitch_shift_customer": true,
    "highlight": { "enabled": true, "target_s": 300 },
    "extra_terms": ["<agent first/last name>", "<carrier names>"]
  },
  "callback_url": "https://<project>.supabase.co/functions/v1/sample-redaction-callback"
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
5. **Optional pitch-shift** of the customer channel (±2–3 semitones, formant-preserving if possible), then mix down to mono.
6. **Optional highlight clip:**
   - The LLM picks a 3–8 min window: opener → objection → close.
   - It must not start or end inside a bleep, and gets a 1 s fade.
   - It is cut from the already-redacted audio.
7. **Second pass:**
   - Transcribe the *redacted* audio again.
   - Rerun the digit-run and MBI checks and the name list.
   - Any hit → `qa_flag=true`, with the reasons listed.
8. **QA flag** is also set when:
   - average word confidence is under 0.85;
   - any PII span has confidence under 0.7;
   - crosstalk is over 10%;
   - the length check fails.
   - Every output still needs a human listen in TR (§5), whatever the flag says.

## 3. Output contract

- **Audio:** `redacted.mp3` (mono, 44.1 kHz/128 kbps for playback) and optionally `highlight.mp3`. Optionally a lossless `redacted.wav` for QA.
- **Transcript:** JSON of `[{channel, speaker:"customer"|"agent", start_ms, end_ms, text}]`. Redacted words appear as `[REDACTED:<TYPE>]`. A `.txt` render is also provided.
- **PII spans:** `[{type, start_ms, end_ms, channel, confidence, detector:"model"|"regex"|"digit_run"|"extra_term", padded_start_ms, padded_end_ms}]`. They contain **no original text**.
- **Status:** `queued` → `fetching` → `transcribing` → `redacting` → `verifying` → `done` | `failed` (with `error_code`: `fetch_expired` | `bad_audio` | `asr_failed` | `timeout`).

Callback (POST to `callback_url`):
```json
{
  "job_id": "srj_01J…",
  "idempotency_key": "call:2948f3a3-…:v1",
  "call_id": "2948f3a3-…",
  "status": "done",
  "qa_flag": true,
  "qa_reasons": ["second_pass_digit_run@612340ms"],
  "metrics": { "asr_confidence": 0.91, "pii_spans": 37, "bleeped_ms": 18450, "duration_ms": 764000 },
  "artifacts": {
    "redacted_audio": { "url": "<signed, 24h>", "sha256": "…", "bytes": 12345678 },
    "highlight_audio": { "url": "<signed, 24h>", "sha256": "…", "start_ms": 301000, "end_ms": 586000 },
    "transcript_json": { "url": "<signed, 24h>", "sha256": "…" },
    "pii_spans_json": { "url": "<signed, 24h>", "sha256": "…" }
  },
  "engine": { "asr": "assemblyai:universal", "pii": "assemblyai+regex v1", "llm": "openrouter:<model>" },
  "completed_at": "2026-10-12T23:20:11Z"
}
```

## 4. Integration

**Auth:**
- Both directions use an HMAC-SHA256 header: `X-TR-Signature: t=<unix>,v1=<hex(hmac(secret, t + "." + raw_body))>`.
- Reject requests outside ±5 min.
- Each direction has its own secret. Secrets live only in Supabase function secrets and n8n credentials. The service's URL is not public; use an IP allowlist or a shared header too.

**Lifecycle:**
- `POST /jobs` (submit). The same `idempotency_key` returns the existing job; `:v2` forces a reprocess.
- `GET /jobs/:id` (status).
- The callback fires on `done` or `failed`. It is retried 5× with exponential backoff (1 m → 2 h). TR deduplicates on `job_id` + `status`.
- `fetch_expired` → TR re-signs the link and resubmits with the same key.
- A job running over 2 h is marked `failed:timeout`.

**Storage:**
- Private Supabase bucket `sample-library`. The service's signed links are only for TR to copy from.
- TR copies the artifacts into `sample-library/<call_id>/v<n>/…` and serves them only as short-lived signed URLs (admin role check, the same pattern as `recording-proxy`).
- The service deletes its copies 7 days after the callback.

**Proposed TR tables (not created):**
- `sample_redaction_jobs`: id, call_id, idempotency_key unique, status, qa_flag, qa_reasons jsonb, metrics jsonb, engine jsonb, submitted_by, timestamps.
- `sample_library`:
  - id, call_id, job_id, version, agent_ref, vertical, disposition, duration_s;
  - storage paths and sha256 values, highlight bounds;
  - title, tags;
  - `status` (`pending_qa` | `qa_passed` | `legal_approved` | `published` | `rejected` | `withdrawn`).
- `sample_library_approvals`: append-only `(library_id, step, actor, decision, notes, listened_full bool, at)`. **Publishing requires `qa` + `legal` with `listened_full=true`.**
- Manifest: a view or export joining the three tables (call_id, agent_ref, consent ref, approvals, hashes), used for audits and take-downs.

**Admin UI (`/admin/sample-library`):**
- A picker filtered by disposition, agent, duration 10–40 min and vertical `final_expense`. Submit is a button.
- A jobs list with status.
- A QA player: waveform with bleeps marked, the redacted transcript, the second-pass flags, a "listened to the full file" checkbox, and approve/reject.
- A library grid, with publish limited to internal share links, plus withdraw.

## 5. Security and compliance

- **v1 scope:** Final Expense `Sale` calls only. **Medicare and ACA are excluded**, because of CMS marketing-material rules and health information.
- **Agent consent:** a signed release from each featured agent, with `consent_ref` stored on the library row. Agent names are bleeped and pseudonymized as `agent_ref`.
- **Customer:** pitch-shift on by default; health conditions and beneficiaries bleeped. Callers were told about recording, not about reuse in sales material, so legal must sign off before any external use. About 11–12 US states require every party to agree to recording; decide whether to exclude callers from those states.
- **Human QA:** every file gets a full listen. One miss is a privacy incident. Do the internal-only pilot of 5 first.
- **Retention:**
  - Service: source and artifacts deleted ≤7 days after the callback.
  - TR `sample-src` copies: deleted after the job finishes.
  - Library: reviewed every 12 months, withdrawn on request.
- **Vendors:** only vendors that don't train on the data and keep nothing (zero retention), with a data agreement in place. OpenRouter only with providers that keep no data, and **only on transcript text, never audio**.
- **No public URLs; access is logged.**

## 6. n8n feasibility

**Fits:** orchestration.
- Webhook node: submit, plus an HMAC check in a Code node.
- HTTP Request node: download the binary, then call AssemblyAI/Deepgram.
- Wait node or polling loop: wait for the async speech-to-text result, or use the vendor's own webhook.
- Code node: regex, digit runs and span merging.
- OpenRouter: an HTTP or AI node for the entity check and highlight picking.
- HTTP Request: the signed callback.
- Postgres or Data Table: job state.

**Limits:**
- n8n has **no audio DSP**. Bleeping, padding, channel split, pitch-shift and clipping need ffmpeg: Execute Command (self-hosted only) or a small ffmpeg worker container called by HTTP.
- **Long audio:** 30–40 min mp3s are ~30–60 MB. With default in-memory binary mode memory blows up, so set `N8N_DEFAULT_BINARY_DATA_MODE=filesystem` or use S3 mode.
- **Timeouts:** speech-to-text for a 40-min call takes minutes. Use async with a vendor webhook or Wait-node polling, never a blocking HTTP call. Raise `EXECUTIONS_TIMEOUT`.
- **n8n Cloud:** limits on executions and binary size, and no Execute Command, so **self-hosted is recommended**.
- **Retries and idempotency:** store them in the DB yourself; n8n's retry-on-fail alone is not enough.
- **Recommended shape:** n8n for orchestration, AssemblyAI (audio redaction built in) or Deepgram plus an ffmpeg worker, regex and LLM in Code/HTTP nodes.

## Open items to verify
- Customer and agent channel order in the dual-channel mp3.
- Sample rate and bitrate. Probe with `ffprobe` on a freshly re-signed link during the pilot.
- How long Telnyx keeps recordings (older calls may already be gone).
- Legal position on reusing recordings, and the state list.
