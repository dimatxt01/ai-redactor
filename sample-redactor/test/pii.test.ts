// Planted fake PII → every planted word must be inside a span. All values are fictional.
import { describe, expect, it } from "vitest";
import {
  bleepIntervals, digitRuns, entitySpans, mbiMatches, nameTerms, patternMatches, ruleSpans, termMatches, MBI_RE,
} from "@/lib/pii/detect";
import { tokenize } from "@/lib/pii/spoken";
import { covered, idx, script } from "./helpers";

describe("spoken numbers", () => {
  it("turns number words into digits with context rules", () => {
    const t = script([[0, "my number is five five five oh one two three"]]);
    const toks = tokenize(t.words);
    expect(toks.map((x) => x.digits).join("")).toBe("5550123");
  });
  it("double / triple / twenty-one / hundred", () => {
    const t = script([[0, "double oh seven twenty one triple five five hundred"]]);
    const d = tokenize(t.words).map((x) => x.digits).join("|");
    expect(d).toBe("|00|7|2|1||555|5|00");
  });
  it("oh is a word outside digit context", () => {
    const t = script([[0, "oh I see okay"]]);
    expect(tokenize(t.words).every((x) => x.digits === "")).toBe(true);
  });
  it("ordinals count only next to a month", () => {
    const a = tokenize(script([[0, "born March third nineteen forty eight"]]).words).map((x) => x.digits).join("");
    const b = tokenize(script([[0, "hold on one second please"]]).words).map((x) => x.digits).join("");
    expect(a).toBe("31948");
    expect(b).toBe("1");
  });
  it("phonetic letters", () => {
    const toks = tokenize(script([[0, "it is B as in boy then K for king"]]).words);
    expect(toks.map((x) => x.chars).join("")).toBe("BK");
  });
});

describe("digit runs", () => {
  it("catches an SSN read digit by digit", () => {
    const t = script([[1, "it's one two three four five six seven eight nine"]]);
    const spans = digitRuns(t.words);
    for (const i of idx(t, "one", "two", "three", "four", "five", "six", "seven", "eight", "nine")) expect(covered(spans, t, i)).toBe(true);
  });
  it("catches a run split across speaker turns (read-back)", () => {
    const t = script([[1, "zip is three oh"], [0, "three oh"], [1, "one"]], { gapMs: 200 });
    const spans = digitRuns(t.words);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    expect(spans.some((s) => s.channel === 0)).toBe(true);
    expect(spans.some((s) => s.channel === 1)).toBe(true);
  });
  it("catches ASR numerals", () => {
    const t = script([[1, "card number 4111 1111 1111 1111 expires 09/29"]]);
    const spans = digitRuns(t.words);
    for (const i of idx(t, "4111", "1111", "09/29")) expect(covered(spans, t, i)).toBe(true);
  });
  it("leaves three isolated digits alone", () => {
    const t = script([[0, "I have two kids and one dog"], [1, "nice"], [0, "and five grandkids"]]);
    expect(digitRuns(t.words)).toHaveLength(0);
  });
  it("does not join digits more than 8 s apart", () => {
    const t = script([[0, "two kids"], [1, "x ".repeat(30)], [0, "two dogs"]]);
    expect(digitRuns(t.words)).toHaveLength(0);
  });
});

describe("MBI", () => {
  it("regex matches a CMS-format id", () => {
    expect("1EG4TE5MK73".match(MBI_RE)).toEqual(["1EG4TE5MK73"]);
    expect("1EG4TE5MK7".match(MBI_RE)).toBeNull();
    expect("1SG4TE5MK73".match(MBI_RE)).toBeNull();   // S is never used
  });
  it("finds a spelled MBI with phonetic letters and dashes", () => {
    const t = script([[1, "one E as in echo G four dash T E five dash M K seven three"]]);
    const spans = mbiMatches(t.words);
    expect(spans).toHaveLength(1);
    expect(spans[0].type).toBe("MBI");
    expect(spans[0].from).toBe(0);
    expect(spans[0].to).toBe(t.words.length - 1);
  });
  it("finds an MBI the ASR wrote as tokens", () => {
    const t = script([[1, "it's 1EG4-TE5-MK73 okay"]]);
    expect(mbiMatches(t.words)).toHaveLength(1);
  });
});

