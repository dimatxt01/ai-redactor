// Smart clips + coaching (SPEC v0.2 §2.6–2.7) — one OpenRouter call over the REDACTED
// transcript (the model never sees PII here). The model answers in utterance ids; times
// come from AssemblyAI words via the utterances, and quotes are copied from the redacted
// lines by id, so no output text can restore a bleeped value.
// Deterministic: fixed taxonomy + rubric, temperature 0, seed; the answer is validated
// (schema + rules) and retried ONCE with the error; still invalid => no clips, `labels_invalid`.
import { z } from "zod";
import { CLIP_LABELS, CLIPS, NO_AUDIO_LABELS, OBJECTION_SUBLABELS, RUBRIC, type ClipLabel } from "./config";
import { llmJsonOnce } from "./openrouter";
import type { Interval } from "./pii/detect";

export type RedactedLine = { u: number; speaker: "customer" | "agent"; start_ms: number; end_ms: number; text: string };
type Dim = (typeof RUBRIC.dims)[number];
export type Scores = Record<Dim, number | null>;

const Score = z.number().int().nullable();
const ScoreSet = z.object({ rapport: Score, discovery: Score, objections: Score, close: Score, compliance: Score });
const Schema = z.object({
  clips: z.array(z.object({
    label: z.enum(CLIP_LABELS),
    sub_label: z.enum([...OBJECTION_SUBLABELS, "none"]),
    from_u: z.number().int(),
    to_u: z.number().int(),
    title: z.string(),
    did: z.string(),
    worked: z.string(),
    improve: z.string(),
    key_line_ids: z.array(z.number().int()),
    scores: ScoreSet,
    confidence: z.number(),
  })),
  call: z.object({
    summary: z.string(),
    strengths: z.array(z.string()),
    improvements: z.array(z.string()),
    scores: ScoreSet,
    turning_point_clip: z.number().int(),
  }),
});
type Answer = z.infer<typeof Schema>;

const SYSTEM = (maxClips: number) => `You coach final-expense insurance agents. This call ended in a Sale; you prepare it for an internal training library.
Lines are "u<id> [mm:ss] SPEAKER: text". Personal details are already replaced by [REDACTED:TYPE]; never guess, restore or describe them.
1. clips: up to ${maxClips} of the most teachable moments, in call order, each a contiguous from_u..to_u range of about ${CLIPS.minS}–${CLIPS.maxS} seconds.
   label: one of ${CLIP_LABELS.join(", ")}. sub_label: for objection one of ${OBJECTION_SUBLABELS.join(", ")}; "none" for every other label.
   title: 3–8 words. did: what the agent did. worked: what worked. improve: one concrete improvement. key_line_ids: the ids of 1–2 key lines inside the clip.
   scores (rubric ${RUBRIC.id}, 1–5, null when the clip does not show that dimension): ${RUBRIC.dims.join(", ")}. confidence: 0–1 that the label is right.
2. call: summary of how the sale went in 3–5 sentences; exactly 3 strengths and 3 improvements for the AGENT; overall scores (1–5 each, no nulls);
   turning_point_clip: the index (0-based) in your clips list of the moment the sale turned.
Be concrete and short. Use only ids that appear. Do not quote personal details.`;

export type Clip = {
  clip_id: string;
  label: ClipLabel;
  sub_label: string | null;
  start_ms: number;
  end_ms: number;
  audio_exported: boolean;
  title: string;
  coaching: { did: string; worked: string; improve: string; key_lines: string[]; scores: Scores };
  confidence: number;
};
export type CallCoaching = {
  outcome: "Sale";
  summary: string;
  strengths: string[];
  improvements: string[];
  scores: Scores;
  turning_point_clip_id: string | null;
  rubric: typeof RUBRIC.id;
  model: string;
};
export type ClipResult =
  | { ok: true; clips: Clip[]; coaching: CallCoaching; dropped: string[]; costUsd: number; model: string; attempts: number }
  | { ok: false; error: string; costUsd: number; model: string; attempts: number };

