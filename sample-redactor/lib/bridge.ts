// Client for TR's sample-redaction-bridge edge function. The worker's ONLY way
// into TR: job inputs, status, cost ledger, and signed storage URLs.
import { env } from "./config";
import { signBody } from "./signature";
import { jobError } from "./errors";
import { FatalError, RetryableError } from "workflow";

export type JobOptions = {
  bleep_pad_ms: number;
  pitch_shift_customer: boolean;
  redact_health: boolean;
  highlight: { enabled: boolean; target_s: number };
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
      agent_ref: string;
      vertical: string;
      caller_state: string | null;
      channel_map: { customer: 0 | 1; agent: 0 | 1; verified: boolean };
    };
    created_at: string;
    workflow_run_id: string | null;
  };
  extra_terms: string[];
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
