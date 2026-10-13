// The planted test calls, with scripted word timings, through the rule pass.
// Every planted value a rule can know must be covered; model-only kinds
// (health, beneficiary, city) are covered by AssemblyAI entities / the LLM and
// are measured on real audio by `npm run eval`. Control calls (no planted values)
// and `# strict` calls may not have anything outside a planted value bleeped.
import { describe, expect, it } from "vitest";
import { ruleSpans } from "@/lib/pii/detect";
import { expandRepeats, loadScripts, MODEL_ONLY, parseScript } from "@/fixtures/parse";
import { covered, script } from "./helpers";

const CARRIERS = ["Mutual of Omaha"];
const calls = loadScripts();

describe("fixture set (SPEC v0.2 §7)", () => {
  it("has 12 synthetic two-speaker calls, each with both speakers", () => {
    expect(calls.map((c) => c.name)).toEqual([
      "01-classic-sale", "02-readback-and-spelling", "03-ids-and-boxes", "04-no-pii-control", "05-mbi-and-dashes", "06-crosstalk",
      "07-bank-and-card", "08-beneficiary-health", "09-objections", "10-long-call", "11-numbers-not-pii", "12-long-number-words",
    ]);
    for (const c of calls) {
      expect(new Set(c.lines.map((l) => l.speaker)), c.name).toEqual(new Set(["agent", "customer"]));
      expect(c.agent && c.caller, c.name).toBeTruthy();
      const bare = (ws: string[]) => ws.map((w) => w.replace(/[.,?!]+$/, "")).join(" ");   // "]]." puts the stop on the last token
      for (const p of c.planted) expect(bare(c.lines[p.line].tokens.slice(p.from, p.to + 1)), `${c.name} ${p.kind}`).toBe(bare(p.text.split(/\s+/)));
    }
  });

  it("covers the planted kinds the spec lists", () => {
    const kinds = new Set(calls.flatMap((c) => c.planted.map((p) => p.kind)));
    for (const k of ["NAME", "PHONE", "ADDRESS", "DOB", "AGE", "SSN", "CARD", "CARD_EXPIRY", "CVV", "BANK", "EMAIL", "POLICY", "MBI", "HEALTH", "MEDICATION", "BENEFICIARY"]) {
      expect(kinds.has(k), k).toBe(true);
    }
  });

  it("06 overlaps speakers; 10 runs long with values late in the call", () => {
    expect(calls.find((c) => c.name === "06-crosstalk")!.lines.filter((l) => l.overlap_ms > 0).length).toBeGreaterThanOrEqual(3);
    const long = calls.find((c) => c.name === "10-long-call")!;
    const words = long.lines.reduce((n, l) => n + l.tokens.length, 0);
    expect(words).toBeGreaterThan(7000);   // ≈ 45+ min at TTS pace (the real length is in fixtures/out/*.planted.json)
    const lastWordAt = (line: number) => long.lines.slice(0, line).reduce((n, l) => n + l.tokens.length, 0);
    expect(Math.max(...long.planted.map((p) => lastWordAt(p.line))) / words).toBeGreaterThan(0.95);
  });

  it("markup: crosstalk offsets and seeded repeat blocks", () => {
    const s = parseScript("t", "# meta: agent=A B; caller=C D\nA: hi\nC: >>-1500 hello there");
    expect(s.lines.map((l) => [l.text, l.overlap_ms])).toEqual([["hi", 0], ["hello there", 1500]]);
    const src = "# repeat 6\nA: {red|green|blue} {cat|dog} {sat|ran|slept|hid}\n# end";
    const a = expandRepeats("x", src).split("\n");
    expect(a).toEqual(expandRepeats("x", src).split("\n"));   // deterministic
    expect(a).toHaveLength(6);
    expect(new Set(a).size).toBeGreaterThan(1);               // repeats differ
    expect(() => expandRepeats("x", "# repeat 2\nA: no end")).toThrow(/no # end/);
  });
});

for (const call of calls) {
  describe(call.name, () => {
    const customerCh = 0 as const, agentCh = 1 as const;
    const t = script(call.lines.map((l) => [l.speaker === "customer" ? customerCh : agentCh, l.text]));
    // word index of each line's first token
    const lineStart: number[] = [];
    let n = 0;
    for (const l of call.lines) { lineStart.push(n); n += l.tokens.length; }
    const terms = [...call.agent.split(" "), ...call.caller.split(" "), ...CARRIERS];
    const spans = ruleSpans(t, terms);
    const plantedIdx = new Set(call.planted.flatMap((p) => Array.from({ length: p.to - p.from + 1 }, (_, k) => lineStart[p.line] + p.from + k)));

    const ruleKinds = call.planted.filter((p) => !MODEL_ONLY.has(p.kind));
    if (ruleKinds.length) {
      it("covers every rule-detectable planted value", () => {
        const missed: string[] = [];
        for (const p of ruleKinds) {
          for (let k = p.from; k <= p.to; k++) {
            const i = lineStart[p.line] + k;
            if (!covered(spans, t, i)) missed.push(`${p.kind}:${t.words[i].text}`);
          }
        }
        expect(missed).toEqual([]);
      });
    }
    if (!call.planted.length) {
      it("bleeps nothing in a call with no personal information", () => {
        expect(spans.map((s) => `${s.type}:${t.words.slice(s.from, s.to + 1).map((w) => w.text).join(" ")}`)).toEqual([]);
      });
    }
    if (call.strict) {
      it("bleeps nothing outside the planted values (# strict)", () => {
        const extra = new Set<string>();
        for (const s of spans) {
          for (let i = s.from; i <= s.to; i++) {
            if (t.words[i].ch === s.channel && !plantedIdx.has(i)) extra.add(`${s.type}:${t.words[i].text}`);
          }
        }
        expect([...extra]).toEqual([]);
      });
    }
  });
}
