// Failing inputs found in review (2026-10-12), kept as regressions. All values fictional.
import { describe, expect, it } from "vitest";
import { digitRuns, entitySpans, nameTerms, patternMatches, ruleSpans } from "@/lib/pii/detect";
import { locate } from "@/lib/pii/llm";
import { secondPassReasons } from "@/lib/qa";
import type { Word } from "@/lib/words";
import { fromAssemblyAi } from "@/lib/words";
import { covered, idx, script } from "./helpers";

const w = (i: number, text: string, start: number, end: number, ch: 0 | 1): Word => ({ i, text, start, end, conf: 0.95, ch });

describe("review regressions", () => {
  it("entity on the speaker who said it, not on the one talking over it", () => {
    const words = [w(0, "Smith", 1000, 1500, 1), w(1, "okay", 1400, 1450, 0)];
    const spans = entitySpans(words, [{ entity_type: "person_name", start: 1000, end: 1500, text: "Smith" }], true);
    expect(spans).toHaveLength(1);
    expect(spans[0].channel).toBe(1);
    expect(spans[0].start_ms).toBe(1000);
    expect(nameTerms(words, spans)).toEqual(["smith"]);
  });

  it("spoken emails in common ASR shapes", () => {
    for (const line of [
      "it's loretta52 at gmail.com",
      "my email is jsmith at gmail",
      "harold dot pemberton at cox dot net",
      "hpemberton at earthlink dot net",
      "loretta dot q dot fifty two at gmail dot com",
    ]) {
      const t = script([[1, line]]);
      const spans = patternMatches(t.words).filter((s) => s.type === "EMAIL");
      const local = t.words.filter((x) => !["it's", "my", "email", "is"].includes(x.text.toLowerCase()));
      const missed = local.filter((x) => !covered(spans, t, x.i)).map((x) => x.text);
      expect({ line, missed }).toEqual({ line, missed: [] });
    }
  });

  it("hyphen-spelled names", () => {
    const t = script([[1, "my last name is Q-U-I-N-L-A-N"]]);
    expect(ruleSpans(t, []).some((s) => s.type === "SPELLED" && covered([s], t, idx(t, "q-u-i-n-l-a-n")[0]))).toBe(true);
  });

  it("possessive and hyphenated quotes map back to words", () => {
    expect(locate([{ i: 4, text: "Pemberton's" }], "Pemberton")).toEqual([[4, 4]]);
    expect(locate([{ i: 1, text: "Mary-Ann" }, { i: 2, text: "Lee" }], "Mary Ann Lee")).toEqual([[1, 2]]);
  });

  it("a count word at the tail of an ID still gets bleeped", () => {
    const t = script([[1, "five five five oh one nine eight, day or night"]]);
    const spans = digitRuns(t.words);
    expect(covered(spans, t, idx(t, "eight")[0])).toBe(true);
  });

  it("a CVV said on its own after the cue", () => {
    const t = script([[0, "and the code on the back?"], [1, "seven three one"]]);
    const spans = ruleSpans(t, []);
    for (const i of idx(t, "seven", "three", "one")) expect(covered(spans, t, i)).toBe(true);
  });

  it("second pass flags a leak right after a bleep", () => {
    const t2 = fromAssemblyAi({
      id: "x", status: "completed", audio_channels: 1,
      words: [
        { text: "eight", start: 1500, end: 1600, confidence: 0.5 },
        { text: "eight", start: 2500, end: 2600, confidence: 0.5 },
        { text: "four", start: 3100, end: 3400, confidence: 0.9 },
        { text: "five", start: 3400, end: 3700, confidence: 0.9 },
        { text: "six", start: 3700, end: 4000, confidence: 0.9 },
        { text: "seven", start: 4000, end: 4300, confidence: 0.9 },
        { text: "Harold", start: 2800, end: 3400, confidence: 0.9 },
      ],
    });
    const r = secondPassReasons(t2, [{ start_ms: 1000, end_ms: 3000 }], ["harold"], [], new Set());
    expect(r.some((x) => x.startsWith("second_pass_digit_run"))).toBe(true);
    expect(r.some((x) => x.startsWith("second_pass_name"))).toBe(true);
  });

  it("titles and relations never become call-wide bleep terms", () => {
    const t = script([[1, "doctor Patel and grandson Kevin and Aunt June and Mister Pemberton"]]);
    const ents = [[0, 1], [3, 4], [6, 7], [9, 10]].map(([a, b]) => ({ entity_type: "person_name", start: t.words[a].start, end: t.words[b].end, text: `${t.words[a].text} ${t.words[b].text}` }));
    const terms = nameTerms(t.words, entitySpans(t.words, ents, true));
    expect(terms.sort()).toEqual(["june", "kevin", "patel", "pemberton"]);
  });

  it("ordinary sales talk is not bleeped", () => {
    for (const line of ["the 10,000 plan", "a 10,000 policy", "about 25 50 a month", "at 3:30 or 4:15", "I see 2 doctors, Dr. Patel"]) {
      const t = script([[0, line]]);
      const hits = ruleSpans(t, []).map((s) => `${s.type}:${t.words.slice(s.from, s.to + 1).map((x) => x.text).join(" ")}`);
      expect({ line, hits }).toEqual({ line, hits: [] });
    }
  });

  it("review 2026-10-13: a long number said as words is bleeped even when a count noun follows", () => {
    const t = script([[1, "it's four four one two seven three nine nine eight one two days"]]);
    const spans = digitRuns(t.words);
    for (const i of idx(t, "four", "seven", "eight")) expect(covered(spans, t, i)).toBe(true);
    // amounts stay audible: comma grouping, "thousand", "$"
    for (const line of ["the 10,000 plan", "ten thousand dollars of coverage", "about 25 50 a month"]) {
      const u = script([[0, line]]);
      expect({ line, hits: digitRuns(u.words).length }).toEqual({ line, hits: 0 });
    }
  });

  it("review 2026-10-13: an MBI read with spoken dashes", () => {
    // MBI matching drops separators and is case-insensitive (ASR may give lower-case letters)
    const t = script([[1, "it's seven K D nine dash H A two dash W N five six"]]);
    const spans = ruleSpans(t, []);
    for (const i of idx(t, "seven", "dash", "six")) expect(covered(spans, t, i)).toBe(true);
    expect(spans.some((s) => s.type === "MBI")).toBe(true);
  });

  it("a single digit word longer than the window does not crash", () => {
    expect(digitRuns([w(0, "1234", 0, 9000, 0)])).toHaveLength(1);
  });
});
