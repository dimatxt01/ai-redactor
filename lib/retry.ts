// Step retries inside the worker: anything but FatalError is retried
// (RetryableError after its own delay hint), up to `attempts` tries. Everything is abortable.
import { FatalError, RetryableError } from "./errors";

const MAX_WAIT_MS = 60_000;
// Poll backoff while the bridge is down: doubles from POLL_S, capped at 120 s (TrueRing's ask). Heartbeats travel
// on the poll, so the gap between two polls (cap + 30 s request timeout) must stay well inside TR's
// SAMPLE_WORKER_STALE_S (300 s), or a short TR outage would get running jobs failed as stale.
export const POLL_BACKOFF_MAX_MS = 120_000;
export const pollBackoffMs = (pollMs: number, failures: number): number =>
  Math.min(pollMs * 2 ** Math.min(failures, 4), POLL_BACKOFF_MAX_MS);

/** Resolves after `ms`, or rejects with the signal's reason as soon as it aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(t); reject(signal!.reason); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRetry<T>(fn: (attempt: number) => Promise<T>, opts: { signal?: AbortSignal; attempts?: number } = {}): Promise<T> {
  const attempts = opts.attempts ?? 4;
  for (let attempt = 1; ; attempt++) {
    opts.signal?.throwIfAborted();
    try {
      return await fn(attempt);
    } catch (e) {
      if (e instanceof FatalError || attempt >= attempts || opts.signal?.aborted) throw e;
      const wait = e instanceof RetryableError ? e.retryAfterMs : 2000 * attempt;
      await sleep(Math.min(wait, MAX_WAIT_MS), opts.signal);
    }
  }
}
