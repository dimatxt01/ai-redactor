import { describe, expect, it } from "vitest";
import { bleepPcm } from "@/lib/audio";
import { redactedLines, spansJson } from "@/lib/artifacts";
import { buildClips, clipCap, repairAnswer, snapClip, validateAnswer, type RedactedLine } from "@/lib/labels";
import { safeValue } from "@/lib/log";
import { bleepIntervals, ruleSpans } from "@/lib/pii/detect";
import { clipReasons, secondPassReasons, textPiiReasons } from "@/lib/qa";
import { signBody, verifySignature } from "@/lib/signature";
import { codeFromError, jobError } from "@/lib/errors";
import { fromAssemblyAi } from "@/lib/words";
import { script } from "./helpers";

describe("bleep DSP", () => {
  it("replaces speech with soft pink noise at -30 dBFS RMS, fades it, and leaves the rest untouched", () => {
    const sr = 16000;
    const pcm = new Int16Array(sr * 2).fill(20000);   // loud "speech"
    bleepPcm(pcm, sr, [{ start_ms: 500, end_ms: 1500 }]);
    const inside = Array.from(pcm.slice(sr * 0.6, sr * 1.4));
    const rmsDb = 20 * Math.log10(Math.sqrt(inside.reduce((s, v) => s + v * v, 0) / inside.length) / 32767);
    expect(rmsDb).toBeGreaterThan(-31);
    expect(rmsDb).toBeLessThan(-29);
    expect(Math.max(...inside.map(Math.abs))).toBeLessThan(Math.pow(10, -10 / 20) * 32767);   // soft: no peak near full scale
    expect(Math.abs(pcm[sr * 0.5])).toBeLessThan(50);    // fades in from silence
    expect(pcm[sr * 0.25]).toBe(20000);
    expect(pcm[sr * 1.75]).toBe(20000);
    // no original sample survives inside the interval
    expect(Array.from(pcm.slice(sr * 0.5, sr * 1.5)).some((v) => v === 20000)).toBe(false);
  });

  it("is reproducible (seeded) and pink: more energy low than high", () => {
    const sr = 16000, iv = [{ start_ms: 0, end_ms: 2000 }];
    const a = new Int16Array(sr * 2), b = new Int16Array(sr * 2).fill(123);
    bleepPcm(a, sr, iv);
    bleepPcm(b, sr, iv);
    expect(Array.from(a)).toEqual(Array.from(b));
    // first difference ~ high frequencies: for pink noise its energy is well below the signal's own
    let e = 0, d = 0;
    for (let k = 1; k < a.length; k++) { e += a[k] * a[k]; d += (a[k] - a[k - 1]) ** 2; }
    expect(d / e).toBeLessThan(1);   // white noise gives ~2
  });
});

// one utterance every 10 s, 9 s long
const L = (n: number): RedactedLine[] =>
  Array.from({ length: n }, (_, u) => ({ u, speaker: u % 2 ? "customer" : "agent", start_ms: u * 10_000, end_ms: u * 10_000 + 9_000, text: `line ${u}` }));
const scores = { rapport: 4, discovery: 3, objections: null, close: null, compliance: 5 };
const answer = (clips: object[], extra: object = {}) => ({
  clips: clips.map((c) => ({ label: "opener", sub_label: "none", from_u: 0, to_u: 3, title: "t", did: "d", worked: "w", improve: "i",
    key_line_ids: [1], scores, confidence: 0.9, ...c })),
  call: { summary: "s", strengths: ["a", "b", "c"], improvements: ["x", "y", "z"], scores: { ...scores, objections: 3, close: 4 }, turning_point_clip: 0, ...extra },
});

