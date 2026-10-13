// The ai-redactor worker: one long-running Node process with no open port and no inbound traffic.
// Every POLL_S seconds it makes ONE signed call to TrueRing's sample-redaction-bridge (`poll`), which
//   - refreshes the heartbeat of every job it is running, and names the ones to stop (taken down / failed elsewhere);
//   - hands out queued jobs to claim, up to WORKER_CONCURRENCY at a time;
//   - lists finished jobs whose AssemblyAI copies still need deleting (a run that died, a takedown).
// Everything it produces goes to TrueRing through the bridge; it keeps nothing but temp files inside a step.
// SIGTERM/SIGINT: stop polling, abort running jobs (they fail as "worker restarted"; the AM retries), exit.
//   npm start            (env: see .env.example)
import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { deleteTranscript } from "../lib/assemblyai";
import { poll, vendorPurged } from "../lib/bridge";
import { errorCode, log } from "../lib/log";
import { runJob } from "../lib/job";
import { sleep } from "../lib/retry";
import { selfCheck } from "./check";

const POLL_MS = Math.max(2, Number(process.env.POLL_S) || 20) * 1000;
const CONCURRENCY = Math.min(6, Math.max(1, Number(process.env.WORKER_CONCURRENCY) || 2));
const ALIVE_FILE = process.env.ALIVE_FILE ?? "/tmp/ai-redactor-alive";   // Docker HEALTHCHECK reads its age
const WORKER_ID = `w_${hostname().replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40)}_${process.pid}_${randomUUID().slice(0, 8)}`;

type Running = { runId: string; ctrl: AbortController; done: Promise<void> };
const running = new Map<string, Running>();
const cleaning = new Set<string>();
const stopping = new AbortController();

function startJob(jobId: string, key: string) {
  const runId = `run_${randomUUID().replace(/-/g, "")}`;
  const ctrl = new AbortController();
  log("job_started", { job_id: jobId, run_id: runId });
  const done = runJob(jobId, key, runId, ctrl.signal)
    .then((r) => log("job_ended", { job_id: jobId, run_id: runId, status: r.status, ...("error_code" in r ? { code: r.error_code } : {}) }))
    .catch((e) => log("job_crashed", { job_id: jobId, code: errorCode(e) }))
    .finally(() => running.delete(jobId));
  running.set(jobId, { runId, ctrl, done });
}

/** A job no live run owns: delete its leftover AssemblyAI copies, tell TR (a pending takedown completes). */
async function cleanUp(jobId: string, transcriptIds: string[]) {
  cleaning.add(jobId);
  try {
    const deleted: string[] = [];
    for (const id of transcriptIds) if (await deleteTranscript(id)) deleted.push(id);
    const r = await vendorPurged(jobId, WORKER_ID, deleted);
    log("cleanup_done", { job_id: jobId, deleted: deleted.length, failed: transcriptIds.length - deleted.length, takedown_done: r.deleted });
  } catch (e) {
    log("cleanup_failed", { job_id: jobId, code: errorCode(e) });   // offered again on the next poll
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
  while (!stopping.signal.aborted) {
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
    // back off while the bridge is down (max 5 min); a running job keeps its own retries
    await sleep(Math.min(POLL_MS * 2 ** Math.min(failures, 4), 300_000), stopping.signal).catch(() => {});
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
