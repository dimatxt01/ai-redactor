import { describe, expect, it } from "vitest";
import { FatalError, RetryableError } from "@/lib/errors";
import { sleep, withRetry } from "@/lib/retry";

describe("step retries (worker runtime)", () => {
  it("retries transient errors, then succeeds", async () => {
    let n = 0;
    const r = await withRetry(async (attempt) => { n++; if (attempt < 3) throw new RetryableError("bridge 503", { retryAfter: "0s" }); return attempt; });
    expect(r).toBe(3);
    expect(n).toBe(3);
  });

  it("never retries a FatalError (the job ends with its code)", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new FatalError("fetch_expired: gone"); })).rejects.toThrow("fetch_expired");
    expect(n).toBe(1);
  });

  it("gives up after the attempt limit", async () => {
    let n = 0;
    await expect(withRetry(async () => { n++; throw new RetryableError("down", { retryAfter: "0s" }); }, { attempts: 2 })).rejects.toThrow("down");
    expect(n).toBe(2);
  });

  it("an abort (takedown / shutdown) stops a wait and a retry loop at once, with its reason", async () => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort("stop"), 20);
    const t0 = Date.now();
    await expect(sleep(10_000, ctrl.signal)).rejects.toBe("stop");
    expect(Date.now() - t0).toBeLessThan(1000);
    await expect(withRetry(async () => 1, { signal: ctrl.signal })).rejects.toBe("stop");
  });

  it("parses retryAfter hints", () => {
    expect(new RetryableError("x", { retryAfter: "20s" }).retryAfterMs).toBe(20_000);
    expect(new RetryableError("x", { retryAfter: "1m" }).retryAfterMs).toBe(60_000);
    expect(new RetryableError("x").retryAfterMs).toBe(10_000);
  });
});
