# ai-redactor

TrueRing's Recording Library worker. It takes an ended sale call (Final Expense, Medicare or ACA), bleeps every piece of personal data, and cuts up to 6 coaching clips, for internal training.

It is a **plain Node background process**: one long-running container. It opens no port and receives no traffic. It **pulls** its work from TrueRing through one signed endpoint, `sample-redaction-bridge`, and sends every result back the same way.

**Status:** TrueRing's side is deployed from `Mahamadou2004/truering` **main @ `d7671d64`** (the merge of `prb/rl-worker`). The worker runs on one Hetzner host; see [`docs/OPERATIONS.md`](docs/OPERATIONS.md). The contract is [`truering/docs/recording-library/SPEC.md`](truering/docs/recording-library/SPEC.md), mirrored from that commit.

## How it connects to TrueRing

```
TrueRing (Supabase)                                                     ai-redactor (this repo; one container)
───────────────────                                                     ──────────────────────────────────────
/am|/admin/recording-library ─► training-library-admin ─► sample_redaction_jobs (status 'queued')
 (pick, submit, QA, publish;      (edge function)                ▲
  admin: cancel, delete)                                         │ claim, status, signed storage URLs, results
                                 sample-redaction-bridge ◄───────┴──── poll every 20 s ──── src/worker.ts
                                 (edge function, HMAC)                  (outbound HTTPS only)   ├─ AssemblyAI (transcribe ×2)
                                                                                                └─ OpenRouter (PII labels, clips, coaching)
storage: sample-src/<job_id>/ (scratch) · training-library/<job_id>/ (results)  ←  the worker uploads through bridge-signed URLs
```

- **TrueRing never calls the worker.** Submit and retry just queue the job. Each `poll` from the worker:
  - claims queued jobs (a compare-and-swap, so two workers never run the same job);
  - refreshes the heartbeat of the jobs it runs, and gets a **stop** list: jobs cancelled, failed or deleted;
  - gets the finished jobs whose AssemblyAI copies still need deleting.
