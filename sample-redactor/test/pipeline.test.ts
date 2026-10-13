import { describe, expect, it } from "vitest";
import { bleepPcm } from "@/lib/audio";
import { redactedLines, spansJson } from "@/lib/artifacts";
import { snapHighlight } from "@/lib/labels";
import { safeValue } from "@/lib/log";
import { bleepIntervals, ruleSpans } from "@/lib/pii/detect";
import { secondPassReasons } from "@/lib/qa";
import { signBody, verifySignature } from "@/lib/signature";
import { codeFromError, jobError } from "@/lib/errors";
import { fromAssemblyAi } from "@/lib/words";
import { script } from "./helpers";

describe("bleep DSP", () => {
  it("replaces speech with a -12 dBFS 1 kHz tone and leaves the rest untouched", () => {
    const sr = 16000;
    const pcm = new Int16Array(sr * 2).fill(20000);   // loud "speech"
    bleepPcm(pcm, sr, [{ start_ms: 500, end_ms: 1500 }]);
    const inside = pcm.slice(sr * 0.6, sr * 1.4);
    const peak = Math.max(...Array.from(inside, Math.abs));
    expect(peak).toBeGreaterThan(8000);
    expect(peak).toBeLessThanOrEqual(Math.ceil(Math.pow(10, -12 / 20) * 32767));
    expect(pcm[sr * 0.25]).toBe(20000);
    expect(pcm[sr * 1.75]).toBe(20000);
    // no original sample survives inside the interval
    expect(Array.from(pcm.slice(sr * 0.5, sr * 1.5)).some((v) => v === 20000)).toBe(false);
  });
});

describe("highlight", () => {
  it("clamps to 3–8 min and never starts or ends inside a bleep", () => {
    const bleeps = [{ start_ms: 59_000, end_ms: 61_000 }, { start_ms: 299_000, end_ms: 301_000 }];
    const h = snapHighlight({ start_ms: 60_000, end_ms: 300_000 }, bleeps, 1_800_000)!;
    expect(h.start_ms).toBeGreaterThanOrEqual(61_000);
    expect(h.end_ms).toBeLessThanOrEqual(299_000);
    const long = snapHighlight({ start_ms: 0, end_ms: 900_000 }, [], 1_800_000)!;
    expect(long.end_ms - long.start_ms).toBe(480_000);
    expect(snapHighlight({ start_ms: 0, end_ms: 60_000 }, [], 60_000)).toBeNull();   // call too short
  });
});

describe("signature", () => {
  it("round-trips and rejects tampering, staleness and missing secrets", () => {
    const body = JSON.stringify({ job_id: "x" });
    const h = signBody("s3cret", body, 1_000_000);
    expect(verifySignature("s3cret", h, body, 1_000_100)).toEqual({ ok: true });
    expect(verifySignature("s3cret", h, body + " ", 1_000_100)).toEqual({ ok: false, reason: "mismatch" });
    expect(verifySignature("s3cret", h, body, 1_000_400)).toEqual({ ok: false, reason: "stale" });
    expect(verifySignature(undefined, h, body, 1_000_100)).toEqual({ ok: false, reason: "unconfigured" });
    expect(verifySignature("s3cret", "t=1,v1=zz", body, 1)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("no PII in logs or errors", () => {
  it("log values that look like text are omitted", () => {
    expect(safeValue("job_123")).toBe("job_123");
    expect(safeValue("my ssn is 927 61 4432")).toBe("[omitted]");
    expect(safeValue("Harold Pemberton")).toBe("[omitted]");
    expect(safeValue(42)).toBe(42);
  });
  it("only job errors keep their detail; anything else keeps just its class", () => {
    expect(codeFromError(jobError("bad_audio", "expected 2 channels"))).toEqual({ code: "bad_audio", detail: "expected 2 channels" });
    expect(codeFromError(new TypeError("Harold Pemberton 927614432"))).toEqual({ code: "internal", detail: "TypeError" });
  });
});

describe("redacted transcript + spans file", () => {
  it("replaces PII words and keeps no original text in spans", () => {
    const t = script([[1, "my social is"], [1, "nine two seven six one four four three two"], [1, "thanks"]], { gapMs: 700 });
    t.utterances = [{ u: 0, ch: 1, start: t.words[0].start, end: t.words[t.words.length - 1].end, from: 0, to: t.words.length - 1 }];
    const spans = ruleSpans(t, []);
    const bleeps = bleepIntervals(spans, 250, t.durationMs!);
    const [line] = redactedLines(t, spans, bleeps, 0, 250, t.durationMs!);
    expect(line.text).toBe("my social is [REDACTED:DIGITS] thanks");
    expect(line.speaker).toBe("agent");
    const sj = JSON.stringify(spansJson(spans, 250, t.durationMs!));
    expect(sj).not.toMatch(/nine|seven|social/);
    expect(Object.keys(JSON.parse(sj)[0]).sort()).toEqual(
      ["channel", "confidence", "detector", "end_ms", "padded_end_ms", "padded_start_ms", "start_ms", "type"],
    );
  });
});

describe("second pass", () => {
  it("flags digits that survived outside a bleep, ignores the tone's own transcription", () => {
    const t2 = fromAssemblyAi({
      id: "x", status: "completed", audio_channels: 1,
      words: [
        { text: "beep", start: 1000, end: 1300, confidence: 0.4 },
        { text: "4", start: 1100, end: 1200, confidence: 0.4 },
        { text: "5", start: 1200, end: 1300, confidence: 0.4 },
        { text: "6", start: 1300, end: 1400, confidence: 0.4 },
        { text: "7", start: 1400, end: 1450, confidence: 0.4 },
        { text: "call", start: 9000, end: 9300, confidence: 0.9 },
        { text: "555", start: 9300, end: 9600, confidence: 0.9 },
        { text: "0198", start: 9600, end: 9900, confidence: 0.9 },
      ],
    });
    const reasons = secondPassReasons(t2, [{ start_ms: 900, end_ms: 1600 }], ["pemberton"], [], new Set());
    expect(reasons).toEqual(["second_pass_digit_run@9300ms"]);
  });
});
