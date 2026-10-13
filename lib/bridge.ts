// Client for TR's sample-redaction-bridge edge function. The worker's ONLY way
// into TR: job inputs, status, cost ledger, and signed storage URLs.
import { env } from "./config";
import { signBody } from "./signature";
import { FatalError, jobError, RetryableError } from "./errors";

export type JobOptions = {
  bleep_pad_ms: number;
  pitch_shift_customer: boolean;
  redact_health: boolean;
  clips: { enabled: boolean; max_per_call: number; min_s: number; max_s: number };
  coaching: { enabled: boolean; rubric: "fe_v1" };
  extra_terms: string[];
  customer_channel: 0 | 1;
};

export type JobInputs = {
  job: {
    id: string;
    call_id: string;
    version: number;
    status: string;
    options: JobOptions;
    call_meta: {
      duration_s: number;
      disposition: string | null;
      vertical: string;
      caller_state: string | null;
      channel_map: { customer: 0 | 1; agent: 0 | 1; verified: boolean };
    };
    created_at: string;
    workflow_run_id: string | null;   // the run that claimed the job (column name kept from the earlier design)
  };
  extra_terms: string[];
  idempotency_key: string;
  caps: { job_usd: number; month_usd: number; spent_usd: number; asr_usd_per_hour: number };
};

export type SignOp = { target: "work" | "library"; name: string; mode: "upload" | "download" };

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- callers name T; untyped calls read loose JSON
export async function bridge<T = any>(action: string, payload: Record<string, unknown>): Promise<T> {
  const raw = JSON.stringify({ action, ...payload });
  let res: Response;
  try {
    res = await fetch(env("TR_BRIDGE_URL"), {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-TR-Signature": signBody(env("SAMPLE_REDACTOR_BRIDGE_SECRET"), raw) },
      body: raw,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new RetryableError("bridge unreachable", { retryAfter: "20s" });
  }
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) return body as T;
  const code = String(body.error_code ?? "UNKNOWN");
  if (res.status >= 500 || code === "RETRY") throw new RetryableError(`bridge ${res.status} ${code}`, { retryAfter: "20s" });
  // Domain codes the job cannot recover from become job errors with the same code.
  if (["fetch_expired", "unsupported_source", "cost_cap"].includes(code)) {
    throw jobError(code as "fetch_expired" | "unsupported_source" | "cost_cap", String(body.error ?? code).slice(0, 200));
  }
  // Another run owns the job, or it already ended: stop this run without touching the job.
  if (code === "DUPLICATE_RUN" || code === "JOB_TERMINAL") throw new FatalError(`${code}: bridge ${res.status}`);
  throw new FatalError(`internal: bridge ${res.status} ${code}`);
}

export async function signUrls(jobId: string, runId: string, ops: SignOp[]): Promise<Record<string, string>> {
  const { urls } = await bridge<{ urls: Record<string, { url: string }> }>("sign", { job_id: jobId, run_id: runId, ops });
  return Object.fromEntries(Object.entries(urls).map(([k, v]) => [k, v.url]));
}

/** PUT bytes to a Supabase signed upload URL. */
export async function uploadSigned(url: string, body: Buffer | Uint8Array | string, contentType: string): Promise<void> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": contentType, "x-upsert": "true" },
    body: typeof body === "string" ? body : new Uint8Array(body),
    signal: AbortSignal.timeout(300_000),
  });
  if (!res.ok) throw new RetryableError(`upload ${res.status}`, { retryAfter: "15s" });
}

export async function downloadSigned(url: string): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok) throw new RetryableError(`download ${res.status}`, { retryAfter: "15s" });
  return Buffer.from(await res.arrayBuffer());
}

export async function putWork(jobId: string, runId: string, name: string, body: Buffer | string, type: string) {
  const urls = await signUrls(jobId, runId, [{ target: "work", name, mode: "upload" }]);
  await uploadSigned(urls[`work:${name}:upload`], body, type);
}

export async function getWork(jobId: string, runId: string, name: string): Promise<Buffer> {
  const urls = await signUrls(jobId, runId, [{ target: "work", name, mode: "download" }]);
  return downloadSigned(urls[`work:${name}:download`]);
}

export async function getWorkJson<T>(jobId: string, runId: string, name: string): Promise<T> {
  return JSON.parse((await getWork(jobId, runId, name)).toString("utf8")) as T;
}

export type Poll = {
  jobs: { job_id: string; idempotency_key: string }[];   // queued, to claim (at most `capacity`)
  stop: string[];                                         // jobs this worker runs that were taken down / failed elsewhere
  cleanup: { job_id: string; transcript_ids: string[] }[]; // no live run: vendor copies to delete, takedowns to finish
  lost: number;                                            // running jobs the bridge just failed (their worker went quiet)
};

/** The worker's one regular call: heartbeats for the jobs it runs, plus work to pick up. */
export function poll(worker: string, running: { job_id: string; run_id: string }[], capacity: number): Promise<Poll> {
  return bridge<Poll>("poll", { worker, running, capacity });
}

/** Tell TR these AssemblyAI transcripts are deleted (the owning run reports here last; it also ends the heartbeat). */
export function vendorPurged(jobId: string, runId: string, transcriptIds: string[]) {
  return bridge<{ ok: true; left: number; deleted: boolean }>("vendor_purged", { job_id: jobId, run_id: runId, transcript_ids: transcriptIds });
}