describe("patterns", () => {
  it("spoken and written email", () => {
    const t = script([[1, "it's jane doe forty at gmail dot com"], [0, "or jdoe@example.com"]]);
    const spans = patternMatches(t.words).filter((s) => s.type === "EMAIL");
    for (const i of idx(t, "jane", "doe", "at", "gmail", "dot", "com", "jdoe@example.com")) expect(covered(spans, t, i)).toBe(true);
  });
  it("street address and apartment", () => {
    const t = script([[1, "I live at 1234 Maple Grove Road apartment 5"]]);
    const spans = patternMatches(t.words).filter((s) => s.type === "ADDRESS");
    for (const i of idx(t, "1234", "maple", "grove", "road", "apartment", "5")) expect(covered(spans, t, i)).toBe(true);
  });
  it("date of birth with the month", () => {
    const t = script([[1, "born on July 4th 1950"]]);
    const spans = patternMatches(t.words).filter((s) => s.type === "DOB");
    for (const i of idx(t, "july", "4th", "1950")) expect(covered(spans, t, i)).toBe(true);
  });
});

describe("terms and names", () => {
  it("multi-word extra terms and every name mention", () => {
    const t = script([[0, "this is Dana Whitfield with Mutual of Omaha"], [1, "hi Dana"]]);
    const spans = termMatches(t.words, ["Dana", "Whitfield", "Mutual of Omaha"], "EXTRA_TERM", "extra_term");
    for (const i of idx(t, "dana", "whitfield", "mutual", "of", "omaha")) expect(covered(spans, t, i)).toBe(true);
  });
  it("names from entities become global terms", () => {
    const t = script([[1, "my wife Marlene handles it"], [0, "so Marlene is the beneficiary"]]);
    const ent = entitySpans(t.words, [{ entity_type: "person_name", start: t.words[2].start, end: t.words[2].end }], true);
    const terms = nameTerms(t.words, ent);
    expect(terms).toEqual(["marlene"]);
    const all = termMatches(t.words, terms, "PERSON_NAME", "model");
    expect(all).toHaveLength(2);
  });
  it("health entities obey redact_health", () => {
    const t = script([[1, "I take metformin for diabetes"]]);
    const ents = [
      { entity_type: "drug", start: t.words[2].start, end: t.words[2].end },
      { entity_type: "medical_condition", start: t.words[4].start, end: t.words[4].end },
    ];
    expect(entitySpans(t.words, ents, true).map((s) => s.type)).toEqual(["MEDICATION", "HEALTH"]);
    expect(entitySpans(t.words, ents, false)).toHaveLength(0);
  });
});

describe("bleep intervals", () => {
  it("pads 250 ms and merges gaps under 500 ms", () => {
    const base = { type: "DIGITS" as const, detector: "digit_run" as const, from: 0, to: 0, channel: 0 as const, confidence: 1 };
    const iv = bleepIntervals(
      [
        { ...base, start_ms: 1000, end_ms: 2000 },
        { ...base, start_ms: 2900, end_ms: 3000 },   // padded: 2650 vs 2250 → gap 400 → merge
        { ...base, start_ms: 5000, end_ms: 5100 },
      ],
      250,
      10_000,
    );
    expect(iv).toEqual([
      { start_ms: 750, end_ms: 3250 },
      { start_ms: 4750, end_ms: 5350 },
    ]);
  });
});

describe("whole rule pass on a planted call", () => {
  it("covers every planted value", () => {
    const t = script([
      [0, "thanks for calling this is Dana with Mutual of Omaha"],
      [1, "hi my name is Harold Pemberton"],
      [0, "can I get your date of birth"],
      [1, "March third nineteen forty eight"],
      [0, "and your social"],
      [1, "five two seven"],
      [1, "six one"],
      [1, "four four three two"],
      [0, "and the best phone number"],
      [1, "three one two five five five oh one nine eight"],
      [0, "your Medicare number"],
      [1, "one E as in echo G four T E five M K seven three"],
    ]);
    const spans = ruleSpans(t, ["Dana", "Harold", "Pemberton", "Mutual of Omaha"]);
    const planted = idx(t, "dana", "mutual", "omaha", "harold", "pemberton", "march", "third", "nineteen", "forty", "eight",
      "five", "two", "seven", "six", "one", "four", "three", "oh", "nine", "e", "echo", "g", "t", "m", "k");
    const missed = planted.filter((i) => !covered(spans, t, i)).map((i) => t.words[i].text);
    expect(missed).toEqual([]);
  });
});
