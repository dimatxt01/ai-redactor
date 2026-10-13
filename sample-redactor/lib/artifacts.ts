// Result files. Every JSON result is an envelope stamped with the pipeline
// version and the job version; audio carries the same tag in its ID3 comment.
import { createHash } from "node:crypto";
import { PIPELINE_VERSION, SCHEMA_VERSION } from "./config";
import type { RedactedLine } from "./labels";
import { padSpan, type Interval, type Span } from "./pii/detect";
import type { Transcript } from "./words";
import { utteranceWords } from "./words";

export const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export type Envelope<T> = {
  schema: string;
  schema_version: string;
  pipeline_version: string;
  job_version: number;
  call_id: string;
  items: T;
};

export function envelope<T>(schema: string, jobVersion: number, callId: string, items: T): Envelope<T> {
  return { schema, schema_version: SCHEMA_VERSION, pipeline_version: PIPELINE_VERSION, job_version: jobVersion, call_id: callId, items };
}

export const versionTag = (jobVersion: number) => `${PIPELINE_VERSION} job_v${jobVersion}`;

/**
 * PII words, and any word mostly under a bleep (inaudible in the audio,
 * whatever the channel), become [REDACTED:<TYPE>]; consecutive ones collapse.
 */
export function redactedLines(t: Transcript, spans: Span[], bleeps: Interval[], customerChannel: 0 | 1, padMs: number, durationMs: number): RedactedLine[] {
  const padded = spans.map((s) => ({ s, iv: padSpan(s, padMs, durationMs) }));
  const typeAt = (start: number, end: number, i: number): string | null => {
    const own = padded.find(({ s }) => i >= s.from && i <= s.to && t.words[i].ch === s.channel);
    if (own) return own.s.type;
    // not PII itself: hidden only when it is mostly under the tone (its midpoint is bleeped)
    const mid = (start + end) / 2;
    if (!bleeps.some((b) => mid >= b.start_ms && mid <= b.end_ms)) return null;
    return padded.find(({ iv }) => mid >= iv.start_ms && mid <= iv.end_ms)?.s.type ?? "BLEEP";
  };
  return t.utterances.map((u) => {
    const parts: string[] = [];
    let last: string | null = null;
    for (const w of utteranceWords(t, u)) {
      const type = typeAt(w.start, w.end, w.i);
      if (type) {
        const tag = `[REDACTED:${type}]`;
        if (tag !== last) parts.push(tag);
        last = tag;
      } else {
        parts.push(w.text);
        last = null;
      }
    }
    return { u: u.u, speaker: u.ch === customerChannel ? "customer" : "agent", start_ms: u.start, end_ms: u.end, text: parts.join(" ") };
  });
}

export function transcriptJson(lines: RedactedLine[], customerChannel: 0 | 1) {
  return lines.map((l) => ({
    channel: l.speaker === "customer" ? customerChannel : 1 - customerChannel,
    speaker: l.speaker,
    start_ms: l.start_ms,
    end_ms: l.end_ms,
    text: l.text,
  }));
}

export function transcriptTxt(lines: RedactedLine[], header: string): string {
  const fmt = (ms: number) => {
    const s = Math.floor(ms / 1000);
    return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
  };
  return `${header}\n\n` + lines.map((l) => `[${fmt(l.start_ms)}] ${l.speaker.toUpperCase()}: ${l.text}`).join("\n") + "\n";
}

/** PII spans as published: positions only, never the original text. */
export function spansJson(spans: Span[], padMs: number, durationMs: number) {
  return spans.map((s) => {
    const p = padSpan(s, padMs, durationMs);
    return {
      type: s.type,
      start_ms: s.start_ms,
      end_ms: s.end_ms,
      channel: s.channel,
      confidence: s.confidence,
      detector: s.detector,
      padded_start_ms: p.start_ms,
      padded_end_ms: p.end_ms,
    };
  });
}
