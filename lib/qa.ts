// QA flags. Any reason ⇒ qa_flag=true. Every output still gets a full human
// listen in TR regardless of the flag; the flag says where to listen hardest.
import { QA } from "./config";
import { digitRuns, inAny, mbiMatches, termMatches, type Interval, type Span } from "./pii/detect";
import { tokenize } from "./pii/spoken";
import type { Transcript, Word } from "./words";

export function avgConfidence(words: Word[]): number {
  if (!words.length) return 0;
  return words.reduce((s, w) => s + w.conf, 0) / words.length;
}

/** Share of speech time where both channels talk at once. */
export function crosstalk(words: Word[]): number {
  const per = (ch: 0 | 1) => merge(words.filter((w) => w.ch === ch).map((w) => ({ start_ms: w.start, end_ms: w.end })));
  const a = per(0), b = per(1);
  let overlap = 0, i = 0, j = 0;
  while (i < a.length && j < b.length) {
    const lo = Math.max(a[i].start_ms, b[j].start_ms), hi = Math.min(a[i].end_ms, b[j].end_ms);
    if (hi > lo) overlap += hi - lo;
    if (a[i].end_ms < b[j].end_ms) i++; else j++;
  }
  const union = sum(a) + sum(b) - overlap;
  return union > 0 ? overlap / union : 0;
}

function merge(iv: Interval[]): Interval[] {
  const s = [...iv].sort((x, y) => x.start_ms - y.start_ms);
  const out: Interval[] = [];
  for (const x of s) {
    const l = out[out.length - 1];
    if (l && x.start_ms <= l.end_ms + 200) l.end_ms = Math.max(l.end_ms, x.end_ms);
    else out.push({ ...x });
  }
  return out;
}
const sum = (iv: Interval[]) => iv.reduce((s, x) => s + x.end_ms - x.start_ms, 0);

export function firstPassReasons(p: {
  avgConf: number;
  spans: Span[];
  crosstalk: number;
  lengthOk: boolean;
  llmUnmatched: number;
  channelMapVerified: boolean;
}): string[] {
  const r: string[] = [];
  if (p.avgConf < QA.minAvgWordConfidence) r.push(`asr_confidence_low:${p.avgConf.toFixed(3)}`);
  for (const s of p.spans) if (s.confidence < QA.minSpanConfidence) r.push(`pii_span_low_confidence:${s.type}@${s.start_ms}ms`);
  if (p.crosstalk > QA.maxCrosstalk) r.push(`crosstalk_high:${p.crosstalk.toFixed(3)}`);
  if (!p.lengthOk) r.push("length_mismatch");
  if (p.llmUnmatched > 0) r.push(`llm_quotes_unmatched:${p.llmUnmatched}`);
  if (!p.channelMapVerified) r.push("channel_map_unverified");
  return r;
}

/**
 * Second pass on the REDACTED audio's transcript: anything the detectors still
 * find outside a bleep is a leak. Hits inside a bleep are the tone being misheard.
 */
export function secondPassReasons(
  t2: Transcript,
  bleeps: Interval[],
  nameList: string[],
  entities: { entity_type: string; start: number; end: number }[],
  piiEntityTypes: Set<string>,
): string[] {
  const out: string[] = [];
  const toks = tokenize(t2.words);
  // a hit leaks if ANY of its words is audible (its own midpoint outside every bleep)
  const leakAt = (s: Span): number | null => {
    for (let k = s.from; k <= s.to; k++) {
      const w = t2.words[k];
      if (w.ch === s.channel && !inAny((w.start + w.end) / 2, bleeps)) return w.start;
    }
    return null;
  };
  const check = (spans: Span[], tag: string) => {
    for (const s of spans) { const at = leakAt(s); if (at !== null) out.push(`second_pass_${tag}@${at}ms`); }
  };
  check(digitRuns(t2.words, toks), "digit_run");
  check(mbiMatches(t2.words, toks), "mbi");
  check(termMatches(t2.words, nameList, "PERSON_NAME", "extra_term"), "name");
  for (const e of entities) {
    if (!piiEntityTypes.has(e.entity_type)) continue;
    // any audible word inside the entity's time range
    const audible = t2.words.find((w) => w.start < e.end && w.end > e.start && !inAny((w.start + w.end) / 2, bleeps));
    if (audible) out.push(`second_pass_entity_${e.entity_type}@${audible.start}ms`);
  }
  return [...new Set(out)];
}

/**
 * SPEC v0.2 §2.8, clips: every clip is a cut of the redacted full audio, so a second-pass hit
 * inside a clip's window is a leak in that clip. Reported per clip (exported clips only: the
 * others have no audio).
 */
export function clipReasons(secondPass: string[], clips: { clip_id: string; start_ms: number; end_ms: number; audio_exported: boolean }[]): string[] {
  const out: string[] = [];
  for (const r of secondPass) {
    const m = /@(\d+)ms$/.exec(r);
    if (!m) continue;
    const t = Number(m[1]);
    for (const c of clips) if (c.audio_exported && t >= c.start_ms && t <= c.end_ms) out.push(`second_pass_clip:${c.clip_id}:${r}`);
  }
  return [...new Set(out)];
}

/**
 * SPEC v0.2 §2.7/2.8, coaching text: the same digit-run, MBI and name checks as the audio,
 * over every string the model wrote. Text is treated as one run said at once.
 */
export function textPiiReasons(texts: { where: string; text: string }[], nameList: string[]): string[] {
  const out: string[] = [];
  for (const { where, text } of texts) {
    const words: Word[] = text.split(/\s+/).filter(Boolean).map((w, i) => ({ i, text: w, start: i * 250, end: i * 250 + 200, conf: 1, ch: 0 }));
    if (!words.length) continue;
    const toks = tokenize(words);
    if (digitRuns(words, toks).length) out.push(`coaching_pii:${where}:digit_run`);
    if (mbiMatches(words, toks).length) out.push(`coaching_pii:${where}:mbi`);
    if (termMatches(words, nameList, "PERSON_NAME", "extra_term").length) out.push(`coaching_pii:${where}:name`);
  }
  return [...new Set(out)];
}
