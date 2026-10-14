// The ai-redactor worker: one long-running Node process with no open port and no inbound traffic.
// Every POLL_S seconds it makes ONE signed call to TrueRing's sample-redaction-bridge (`poll`), which
//   - refreshes the heartbeat of every job it is running, and names the ones to stop (cancelled / failed / deleted);
//   - hands out queued jobs to claim, up to WORKER_CONCURRENCY at a time;
//   - lists finished jobs whose AssemblyAI copies still need deleting (e.g. a run that died).
// Everything it produces goes to TrueRing through the bridge; it keeps nothing but temp files inside a step.
// SIGTERM/SIGINT: stop polling, abort running jobs (they fail as "worker restarted"; the AM retries), exit.
//   npm start            (env: see .env.example)
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { deleteTranscript, listTranscriptsBetween } from "../lib/assemblyai";
import { poll, vendorPurged } from "../lib/bridge";
import { errorCode, log } from "../lib/log";
import { runJob } from "../lib/job";
import { pollBackoffMs, sleep } from "../lib/retry";
import { selfCheck } from "./check";

const POLL_MS = Math.max(2, Number(process.env.POLL_S) || 20) * 1000;
const CONCURRENCY = Math.min(6, Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 2));
const ALIVE_FILE = process.env.ALIVE_FILE ?? "/tmp/ai-redactor-alive";   // Docker HEALTHCHECK reads its age
// Orphan sweep: no job may run past 2 h (the bridge fails it), so a transcript on this worker's AssemblyAI account
// that is older than 2 h 15 m belongs to no live job. It is a leftover, e.g. from a worker killed between
// submitting the audio and recording the transcript id with TR, so nobody else knows to delete it. The key
// must be dedicated to this worker.
const ORPHAN_AGE_MS = (Number(process.env.ORPHAN_AGE_S) || 8100) * 1000;
const ORPHAN_SWEEP_MS = (Number(process.env.ORPHAN_SWEEP_S) || 1800) * 1000;
const ORPHAN_LOOKBACK_MS = 48 * 3600 * 1000;
const WORKER_ID = `w_${hostname().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}_${process.pid}_${randomUUID().slice(0, 8)}`;

type Running = { runId: string; ctrl: AbortController; done: Promise<void>; asrIds: string[] };
const running = new Map<string, Running>();
const cleaning = new Set<string>();
const stopping = new AbortController();

function startJob(jobId: string, key: string) {
  const runId = `run_${randomUUID().replace(/-/g, "")}`;
  const ctrl = new AbortController();
  log("job_started", { job_id: jobId, run_id: runId });
  const asrIds: string[] = [];   // filled by runJob as it submits; the orphan sweep never touches these
  const done = runJob(jobId, key, runId, ctrl.signal, asrIds)
    .then((r) => log("job_ended", { job_id: jobId, run_id: runId, status: r.status, ...("error_code" in r ? { code: r.error_code } : {}) }))
    .catch((e) => log("job_crashed", { job_id: jobId, code: errorCode(e) }))
    .finally(() => running.delete(jobId));
  running.set(jobId, { runId, ctrl, done, asrIds });
}

let sweeping = false;
async function sweepOrphans(mine: Set<string>) {
  if (sweeping) return;
  sweeping = true;
  try {
    const now = Date.now();
    const old = await listTranscriptsBetween(new Date(now - ORPHAN_LOOKBACK_MS), new Date(now - ORPHAN_AGE_MS));
    // already-deleted ones keep a placeholder audio_url; this worker's own running jobs are never touched
    const todo = old.filter((t) => !mine.has(t.id) && !String(t.audio_url ?? "").includes("deleted_by_user"));
    let deleted = 0;
    for (const t of todo) if (await deleteTranscript(t.id)) deleted++;
    log("orphan_sweep", { listed: old.length, deleted, failed: todo.length - deleted });
  } catch (e) {
    log("orphan_sweep_failed", { code: errorCode(e) });
  } finally {
    sweeping = false;
  }
}

/** A finished job no live run owns: delete its leftover AssemblyAI copies and tell TR (that unblocks a delete). */
async function cleanUp(jobId: string, transcriptIds: string[]) {
  cleaning.add(jobId);
  try {
    const deleted: string[] = [];
    for (const id of transcriptIds) if (await deleteTranscript(id)) deleted.push(id);
    const r = await vendorPurged(jobId, WORKER_ID, deleted);
    log("cleanup_done", { job_id: jobId, deleted: deleted.length, failed: transcriptIds.length - deleted.length, left: r.left });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("NO_JOB")) log("cleanup_job_gone", { job_id: jobId });   // TR deleted the call meanwhile
    else log("cleanup_failed", { job_id: jobId, code: errorCode(e) });   // offered again on the next poll
  } finally {
    cleaning.delete(jobId);
  }
}

async function main() {
  const check = await selfCheck({ bridge: true, worker: WORKER_ID });
  if (!check.ok) {
    log("worker_refused_to_start", { missing_env: check.missing_env.join(",") || "none", ffmpeg: check.ffmpeg.ok, bridge: check.bridge?.ok ?? false });
    process.exit(1);
  }
  log("worker_up", { worker: WORKER_ID, concurrency: CONCURRENCY, poll_s: POLL_MS / 1000, pipeline: check.pipeline_version, ffmpeg: check.ffmpeg.version ?? "" });

  let failures = 0;
  let nextSweep = Date.now() + Math.min(ORPHAN_SWEEP_MS, 60_000);   // first sweep soon after start, then every ORPHAN_SWEEP_S
  while (!stopping.signal.aborted) {
    if (Date.now() >= nextSweep) {
      nextSweep = Date.now() + ORPHAN_SWEEP_MS;
      void sweepOrphans(new Set([...running.values()].flatMap((r) => r.asrIds)));
    }
    try {
      const p = await poll(WORKER_ID, [...running].map(([job_id, r]) => ({ job_id, run_id: r.runId })), CONCURRENCY - running.size);
      for (const id of p.stop) {
        const r = running.get(id);
        if (r && !r.ctrl.signal.aborted) { log("job_stop_requested", { job_id: id }); r.ctrl.abort("stop"); }
      }
      for (const c of p.cleanup) if (!running.has(c.job_id) && !cleaning.has(c.job_id)) void cleanUp(c.job_id, c.transcript_ids);
      for (const j of p.jobs) if (running.size < CONCURRENCY && !running.has(j.job_id)) startJob(j.job_id, j.idempotency_key);
      if (p.lost) log("bridge_failed_lost_jobs", { count: p.lost });
      try { writeFileSync(ALIVE_FILE, String(Date.now())); } catch { /* read-only fs: health by logs only */ }
      failures = 0;
    } catch (e) {
      failures++;
      log("poll_failed", { code: errorCode(e), in_a_row: failures });
    }
    // back off while the bridge is down (max 120 s, so heartbeats stay fresh); a running job keeps its own retries
    await sleep(pollBackoffMs(POLL_MS, failures), stopping.signal).catch(() => {});
  }
}

async function shutdown(sig: string) {
  if (stopping.signal.aborted) return;
  log("worker_stopping", { signal: sig, running: running.size });
  stopping.abort("shutdown");
  for (const r of running.values()) r.ctrl.abort("shutdown");
  const all = Promise.allSettled([...running.values()].map((r) => r.done));
  await Promise.race([all, sleep(25_000)]);
  log("worker_stopped", { left_running: running.size });
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

main().catch((e) => { log("worker_crashed", { code: errorCode(e) }); process.exit(1); });