/** Rules the schema can't express. Returns problems in terms of field names only (no model text). */
export function validateAnswer(a: Answer, lines: RedactedLine[], maxClips: number): string[] {
  const ids = new Set(lines.map((l) => l.u));
  const out: string[] = [];
  const score = (s: Scores, where: string, allowNull: boolean) => {
    for (const d of RUBRIC.dims) {
      const v = s[d];
      if (v === null ? !allowNull : !(v >= 1 && v <= 5)) out.push(`${where}.scores.${d} must be ${allowNull ? "null or " : ""}1-5`);
    }
  };
  if (a.clips.length > maxClips) out.push(`clips: at most ${maxClips}`);
  a.clips.forEach((c, i) => {
    if (!ids.has(c.from_u) || !ids.has(c.to_u)) out.push(`clips.${i}: from_u/to_u must be ids that appear`);
    if (c.to_u < c.from_u) out.push(`clips.${i}: to_u before from_u`);
    if ((c.label === "objection") === (c.sub_label === "none")) out.push(`clips.${i}.sub_label: required for objection only`);
    if (c.key_line_ids.length < 1 || c.key_line_ids.length > 2 || c.key_line_ids.some((u) => !ids.has(u))) out.push(`clips.${i}.key_line_ids: 1-2 ids that appear`);
    if (!(c.confidence >= 0 && c.confidence <= 1)) out.push(`clips.${i}.confidence: 0-1`);
    score(c.scores, `clips.${i}`, true);
  });
  if (a.call.strengths.length !== 3) out.push("call.strengths: exactly 3");
  if (a.call.improvements.length !== 3) out.push("call.improvements: exactly 3");
  score(a.call.scores, "call", false);
  if (a.clips.length && (a.call.turning_point_clip < 0 || a.call.turning_point_clip >= a.clips.length)) out.push("call.turning_point_clip: index into clips");
  return out;
}

/**
 * Snap a clip to utterance (sentence) boundaries inside [minS, maxS], never starting or ending
 * inside a bleep. Returns null when no valid window exists.
 */
export function snapClip(fromU: number, toU: number, lines: RedactedLine[], bleeps: Interval[], durationMs: number): { start_ms: number; end_ms: number } | null {
  const minMs = CLIPS.minS * 1000, maxMs = CLIPS.maxS * 1000;
  const sorted = [...lines].sort((a, b) => a.start_ms - b.start_ms);
  const i0 = sorted.findIndex((l) => l.u === fromU);
  const i1 = sorted.findIndex((l) => l.u === toU);
  if (i0 < 0 || i1 < 0 || i1 < i0) return null;
  const inBleep = (t: number) => bleeps.some((b) => t > b.start_ms && t < b.end_ms);
  const starts = sorted.map((l) => l.start_ms);
  const ends = sorted.map((l) => l.end_ms);

  let a = i0, b = i1;
  // start: the first utterance start at/after the chosen one that is not inside a bleep (within the search window)
  while (inBleep(starts[a]) && a < b && starts[a + 1] - starts[i0] <= CLIPS.snapSearchMs) a++;
  // end: the last utterance end at/before the chosen one that is not inside a bleep
  while (inBleep(ends[b]) && b > a && ends[i1] - ends[b - 1] <= CLIPS.snapSearchMs) b--;
  let start = starts[a], end = ends[b];
  // too long: drop utterances from the end; too short: grow forward, then backward
  while (end - start > maxMs && b > a) { b--; end = ends[b]; }
  // growing never lands an edge inside a bleep: skip boundaries that are
  while (end - start < minMs) {
    let nb = b + 1;
    while (nb < sorted.length && inBleep(ends[nb])) nb++;
    if (nb >= sorted.length || ends[nb] - start > maxMs) break;
    b = nb; end = ends[b];
  }
  while (end - start < minMs) {
    let na = a - 1;
    while (na >= 0 && inBleep(starts[na])) na--;
    if (na < 0 || end - starts[na] > maxMs) break;
    a = na; start = starts[a];
  }
  // one utterance longer than the max: hard cut at a non-bleeped point
  if (end - start > maxMs) end = start + maxMs;
  // last resort for an edge still inside a bleep: step just outside it
  for (const bl of bleeps) {
    if (start > bl.start_ms && start < bl.end_ms) start = bl.end_ms + 100;
    if (end > bl.start_ms && end < bl.end_ms) end = bl.start_ms - 100;
  }
  start = Math.max(0, Math.round(start));
  end = Math.min(durationMs, Math.round(end));
  if (end - start < minMs || end - start > maxMs || inBleep(start) || inBleep(end)) return null;
  return { start_ms: start, end_ms: end };
}

