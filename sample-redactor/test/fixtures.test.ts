// The planted test calls, with scripted word timings, through the rule pass.
// Every planted value a rule can know must be covered; model-only kinds
// (health, beneficiary, city) are covered by AssemblyAI entities / the LLM and
// are measured on real audio by `npm run eval`. The control call must stay clean.
import { describe, expect, it } from "vitest";
import { ruleSpans } from "@/lib/pii/detect";
import { loadScripts, MODEL_ONLY } from "@/fixtures/parse";
import { covered, script } from "./helpers";

const CARRIERS = ["Mutual of Omaha"];

for (const call of loadScripts()) {
  describe(call.name, () => {
    const customerCh = 0 as const, agentCh = 1 as const;
    const t = script(call.lines.map((l) => [l.speaker === "customer" ? customerCh : agentCh, l.text]));
    // word index of each line's first token
    const lineStart: number[] = [];
    let n = 0;
    for (const l of call.lines) { lineStart.push(n); n += l.tokens.length; }
    const terms = [...call.agent.split(" "), ...call.caller.split(" "), ...CARRIERS];
    const spans = ruleSpans(t, terms);

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
    } else {
      it("bleeps nothing in a call with no personal information", () => {
        expect(spans.map((s) => `${s.type}:${t.words.slice(s.from, s.to + 1).map((w) => w.text).join(" ")}`)).toEqual([]);
      });
    }
  });
}
