// POST /api/delete — TR's delete-every-copy action (and its 2h sweep), the worker's half:
// cancel the job's runs and wait until they stopped (an in-flight step finishes
// first), delete AssemblyAI's transcripts, and schedule a re-purge of TR storage
// for after every signed upload URL has expired. TR purges its storage itself now.
// Auth: X-TR-Signature with SAMPLE_REDACTOR_START_SECRET. Body: {job_ids[], run_ids[], transcript_ids[]}.
import { getRun, start } from "workflow/api";
import { purgeLater } from "@/workflows/redact-call";
import { deleteTranscript } from "@/lib/assemblyai";
import { verifySignature } from "@/lib/signature";
import { errorCode, log } from "@/lib/log";

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = verifySignature(process.env.SAMPLE_REDACTOR_START_SECRET, req.headers.get("x-tr-signature"), raw);
  if (!sig.ok) {
    log("delete_rejected", { reason: sig.reason });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { run_ids?: unknown; transcript_ids?: unknown; job_ids?: unknown };
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const runIds = (Array.isArray(body.run_ids) ? body.run_ids : []).map(String).filter((s) => /^[A-Za-z0-9_-]{4,100}$/.test(s)).slice(0, 50);
  const transcriptIds = (Array.isArray(body.transcript_ids) ? body.transcript_ids : []).map(String).filter((s) => /^[A-Za-z0-9_-]{6,80}$/.test(s)).slice(0, 100);

  const jobIds = (Array.isArray(body.job_ids) ? body.job_ids : []).map(String).filter((s) => /^[0-9a-f-]{36}$/i.test(s)).slice(0, 50);

  const failed: string[] = [];
  const cancelled: string[] = [];
  for (const id of runIds) {
    try {
      const run = getRun(id);
      if (!(await run.exists)) continue;   // nothing left that could write
      const status = await run.status;
      if (status !== "completed" && status !== "failed" && status !== "cancelled") {
        await run.cancel({ cancelReason: "sample deleted by TR admin" });
        cancelled.push(id);
      }
    } catch (e) {
      log("delete_run_cancel_failed", { run_id: id, code: errorCode(e) });
      failed.push(`run:${id}`);
    }
  }
  // wait (bounded) for cancelled runs to really stop, so TR's re-read of transcript ids is complete
  const deadline = Date.now() + 30_000;
  for (const id of cancelled) {
    const run = getRun(id);
    while (Date.now() < deadline) {
      const st = await run.status;
      if (st === "cancelled" || st === "completed" || st === "failed") break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    const st = await run.status;
    if (st !== "cancelled" && st !== "completed" && st !== "failed") failed.push(`run_still_stopping:${id}`);
  }
  for (const id of transcriptIds) if (!(await deleteTranscript(id))) failed.push(`asr:${id}`);
  if (jobIds.length) await start(purgeLater, [jobIds]);

  log("delete_done", { runs: runIds.length, transcripts: transcriptIds.length, jobs: jobIds.length, failed: failed.length });
  return Response.json({ ok: failed.length === 0, failed }, { status: failed.length ? 207 : 200 });
}
