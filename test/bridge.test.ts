import { afterEach, describe, expect, it, vi } from "vitest";
import { bridge } from "@/lib/bridge";
import { FatalError, RetryableError } from "@/lib/errors";

const answer = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

describe("bridge client: how TR's answers end a run", () => {
  process.env.TR_BRIDGE_URL = "https://example.invalid/functions/v1/sample-redaction-bridge";
  process.env.SAMPLE_REDACTOR_BRIDGE_SECRET = "test-secret";
  afterEach(() => vi.unstubAllGlobals());

  it("404 NO_JOB (TR hard-deleted the call) → NO_JOB, fatal: the run stops and never fails the job", async () => {
    vi.stubGlobal("fetch", answer(404, { error: "no such job", error_code: "NO_JOB" }));
    const e = await bridge("status", { job_id: "x" }).catch((x) => x);
    expect(e).toBeInstanceOf(FatalError);
    expect(String(e.message)).toMatch(/^NO_JOB/);
  });

  it("409 JOB_TERMINAL (cancelled / failed elsewhere) → JOB_TERMINAL, fatal", async () => {
    vi.stubGlobal("fetch", answer(409, { error_code: "JOB_TERMINAL" }));
    const e = await bridge("status", { job_id: "x" }).catch((x) => x);
    expect(e).toBeInstanceOf(FatalError);
    expect(String(e.message)).toMatch(/^JOB_TERMINAL/);
  });

  it("5xx → retryable; domain codes → job errors with the same code", async () => {
    vi.stubGlobal("fetch", answer(503, {}));
    expect(await bridge("poll", {}).catch((x) => x)).toBeInstanceOf(RetryableError);
    vi.stubGlobal("fetch", answer(422, { error_code: "fetch_expired", error: "gone" }));
    expect(String((await bridge("source", {}).catch((x) => x)).message)).toMatch(/^fetch_expired:/);
  });

  it("signs every request", async () => {
    const f = answer(200, { ok: true });
    vi.stubGlobal("fetch", f);
    await bridge("poll", { worker: "w" });
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)["X-TR-Signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
  });
});
