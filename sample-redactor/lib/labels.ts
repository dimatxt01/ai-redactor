// Fixed clip labels, highlight pick and coaching — one OpenRouter call over the
// REDACTED transcript (the model never sees PII here). The model answers in
// utterance ids; times come from AssemblyAI words via the utterances.
import { z } from "zod";
import { CLIP_LABELS, HIGHLIGHT, type ClipLabel } from "./config";
import { llmJson } from "./openrouter";
import type { Interval } from "./pii/detect";

export type RedactedLine = { u: number; speaker: "customer" | "agent"; start_ms: number; end_ms: number; text: string };

const Label = z.enum(CLIP_LABELS);
const Schema = z.object({
  segments: z.array(z.object({ label: Label, from_u: z.number().int(), to_u: z.number().int() })),
  highlight: z.object({ from_u: z.number().int(), to_u: z.number().int() }),
  coaching: z.object({
    summary: z.string(),
    strengths: z.array(z.object({ label: Label, note: z.string() })),
    improvements: z.array(z.object({ label: Label, note: z.string() })),
    objections: z.array(z.object({ from_u: z.number().int(), note: z.string(), handled: z.boolean() })),
  }),
});

const SYSTEM = (targetS: number) => `You review a final-expense insurance sales call (the sale closed) for a training library.
Lines are "u<id> [mm:ss] SPEAKER: text". Personal details are already replaced by [REDACTED:TYPE]; never guess them.
1. segments: cover the call in order with these labels only: ${CLIP_LABELS.join(", ")}. Each segment is a contiguous from_u..to_u range.
2. highlight: one contiguous range of about ${Math.round(targetS / 60)} minutes (between ${HIGHLIGHT.minS / 60} and ${HIGHLIGHT.maxS / 60}) that best teaches a new agent, ideally opener → objection → close.
3. coaching: a 2-3 sentence summary; strengths and improvements for the AGENT, each tagged with one label; each customer objection with where it starts and whether the agent handled it.
Be concrete and short. Use only the ids that appear.`;

export type Segment = { label: ClipLabel; start_ms: number; end_ms: number; from_u: number; to_u: number };

export async function labelCall(lines: RedactedLine[], targetS: number, onCost?: (usd: number) => Promise<void>) {
  const fmt = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  const r = await llmJson({
    schemaName: "call_labels",
    schema: Schema,
    system: SYSTEM(targetS),
    user: lines.map((l) => `u${l.u} [${fmt(l.start_ms)}] ${l.speaker.toUpperCase()}: ${l.text}`).join("\n"),
    onCost,
  });
  const byU = new Map(lines.map((l) => [l.u, l]));
  const clampU = (u: number) => Math.max(lines[0].u, Math.min(lines[lines.length - 1].u, u));
  const at = (u: number) => byU.get(clampU(u)) ?? nearest(lines, u);
  const segments: Segment[] = r.data.segments
    .filter((s) => s.to_u >= s.from_u)
    .map((s) => ({ label: s.label, from_u: s.from_u, to_u: s.to_u, start_ms: at(s.from_u).start_ms, end_ms: at(s.to_u).end_ms }));
  return {
    segments,
    highlight: { from_u: r.data.highlight.from_u, to_u: r.data.highlight.to_u, start_ms: at(r.data.highlight.from_u).start_ms, end_ms: at(r.data.highlight.to_u).end_ms },
    coaching: {
      ...r.data.coaching,
      objections: r.data.coaching.objections.map((o) => ({ ...o, start_ms: at(o.from_u).start_ms })),
    },
    costUsd: r.costUsd,
    model: r.model,
  };
}

function nearest(lines: RedactedLine[], u: number): RedactedLine {
  return lines.reduce((best, l) => (Math.abs(l.u - u) < Math.abs(best.u - u) ? l : best), lines[0]);
}

/**
 * Snap a highlight window to [minS, maxS], never starting or ending inside a
 * bleep (moved just outside it), and inside the audio. Returns null if no valid window fits.
 */
export function snapHighlight(win: Interval, bleeps: Interval[], durationMs: number): Interval | null {
  const minMs = HIGHLIGHT.minS * 1000, maxMs = HIGHLIGHT.maxS * 1000;
  let { start_ms, end_ms } = win;
  if (end_ms - start_ms > maxMs) end_ms = start_ms + maxMs;
  if (end_ms - start_ms < minMs) end_ms = Math.min(durationMs, start_ms + minMs);
  if (end_ms - start_ms < minMs) start_ms = Math.max(0, end_ms - minMs);
  for (const b of bleeps) {
    if (start_ms > b.start_ms && start_ms < b.end_ms) start_ms = b.end_ms + 100;
    if (end_ms > b.start_ms && end_ms < b.end_ms) end_ms = Math.max(start_ms, b.start_ms - 100);
  }
  start_ms = Math.max(0, start_ms);
  end_ms = Math.min(durationMs, end_ms);
  const len = end_ms - start_ms;
  if (len < minMs - 30_000 || len > maxMs) return null;   // allow a bleep to trim up to 30 s off the minimum
  return { start_ms: Math.round(start_ms), end_ms: Math.round(end_ms) };
}