describe("smart clips (SPEC v0.2 §2.6)", () => {
  it("snaps to utterance boundaries inside 20–240 s", () => {
    const lines = L(60);
    expect(snapClip(2, 5, lines, [], 600_000)).toEqual({ start_ms: 20_000, end_ms: 59_000 });
    // too long (0..40 = 409 s) trims whole utterances from the end
    const long = snapClip(0, 40, lines, [], 600_000)!;
    expect(long.end_ms - long.start_ms).toBeLessThanOrEqual(240_000);
    expect(lines.some((l) => l.end_ms === long.end_ms)).toBe(true);
    // too short (one 9 s line) grows to the next lines
    const short = snapClip(7, 7, lines, [], 600_000)!;
    expect(short.end_ms - short.start_ms).toBeGreaterThanOrEqual(20_000);
    expect(short.start_ms).toBe(70_000);
  });
  it("never starts or ends inside a bleep", () => {
    const lines = L(60);
    const bleeps = [{ start_ms: 19_500, end_ms: 21_000 }, { start_ms: 58_000, end_ms: 60_500 }];
    const c = snapClip(2, 5, lines, bleeps, 600_000)!;
    const inside = (t: number) => bleeps.some((b) => t > b.start_ms && t < b.end_ms);
    expect(inside(c.start_ms) || inside(c.end_ms)).toBe(false);
    expect(c.start_ms).toBe(30_000);   // moved to the next utterance start
    // u5's end is bleeped: back to u4 (49 s), too short (19 s), so it grows past the bleeped u5 end to u6
    expect(c.end_ms).toBe(69_000);
  });
  it("returns null when no window fits", () => {
    expect(snapClip(0, 1, L(2), [], 19_000)).toBeNull();
  });
  it("validates the answer: taxonomy-only rules, counts, ids, scores", () => {
    const lines = L(30);
    expect(validateAnswer(answer([{}]) as never, lines, 6)).toEqual([]);
    expect(validateAnswer(answer(Array(7).fill({})) as never, lines, 6)).toContain("clips: at most 6");
    expect(validateAnswer(answer([{ to_u: 99 }]) as never, lines, 6).join()).toMatch(/ids that appear/);
    expect(validateAnswer(answer([{ label: "objection" }]) as never, lines, 6).join()).toMatch(/sub_label/);
    expect(validateAnswer(answer([{ sub_label: "price" }]) as never, lines, 6).join()).toMatch(/sub_label/);
    expect(validateAnswer(answer([{ scores: { ...scores, rapport: 7 } }]) as never, lines, 6).join()).toMatch(/rapport/);
    expect(validateAnswer(answer([{}], { strengths: ["a"] }) as never, lines, 6).join()).toMatch(/exactly 3/);
    expect(validateAnswer(answer([{}], { turning_point_clip: 3 }) as never, lines, 6).join()).toMatch(/turning_point/);
  });
  it("caps the clip count by what the call can hold (real eval: a 44 s call got 5 clips with invented line ids)", () => {
    expect(clipCap(44_000)).toBe(2);
    expect(clipCap(18_000)).toBe(0);
    expect(clipCap(3_600_000)).toBe(6);
    expect(clipCap(600_000, 3)).toBe(3);
  });
  it("repairs or drops a bad clip instead of throwing the whole answer away", () => {
    const lines = L(30);
    const a = answer([
      {},                                                              // fine
      { from_u: 40, to_u: 44 },                                        // ids that don't exist → dropped
      { label: "objection", sub_label: "none", key_line_ids: [99], confidence: 3, scores: { ...scores, rapport: 9 } },
      { label: "close", sub_label: "price" },
    ], { turning_point_clip: 2 });
    const r = repairAnswer(a as never, lines, 6);
    expect(r.problems).toEqual([]);
    expect(r.dropped).toEqual(["clip_bad_ids:opener"]);
    expect(r.answer.clips).toHaveLength(3);
    const obj = r.answer.clips[1];
    expect(obj.sub_label).toBe("other");
    expect(obj.key_line_ids).toEqual([obj.from_u]);
    expect(obj.confidence).toBe(1);
    expect(obj.scores.rapport).toBeNull();
    expect(r.answer.clips[2].sub_label).toBe("none");
    expect(r.answer.call.turning_point_clip).toBe(1);                  // followed to the kept clip
    expect(validateAnswer(r.answer as never, lines, 6)).toEqual([]);   // the repaired answer is fully valid
    // over the cap: the extra clips are cut; a turning point on a dropped clip becomes "none"
    const capped = repairAnswer(answer([{}, {}, {}], { turning_point_clip: 2 }) as never, lines, 2);
    expect(capped.answer.clips).toHaveLength(2);
    expect(capped.dropped).toEqual(["clip_over_cap:opener"]);
    expect(capped.answer.call.turning_point_clip).toBe(-1);
    // call-level problems are not repaired: they are retried
    expect(repairAnswer(answer([{}], { strengths: ["a"] }) as never, lines, 6).problems.join()).toMatch(/exactly 3/);
  });
  it("orders clips c1..cN by time, keeps application audio out, quotes only redacted lines", () => {
    const lines = L(60).map((l) => (l.u === 41 ? { ...l, text: "my date of birth is [REDACTED:DOB]" } : l));
    const a = answer([
      { label: "application", from_u: 40, to_u: 45, key_line_ids: [41] },
      { label: "objection", sub_label: "price", from_u: 10, to_u: 14 },
    ], { turning_point_clip: 1 });
    const { clips, coaching } = buildClips(a as never, lines, [], 600_000, "m");
    expect(clips.map((c) => [c.clip_id, c.label, c.audio_exported])).toEqual([["c1", "objection", true], ["c2", "application", false]]);
    expect(clips[1].coaching.key_lines).toEqual(["my date of birth is [REDACTED:DOB]"]);
    expect(coaching.turning_point_clip_id).toBe("c1");
    expect(coaching.rubric).toBe("fe_v1");
  });
});

describe("second pass on clips and coaching text (SPEC v0.2 §2.8)", () => {
  it("maps full-audio hits into the clips that contain them", () => {
    const clips = [
      { clip_id: "c1", start_ms: 0, end_ms: 60_000, audio_exported: true },
      { clip_id: "c2", start_ms: 50_000, end_ms: 90_000, audio_exported: false },
    ];
    expect(clipReasons(["second_pass_digit_run@55000ms", "second_pass_name@95000ms"], clips)).toEqual(["second_pass_clip:c1:second_pass_digit_run@55000ms"]);
  });
  it("flags digits, MBIs and names in generated text, not ordinary coaching", () => {
    const r = textPiiReasons([
      { where: "call.summary", text: "The agent built rapport and closed on the $45.50 a month plan." },
      { where: "c1.did", text: "Read back 5 5 5 0 1 9 8 to confirm." },
      { where: "c2.did", text: "Thanked Harold for his time." },
      { where: "c3.did", text: "Noted 1EG4-TE5-MK73 for the file." },
    ], ["harold"]);
    expect(r).toEqual(["coaching_pii:c1.did:digit_run", "coaching_pii:c2.did:name", "coaching_pii:c3.did:digit_run", "coaching_pii:c3.did:mbi"]);
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