- **Cancel** (admin, in TrueRing) marks the job `failed: cancelled`. The worker sees it in its next poll's stop list and aborts without failing the job again. It deletes its AssemblyAI copies and reports `vendor_purged`, which clears the heartbeat.
- **Delete** (admin, in TrueRing) is a hard delete on TrueRing's side only; the worker is never called. TrueRing refuses it (`409 IN_FLIGHT`) while a job is running, a run still holds a heartbeat, or AssemblyAI ids are still recorded. So the worker's vendor cleanup is what unblocks a delete. Afterwards the bridge answers `404 NO_JOB`, and the worker treats that as "stopped", never as a failure.
- **If a worker dies mid-job,** its heartbeat goes stale. After `SAMPLE_WORKER_STALE_S` (300 s), the next poll by any worker has the bridge fail the job and purge its files; its vendor ids go to the cleanup list.
- **Orphan sweep:** a worker killed between AssemblyAI's submit and recording the id leaves a transcript nobody knows about. Every 30 min the worker deletes any transcript on its AssemblyAI account older than 2 h 15 m, past the 2 h job deadline. **Use an AssemblyAI key dedicated to this worker.**
- **Verticals:** TrueRing resolves the vertical from the call's agent and refuses unknown or multiple ones. The worker never defaults it: the coaching prompt names the job's line, and a job without a known vertical fails. Rubric `fe_v1` is used for all three until Dmitry rules on per-vertical rubrics. Consent is not checked anywhere; the worker never touches it.
- **One shared secret,** `SAMPLE_REDACTOR_BRIDGE_SECRET`. Requests are signed `X-TR-Signature: t=<unix>,v1=<hmac>` and accepted for ±300 s (`lib/signature.ts`; `scripts/signature-parity.ts` checks it against TrueRing's `sampleSignature.ts`).
- **Input/output only.** The worker has no database, tables, buckets or Supabase key. Every recording, clip, transcript and coaching note is stored on TrueRing's side. Temp files are deleted at the end of every step, AssemblyAI's copies at the end of every job, and OpenRouter keeps nothing (ZDR). Logs carry ids, counts, hashes and codes only.
- **[`truering/`](truering/) is a mirror only.** Never apply or deploy from it. See [`truering/README.md`](truering/README.md).

## Run it (Hetzner or any Linux host)

```bash
npm ci                                       # also checks the ffmpeg binary for THIS machine's architecture
npm run check -- --bridge                    # env present, ffmpeg runs, one signed poll works → must print "ok": true
docker compose -f deploy/docker-compose.yml up -d --build    # restart: unless-stopped, read-only, log rotation
#   runbook for the live host (go-live order, secret hand-over, logs, update, rollback): docs/OPERATIONS.md
#   or systemd: deploy/ai-redactor.service   (Restart=always, runs the check before every start)
```

| Env (values only in the host's secret store, e.g. `/etc/ai-redactor.env`, chmod 600) | |
|---|---|
| `TR_BRIDGE_URL` | `https://<project>.supabase.co/functions/v1/sample-redaction-bridge` |
| `SAMPLE_REDACTOR_BRIDGE_SECRET` | The same value as the TrueRing Supabase function secret of that name. |
| `ASSEMBLYAI_API_KEY` | Zero retention / no training, and **used by this worker only** (the orphan sweep). |
| `OPENROUTER_API_KEY` | ZDR. |
| optional | `WORKER_CONCURRENCY` (2, max 6), `POLL_S` (20, min 2), `ASR_POLL_S` (10), `ORPHAN_AGE_S` (8100), `ORPHAN_SWEEP_S` (1800), `ALIVE_FILE` (`/tmp/ai-redactor-alive`), `ASSEMBLYAI_SPEECH_MODEL`, `OPENROUTER_MODEL` (changing a model = bump `PIPELINE_VERSION`). |

`SAMPLE_WORKER_STALE_S` is a TrueRing function secret, not a worker variable; keep it far above `POLL_S` (300 vs 20).

**Host:**
- **Network:** outbound HTTPS only, to the bridge, Supabase signed storage URLs, Telnyx recording links, AssemblyAI and OpenRouter. Firewall all inbound except SSH.
- **Size:** 1 vCPU / 2 GB RAM for 2 jobs at a time. A 60-min call peaks near 300 MB in `/tmp` and 0.5 GB of memory.
- **ffmpeg:** `ffmpeg-static` downloads the binary for the build machine's architecture (x86-64 or arm64, e.g. Hetzner CAX). Run `npm run check` on the host or inside the image.
- **Instances:** run one. Two are safe (the claim is a compare-and-swap) but double the poll load, about 130k bridge calls a month each at `POLL_S=20`.
- **Restarts:** SIGTERM fails running jobs as "worker restarted; retry the job" within ~25 s.
- **Liveness:** the Docker `HEALTHCHECK` fails when no poll succeeded for 3 minutes (it watches `ALIVE_FILE`); under systemd, monitor that file's age the same way.
- **Logs:** cap them (Docker `max-size`/`max-file` in the compose file; journald `SystemMaxUse`/`MaxRetentionSec`).

## Test it

```bash
npm run simulate                  # the whole system on this machine, no keys, nothing live (~1.5 min)
npm run validate -- --offline     # every check incl. the simulation; no vendor calls
npm run validate                  # + the real-vendor eval if ASSEMBLYAI_API_KEY / OPENROUTER_API_KEY are set (~$1.60)
npm run eval -- --llm-only        # re-check clip labels on the last run's cached redacted lines (cents, no ASR)
bash truering/check.sh /path/to/truering   # read-only TrueRing-side checks inside a checkout of TR main (or the commit in truering/SOURCE)
```

Prerequisites: Node 22 and PostgreSQL 15+ (`brew install postgresql@17`). Deno comes via `npx`. Generating the test calls needs macOS `say`.

**`npm run simulate`** runs the real code on both sides:
- **Real:** two worker processes, TrueRing's `training-library-admin` and `sample-redaction-bridge` (from the mirror, unchanged, under Deno), and the RL-1 + worker migrations on a throwaway Postgres.
- **Faked:** only Supabase's HTTP layer, Telnyx, AssemblyAI and OpenRouter. On the verification pass, the fake AssemblyAI listens to the redacted mp3 for the bleep tone, so an unbleeped value stays audible.

It checks, from TrueRing's side (105 checks):
1. **Auth:** wrong secrets are refused; a worker with a wrong secret refuses to start.
2. **Submit rules:** the flag; Twilio-era and not-yet-ended calls; agents with two verticals or none are refused, never defaulted; the month cap. There is no consent gate.
3. **The happy path:** queued → done, with clips, coaching and cleanup.
4. **Two workers racing:** exactly one run does the work.
5. **Recording gone:** `fetch_expired`, then a retry succeeds.
6. **QA gate:** approve is refused until everything was played, then publish works.
7. **Hard delete:** admin only; rows and files gone, spend kept in the ledger; then the bridge answers `404 NO_JOB`.
8. **Cancel mid-run:** delete is refused while the job is in flight. Admin cancel → the worker stops on its next poll, deletes the vendor copy and reports `vendor_purged` (the heartbeat clears, the job stays `failed: cancelled`) → delete succeeds.
   **Kill switch:** with the `recording_library` flag OFF, a queued job is never handed out, and a claim that raced the switch-off gets `409 JOB_TERMINAL` (the worker stops, never fails), with the job ended `failed: cancelled`.
9. **A worker killed mid-job:** the bridge fails it, the other worker deletes its vendor copy, a retry finishes it (on a **Medicare** call, whose coaching prompt names Medicare). Then the orphan sweep deletes an old unrecorded transcript and keeps a young one, and SIGTERM exits cleanly.
10. **Privacy:** every planted value is checked as bleeped in the audio and every clip (with a control on the original recording). Every artifact, table and log is searched for planted values, and the worker's temp dirs must be empty.

Output: `sim-out/<time>/report.md`, `storage/` (every file TrueRing would hold, so you can listen to them) and `logs/`.

## Layout

| Path | What |
|---|---|
| `src/worker.ts` | The process: poll loop, concurrency, stop list, vendor cleanup, orphan sweep, graceful shutdown. |
| `src/check.ts` | The self-test (`npm run check`); the worker runs it at startup and refuses to start on a failure. |
| `lib/job.ts` | One job: claim → fetch → transcribe → detect → render → clips + coaching → verify → complete. |
| `lib/steps.ts` | The steps. Each does its own I/O and passes only ids, hashes, counts and offsets onward. |
| `lib/` | Also: detectors (`pii/`), audio DSP (`audio.ts`), clips + coaching (`labels.ts`), QA (`qa.ts`), the bridge client, retries, option defaults, costs, logs. |
| `deploy/` | `docker-compose.yml` (restart, read-only, log rotation) and `ai-redactor.service` (systemd). |
| `test/` | Unit tests (`npm test`). |
| `fixtures/calls/` | 12 synthetic two-voice calls with planted, fictional PII. |
| `scripts/` | `validate.sh`, `eval-test-calls.ts` (real vendors), `signature-parity.ts`, `check-ffmpeg.mjs`. |
| `sim/` | The end-to-end simulation. |
| `truering/` | Mirror of TrueRing's side as deployed (main @ `d7671d64`; never applied from here) + `refresh.sh`, `check.sh`, `SOURCE`. |
| `docs/DESIGN.md` | The pipeline in detail, how each requirement is met, deviations from SPEC, the review answers. |
