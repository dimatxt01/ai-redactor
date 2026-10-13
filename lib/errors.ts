// Job-level failure codes (sample_redaction_jobs.error_code). A JobError ends the
// job; its message is short and generic — it lands in the worker log and
// in error_detail, so it must never contain transcript text.
/** Not retried: the job ends with this error. */
export class FatalError extends Error {
  constructor(message: string) { super(message); this.name = "FatalError"; }
}
/** Transient (network, 429, 5xx): the step is retried after `retryAfter` ("20s", "1m"). */
export class RetryableError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, opts: { retryAfter?: string } = {}) {
    super(message);
    this.name = "RetryableError";
    const m = /^(\d+)(s|m)$/.exec(opts.retryAfter ?? "");
    this.retryAfterMs = m ? Number(m[1]) * (m[2] === "m" ? 60_000 : 1000) : 10_000;
  }
}

export type JobErrorCode =
  | "fetch_expired"
  | "bad_audio"
  | "asr_failed"
  | "timeout"
  | "unsupported_source"
  | "cost_cap"
  | "internal";

export const JOB_ERROR_CODES: JobErrorCode[] = [
  "fetch_expired",
  "bad_audio",
  "asr_failed",
  "timeout",
  "unsupported_source",
  "cost_cap",
  "internal",
];

/** Fatal (not retried) job failure. The code rides in the message prefix so it survives serialization. */
export function jobError(code: JobErrorCode, detail: string): FatalError {
  return new FatalError(`${code}: ${detail}`);
}

export function codeFromError(e: unknown): { code: JobErrorCode; detail: string } {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /^([a-z_]+): (.*)$/s.exec(msg);
  if (m && (JOB_ERROR_CODES as string[]).includes(m[1])) return { code: m[1] as JobErrorCode, detail: m[2].slice(0, 300) };
  return { code: "internal", detail: (e instanceof Error ? e.name : "error").slice(0, 80) };
}

/** Another run owns this job (duplicate start). Not a failure of the job. */
export const DUPLICATE_RUN = "DUPLICATE_RUN";
