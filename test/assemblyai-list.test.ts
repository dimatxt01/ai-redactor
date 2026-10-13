import { afterEach, describe, expect, it, vi } from "vitest";
import { listTranscriptsBetween } from "@/lib/assemblyai";

describe("orphan sweep listing", () => {
  process.env.ASSEMBLYAI_API_KEY = "test";
  afterEach(() => vi.unstubAllGlobals());
  const iso = (hAgo: number) => new Date(Date.now() - hAgo * 3600_000).toISOString();

  it("returns only transcripts inside [notBefore, olderThan), following prev_url until the window is passed", async () => {
    const pages: Record<string, unknown> = {
      "https://api.assemblyai.com/v2/transcript?limit=200": {
        transcripts: [{ id: "new", status: "completed", created: iso(0.1) }, { id: "old1", status: "completed", created: iso(3) }],
        page_details: { prev_url: "https://api.assemblyai.com/v2/transcript?limit=200&before_id=old1" },
      },
      "https://api.assemblyai.com/v2/transcript?limit=200&before_id=old1": {
        transcripts: [{ id: "old2", status: "error", created: iso(10) }, { id: "ancient", status: "completed", created: iso(60) }],
        page_details: { prev_url: "https://api.assemblyai.com/v2/transcript?limit=200&before_id=ancient" },
      },
    };
    const f = vi.fn(async (url: string) => new Response(JSON.stringify(pages[url] ?? { transcripts: [] }), { status: 200 }));
    vi.stubGlobal("fetch", f);
    const now = Date.now();
    const got = await listTranscriptsBetween(new Date(now - 48 * 3600_000), new Date(now - 2.25 * 3600_000));
    expect(got.map((t) => t.id)).toEqual(["old1", "old2"]);   // "new" is too young (a live job may own it), "ancient" outside the lookback
    expect(f).toHaveBeenCalledTimes(2);                        // stopped once a page reached past the window
  });

  it("throws on an API error (the sweep logs and retries next time)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
    await expect(listTranscriptsBetween(new Date(0), new Date())).rejects.toThrow("assemblyai list 401");
  });
});
