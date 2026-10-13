# ai-redactor

TrueRing's Recording Library worker. It takes a Final Expense sale call, bleeps every piece of personal data, and cuts up to 6 coaching clips, for internal training.

It is a **plain Node background process**: one long-running container. It opens no port and receives no traffic. It **pulls** its work from TrueRing through one signed endpoint, `sample-redaction-bridge`, and sends every result back the same way.

**Status: nothing deployed or applied.** Built to SPEC v0.2 ([`truering/docs/recording-library/SPEC.md`](truering/docs/recording-library/SPEC.md)), on top of TrueRing's RL-1 (live since 2026-10-13).

## How it connects to TrueRing

```
TrueRing (Supabase)                                                     ai-redactor (this repo; any container host)
───────────────────                                                     ───────────────────────────────────────────
/am/recording-library  ──►  training-library-admin  ──►  sample_redaction_jobs (status 'queued')
 (AM picks a call)            (edge function)                  ▲
                                                               │ claim, status, signed storage URLs, results
                              sample-redaction-bridge  ◄───────┴──── poll every 20 s ──── src/worker.ts
                              (edge function, HMAC)                  (outbound HTTPS only)   ├─ AssemblyAI (transcribe ×2)
                                                                                             └─ OpenRouter (PII labels, clips, coaching)
storage: sample-src/<job_id>/ (scratch) · training-library/<job_id>/ (results)  ←  the worker uploads through bridge-signed URLs
```

- **TrueRing never calls the worker.** Submit and retry just queue the job. Each `poll` from the worker:
  - claims queued jobs (a compare-and-swap, so two workers never run the same job);
  - refreshes the heartbeat of the jobs it runs, and learns which of them to stop (takedowns);
  - gets the finished jobs whose AssemblyAI copies still need deleting.
- **If a worker dies mid-job,** its heartbeat goes stale. After 5 min the bridge fails the job and purges its files, the next poll deletes its vendor copies, and the AM presses retry.
- **One shared secret,** `SAMPLE_REDACTOR_BRIDGE_SECRET`. Requests are signed `X-TR-Signature: t=<unix>,v1=<hmac>` and accepted for ±300 s.
- **Input/output only.** The worker has no database, tables, buckets or Supabase key. Every recording, clip, transcript and coaching note is stored on TrueRing's side. Temp files are deleted at the end of every step, AssemblyAI's copies at the end of every job, and OpenRouter keeps nothing (ZDR).
- **[`truering/`](truering/) is a REFERENCE COPY ONLY** of the TrueRing side, applied only from `Mahamadou2004/truering` (branch `feat/sample-redaction`). See [`truering/README.md`](truering/README.md).

## Run it

```bash
npm ci                         # also checks the bundled ffmpeg binary is there
npm run check -- --bridge      # self-test: env present, ffmpeg runs, one signed poll to the bridge works
npm start                      # the worker (stops cleanly on SIGTERM)
docker build -t ai-redactor . && docker run --env-file .env.local ai-redactor     # or as a container
```

| Env | |
|---|---|
| `TR_BRIDGE_URL` | `https://<project>.supabase.co/functions/v1/sample-redaction-bridge` |
| `SAMPLE_REDACTOR_BRIDGE_SECRET` | The same value as the TrueRing Supabase function secret of that name. |
| `ASSEMBLYAI_API_KEY`, `OPENROUTER_API_KEY` | Vendor keys, with zero-retention / no-training terms. |
| optional | `WORKER_CONCURRENCY` (2), `POLL_S` (20), `ASR_POLL_S` (10), `ASSEMBLYAI_SPEECH_MODEL`, `OPENROUTER_MODEL`. Changing a model means bumping `PIPELINE_VERSION`. |

**Host.** Any always-on container host: Fly.io, Railway, Render, ECS or a VM.
- Needs outbound HTTPS only (no inbound port) and 1 vCPU / 1 GB RAM for 2 jobs at a time.
- Run **one** instance. A second one during a rollover is safe: the claim keeps every job to one run.
- The Docker `HEALTHCHECK` fails when no poll succeeded for 3 minutes.
- Logs are JSON lines with ids and counts only.

## Test it

```bash
npm run simulate                  # the whole system on this machine, no keys, nothing live (~1 min)
npm run validate -- --offline     # every check incl. the simulation; no vendor calls
npm run validate                  # + the real-vendor eval if ASSEMBLYAI_API_KEY / OPENROUTER_API_KEY are set (~$1.60)
bash truering/check.sh /path/to/truering   # read-only TrueRing-side checks inside a checkout of feat/sample-redaction
```

Prerequisites: Node 22 and PostgreSQL 15+ (`brew install postgresql@17`). Deno comes via `npx`. Generating the test calls needs macOS `say`.

**`npm run simulate`** runs the real code on both sides:
- **Real:** two worker processes, `training-library-admin` and `sample-redaction-bridge` (unchanged, under Deno), and the RL-1 + worker migrations on a throwaway Postgres.
- **Faked:** only Supabase's HTTP layer, Telnyx, AssemblyAI and OpenRouter. On the verification pass, the fake AssemblyAI listens to the redacted mp3 for the bleep tone, so an unbleeped value stays audible.

It checks, from TrueRing's side:
1. **Auth:** wrong secrets are refused; a worker with a wrong secret refuses to start.
2. **Submit rules:** the flag, scope, consent and the month cap.
3. **The happy path:** queued → done, with clips, coaching and cleanup.
4. **Two workers racing:** exactly one run does the work.
5. **Recording gone:** `fetch_expired`, then a retry succeeds.
6. **QA gate:** approve is refused until everything was played, then publish works.
7. **Delete every copy.**
8. **Takedown while a worker is mid-job:** the worker stops on its next poll, and the job is `deleted` once it confirms.
9. **A worker killed mid-job:** the bridge fails the job, the other worker deletes its vendor copy, a retry finishes it, and SIGTERM exits cleanly.
10. **Privacy:** every planted value is checked as bleeped in the audio and every clip (with a control on the original recording). Every artifact, table and log is searched for planted values, and the worker's temp dirs must be empty.

Output: `sim-out/<time>/report.md`, `storage/` (every file TrueRing would hold, so you can listen to them) and `logs/`.

## Layout

| Path | What |
|---|---|
| `src/worker.ts` | The process: poll loop, concurrency, stop requests, vendor cleanup, graceful shutdown. |
| `src/check.ts` | The self-test (`npm run check`); the worker runs it at startup and refuses to start on a failure. |
| `lib/job.ts` | One job: claim → fetch → transcribe → detect → render → clips + coaching → verify → complete. |
| `lib/steps.ts` | The steps. Each does its own I/O and passes only ids, hashes, counts and offsets onward. |
| `lib/` | Also: detectors (`pii/`), audio DSP (`audio.ts`), clips + coaching (`labels.ts`), QA (`qa.ts`), the bridge client, retries, option defaults, costs, logs. |
| `test/` | Unit tests (`npm test`). |
| `fixtures/calls/` | 12 synthetic two-voice calls with planted, fictional PII. |
| `scripts/` | `validate.sh`, `eval-test-calls.ts` (real vendors), `signature-parity.ts`, `check-ffmpeg.mjs`. |
| `sim/` | The end-to-end simulation. |
| `truering/` | Reference copy of the TrueRing side (never applied from here) + `refresh.sh`, `check.sh`. |
| `docs/DESIGN.md` | The pipeline in detail, how each requirement is met, deviations from SPEC, the review answers. |
