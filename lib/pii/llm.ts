// LLM entity labels on top of the timestamped transcript. The model sees
// utterance ids + text and returns verbatim quotes with a type; quotes are
// mapped back to AssemblyAI word indices here. The model never produces times.
import { z } from "zod";
import { llmJson } from "../openrouter";
import type { Transcript } from "../words";
import { norm, utteranceWords } from "../words";
import { spanOf, type PiiType, type Span } from "./detect";

const LLM_TYPES = [
  "PERSON_NAME", "BENEFICIARY", "PHONE", "ADDRESS", "DOB", "AGE", "SSN", "CARD", "CVV", "CARD_EXPIRY", "BANK",
  "EMAIL", "POLICY_NUMBER", "ID_NUMBER", "MBI", "HEALTH", "MEDICATION",
] as const;

const Schema = z.object({
  items: z.array(
    z.object({
      u: z.number().int(),
      quote: z.string(),
      type: z.enum(LLM_TYPES),
      confidence: z.number(),
    }),
  ),
});

const SYSTEM = `You label personal information in a phone sales call between a final-expense insurance agent and a customer.
Each line is "u<id> <SPEAKER>: <text>". Return EVERY piece of personal information, as an exact verbatim quote copied from ONE line, with that line's id.
Types:
PERSON_NAME any person's first/last name or nickname (customer, agent, family, doctors); BENEFICIARY a beneficiary's name;
PHONE; ADDRESS street, city, county or ZIP; DOB date of birth; AGE a stated age; SSN; CARD card number; CVV; CARD_EXPIRY;
BANK routing/account numbers or bank name tied to the customer; EMAIL; POLICY_NUMBER policy/application/confirmation numbers;
ID_NUMBER any other identifying number (driver's license etc.); MBI Medicare number; HEALTH medical conditions, diagnoses,
procedures, hospital stays; MEDICATION drug names and doses.
Rules: quote the shortest text that fully contains the item; include spelled-out forms ("five five five", "B as in boy");
the same item said twice is two items; when unsure, include it with lower confidence (0-1). Never invent text.`;

export async function llmPiiSpans(
  t: Transcript,
  opts: { customerChannel: 0 | 1; redactHealth: boolean; chunkWords?: number; onCost?: (usd: number) => Promise<void> },
): Promise<{ spans: Span[]; unmatched: number; costUsd: number; calls: number; model: string }> {
  const chunkWords = opts.chunkWords ?? 2500;
  const chunks: string[][] = [];
  let cur: string[] = [], n = 0;
  const uw = t.utterances.map((u) => utteranceWords(t, u));
  t.utterances.forEach((u, k) => {
    const words = uw[k];
    const speaker = u.ch === opts.customerChannel ? "CUSTOMER" : "AGENT";
    cur.push(`u${u.u} ${speaker}: ${words.map((w) => w.text).join(" ")}`);
    n += words.length;
    if (n >= chunkWords) { chunks.push(cur); cur = []; n = 0; }
  });
  if (cur.length) chunks.push(cur);

  const spans: Span[] = [];
  let unmatched = 0, costUsd = 0, model = "";
  for (const lines of chunks) {
    const r = await llmJson({ schemaName: "pii_items", schema: Schema, system: SYSTEM, user: lines.join("\n"), onCost: opts.onCost });
    costUsd += r.costUsd;
    model = r.model;
    for (const it of r.data.items) {
      if (!opts.redactHealth && (it.type === "HEALTH" || it.type === "MEDICATION")) continue;
      const u = t.utterances[it.u];
      if (!u) { unmatched++; continue; }
      const found = locate(uw[it.u], it.quote);
      if (!found.length) { unmatched++; continue; }
      const conf = Math.max(0, Math.min(1, it.confidence));
      for (const [from, to] of found) {
        const s = spanOf(t.words, it.type as PiiType, "llm", from, to);
        // detection confidence: the lower of the model's and the ASR's
        spans.push({ ...s, confidence: Math.min(s.confidence, Math.round(conf * 1000) / 1000) });
      }
    }
  }
  return { spans, unmatched, costUsd, calls: chunks.length, model };
}

/** Every occurrence of the quote's tokens as a contiguous run of the utterance's words → [fromIdx, toIdx]. */
export function locate(words: { i: number; text: string }[], quote: string): [number, number][] {
  // compare piece by piece: "Mary-Ann" ≡ "Mary Ann", "Pemberton's" ≡ "Pemberton"
  const pieces = (s: string) => norm(s).replace(/'s$/, "").split("-").filter(Boolean);
  const q = quote.split(/\s+/).flatMap(pieces);
  const ws: { p: string; i: number }[] = words.flatMap((w) => pieces(w.text).map((p) => ({ p, i: w.i })));
  if (!q.length) return [];
  const out: [number, number][] = [];
  for (let k = 0; k + q.length <= ws.length; k++) {
    let ok = true;
    for (let m = 0; m < q.length; m++) if (ws[k + m].p !== q[m]) { ok = false; break; }
    if (ok) out.push([ws[k].i, ws[k + q.length - 1].i]);
  }
  return out;
}