/** Build clips + call coaching from a valid answer. Clip ids c1..cN in time order. */
export function buildClips(a: Answer, lines: RedactedLine[], bleeps: Interval[], durationMs: number, model: string) {
  const byU = new Map(lines.map((l) => [l.u, l]));
  const dropped: string[] = [];
  const placed: { src: number; clip: Omit<Clip, "clip_id"> }[] = [];
  a.clips.forEach((c, i) => {
    const w = snapClip(c.from_u, c.to_u, lines, bleeps, durationMs);
    if (!w) { dropped.push(`clip_no_valid_window:${c.label}`); return; }
    placed.push({
      src: i,
      clip: {
        label: c.label,
        sub_label: c.label === "objection" ? c.sub_label : null,
        start_ms: w.start_ms,
        end_ms: w.end_ms,
        audio_exported: !(NO_AUDIO_LABELS as readonly string[]).includes(c.label),
        title: c.title.slice(0, 120),
        coaching: {
          did: c.did, worked: c.worked, improve: c.improve,
          key_lines: c.key_line_ids.map((u) => byU.get(u)?.text ?? "").filter(Boolean).map((t) => t.slice(0, 300)),
          scores: c.scores,
        },
        confidence: Math.round(c.confidence * 100) / 100,
      },
    });
  });
  placed.sort((x, y) => x.clip.start_ms - y.clip.start_ms);
  const idOf = new Map<number, string>();
  const clips: Clip[] = placed.map((p, n) => { idOf.set(p.src, `c${n + 1}`); return { clip_id: `c${n + 1}`, ...p.clip }; });
  const coaching: CallCoaching = {
    outcome: "Sale",
    summary: a.call.summary,
    strengths: a.call.strengths,
    improvements: a.call.improvements,
    scores: a.call.scores,
    turning_point_clip_id: idOf.get(a.call.turning_point_clip) ?? null,
    rubric: RUBRIC.id,
    model,
  };
  return { clips, coaching, dropped };
}

export const fmtLines = (lines: RedactedLine[]) => {
  const fmt = (ms: number) => `${String(Math.floor(ms / 60000)).padStart(2, "0")}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;
  return lines.map((l) => `u${l.u} [${fmt(l.start_ms)}] ${l.speaker.toUpperCase()}: ${l.text}`).join("\n");
};

export async function clipAndCoach(
  lines: RedactedLine[],
  bleeps: Interval[],
  durationMs: number,
  opts: { maxClips?: number; onCost?: (usd: number, attempt: number) => Promise<void> } = {},
): Promise<ClipResult> {
  const maxClips = Math.min(CLIPS.maxPerCall, opts.maxClips ?? CLIPS.maxPerCall);
  let costUsd = 0, model = "", error = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await llmJsonOnce({
      schemaName: "call_clips_coaching",
      schema: Schema,
      system: SYSTEM(maxClips),
      user: fmtLines(lines) + (attempt > 1 ? `\n\nYour previous answer was invalid: ${error}. Answer again, fixing exactly these problems.` : ""),
      onCost: opts.onCost ? (usd) => opts.onCost!(usd, attempt) : undefined,
    });
    costUsd += r.costUsd;
    model = r.model;
    const problems = r.ok ? validateAnswer(r.data, lines, maxClips) : [r.error];
    if (r.ok && !problems.length) {
      const built = buildClips(r.data, lines, bleeps, durationMs, model);
      return { ok: true, ...built, costUsd, model, attempts: attempt };
    }
    error = problems.slice(0, 8).join("; ").slice(0, 600);
  }
  return { ok: false, error, costUsd, model, attempts: 2 };
}
