# Running ai-redactor (runbook)

The worker runs as **one Docker container on one Linux host**, currently a Hetzner VM (x86-64) owned by Dmitry. It opens no port. It only makes outbound HTTPS calls: to TrueRing's `sample-redaction-bridge`, Supabase signed storage URLs, Telnyx recording links, AssemblyAI and OpenRouter.

## What is on the host

| What | Where |
|---|---|
| Code (a git checkout of this repo) | `/opt/ai-redactor` |
| Secrets (root only, `chmod 600`) | `/etc/ai-redactor.env`: `TR_BRIDGE_URL`, `SAMPLE_REDACTOR_BRIDGE_SECRET`, `ASSEMBLYAI_API_KEY`, `OPENROUTER_API_KEY` |
| Container | compose project `ai-redactor`, container `ai-redactor-worker-1`, image `ai-redactor:latest` (built on the host, so ffmpeg matches its architecture). Settings: read-only, `/tmp` tmpfs (1 GB), user `node`, `restart: unless-stopped`, logs json-file 10 MB × 3. |
| Firewall | `ufw`: inbound SSH only. |

Every command below runs as root on the host and uses:

```bash
C="docker compose -f /opt/ai-redactor/deploy/docker-compose.yml"
```

## Going live (in this order)

The worker is **created but not started** until TrueRing's side is live. TrueRing's side (in `Mahamadou2004/truering` `prb/rl-worker`; each step needs its own go there) is:

1. The migration `20261013090000_sample_redaction_worker` is applied.
2. `sample-redaction-bridge` and `training-library-admin` are deployed.
3. The Supabase function secret `SAMPLE_REDACTOR_BRIDGE_SECRET` is set to **the value already on the host** (see the next section).
4. The `recording_library` flag is on for the people who will curate.

Then, on the host:

```bash
$C run --rm worker node --import tsx src/check.ts --bridge   # must print "ok": true and "bridge": {"ok": true, ...}
$C up -d
$C logs -f --tail 20     # expect worker_up, then nothing (or job_started / job_ended) every poll
```

The bridge check is one signed `poll` that claims nothing (capacity 0). If it fails:
- `401`: the secret on the two sides differs.
- `404`: the bridge function is not deployed.
- A timeout: outbound network.

Do not `up` before it passes. The worker would refuse to start, and Docker would keep restarting it.

## The shared secret

The secret was generated on the host and has never been printed or committed. To give it to TrueRing, read it straight into the clipboard from a Mac, then put it in a password manager. Don't use chat or email.

```bash
ssh root@<host> "grep ^SAMPLE_REDACTOR_BRIDGE_SECRET= /etc/ai-redactor.env | cut -d= -f2-" | pbcopy
```

TrueRing sets it with `supabase secrets set SAMPLE_REDACTOR_BRIDGE_SECRET=…` (or in the dashboard, under Edge Functions → Secrets).

**Rotating it:**
1. On the host: `sed -i "s/^SAMPLE_REDACTOR_BRIDGE_SECRET=.*/SAMPLE_REDACTOR_BRIDGE_SECRET=$(openssl rand -hex 32)/" /etc/ai-redactor.env`.
2. Copy it to TrueRing as above.
3. Run `$C up -d --force-recreate`.

Between steps 2 and 3, polls fail with 401 and the worker backs off. No job is lost.

## Every day

```bash
docker inspect ai-redactor-worker-1 --format '{{.State.Status}} {{.State.Health.Status}}'   # running healthy
$C logs --since 1h                                 # one JSON line per event
$C logs --since 24h | grep -E 'job_ended|job_crashed|poll_failed|cleanup_failed|orphan_sweep'
```

- **Healthy** means a bridge poll succeeded within the last 3 minutes. The status turns `unhealthy` while TrueRing or the network is down. The worker keeps retrying on its own, at most every 5 minutes.
- **Logs** contain ids, counts, hashes and error codes only, never names, numbers or transcript text. They rotate at 30 MB in total.
- **Events:**
  - `worker_up`: start.
  - `job_started` / `job_ended {status, code}`: one per job.
  - `job_stop_requested`: an admin cancelled or deleted the job.
  - `cleanup_done`: AssemblyAI copies deleted for a job that ended elsewhere.
  - `orphan_sweep`: every 30 minutes.
  - `poll_failed {code, in_a_row}`: the bridge or the network is down.

## Update and roll back

Stopping or restarting the container fails running jobs as "worker restarted; retry the job". The AM retries from the page. Prefer a quiet moment, and check that the last hour of logs shows no `job_started` without a matching `job_ended`.

```bash
cd /opt/ai-redactor
git rev-parse --short HEAD > /root/ai-redactor.previous    # what to roll back to
git pull --ff-only
$C build && $C run --rm worker node --import tsx src/check.ts --bridge && $C up -d
```

**To roll back:**

```bash
cd /opt/ai-redactor
git checkout "$(cat /root/ai-redactor.previous)"
$C build && $C up -d
git checkout main    # when you're done
```

A change of model or prompt always bumps `PIPELINE_VERSION` (`lib/config.ts`), so each result says which build produced it.

## Stop, pause, remove

```bash
$C stop                     # pause: running jobs fail as "worker restarted"; queued jobs wait in TrueRing
$C start                    # resume
$C down --rmi all && rm -rf /opt/ai-redactor && shred -u /etc/ai-redactor.env   # remove everything from the host
```

After a removal:
- revoke the AssemblyAI and OpenRouter keys;
- unset the TrueRing secret.

The worker keeps nothing else: no database, no volume, no bucket.

## Host notes

- **Vendor accounts:**
  - **OpenRouter:** needs prepaid credits, plus account settings that allow zero-data-retention endpoints only. Without credits every clip and coaching step fails with 402.
  - **AssemblyAI:** the key must be **used by this worker only**. The orphan sweep deletes every transcript on that account older than 2 h 15 m.
- **Reboots:** unattended-upgrades installs security updates. A kernel update needs a reboot. The container comes back by itself (`unless-stopped`), unless it was stopped on purpose.
- **One instance only.** Two are safe (the claim is a compare-and-swap), but they double the poll load.
- **Size:** for `WORKER_CONCURRENCY=2`, use 1 vCPU and **2 GB of RAM**. A 60-minute call peaks at about 300 MB in `/tmp` (the source mp3 plus the decoded 16 kHz stereo PCM) and about 0.5 GB of process memory. The tmpfs is capped at 1 GB, and it only uses RAM for what is written.
