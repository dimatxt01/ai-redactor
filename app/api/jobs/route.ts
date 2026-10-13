// POST /api/jobs — TR (sample-library-admin) starts a redaction run for one job.
// Auth: X-TR-Signature with SAMPLE_REDACTOR_START_SECRET. Body: {job_id, idempotency_key}.
// Starting the same job twice is harmless: the second run loses the bridge claim and exits.
import { start } from "workflow/api";
import { verifySignature } from "@/lib/signature";
import { log } from "@/lib/log";
import { RUN_OPTIONS } from "@/lib/config";
import { redactCall } from "@/workflows/redact-call";

export async function POST(req: Request) {
  const raw = await req.text();
  const sig = verifySignature(process.env.SAMPLE_REDACTOR_START_SECRET, req.headers.get("x-tr-signature"), raw);
  if (!sig.ok) {
    log("start_rejected", { reason: sig.reason });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  let body: { job_id?: unknown; idempotency_key?: unknown };
  try { body = JSON.parse(raw); } catch { return Response.json({ error: "bad json" }, { status: 400 }); }
  const jobId = String(body.job_id ?? "");
  if (!/^[0-9a-f-]{36}$/i.test(jobId)) return Response.json({ error: "job_id required" }, { status: 400 });

  const key = String(body.idempotency_key ?? "");
  if (!/^call:[0-9a-f-]{36}:v\d+$/.test(key)) return Response.json({ error: "idempotency_key required" }, { status: 400 });
  // the run's claim checks this key against the job row (bridge), so a signed start can't pair a job with another key
  const run = await start(redactCall, [jobId, key], RUN_OPTIONS);
  log("run_started", { job_id: jobId, run_id: run.runId, key });
  return Response.json({ run_id: run.runId }, { status: 202 });
}
