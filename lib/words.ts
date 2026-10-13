// The pipeline's transcript model: flat, time-ordered words with a 0-based
// channel, plus utterances that index into them. Built once from AssemblyAI's
// response; everything downstream reads this, never the vendor shape.
import type { AaiTranscript } from "./assemblyai";

export type Word = { i: number; text: string; start: number; end: number; conf: number; ch: 0 | 1 };
export type Utterance = { u: number; ch: 0 | 1; start: number; end: number; from: number; to: number };
export type Transcript = { words: Word[]; utterances: Utterance[]; durationMs: number | null; channels: number | null };

const chOf = (c: string | undefined | null): 0 | 1 => (String(c ?? "1") === "2" ? 1 : 0);

export function fromAssemblyAi(t: AaiTranscript, monoChannel: 0 | 1 = 0): Transcript {
  const multichannel = (t.audio_channels ?? 1) > 1;
  const raw = (t.words ?? []).map((w) => ({
    text: w.text,
    start: w.start,
    end: Math.max(w.end, w.start),
    conf: typeof w.confidence === "number" ? w.confidence : 0,
    ch: multichannel ? chOf(w.channel) : monoChannel,
  }));
  raw.sort((a, b) => a.start - b.start || a.ch - b.ch);
  const words: Word[] = raw.map((w, i) => ({ i, ...w }));

  // Utterances: consecutive words on one channel with < 1.2s gaps. Rebuilt from
  // words (not the vendor's utterance list) so indices always line up.
  const utterances: Utterance[] = [];
  const open: Partial<Record<0 | 1, Utterance>> = {};
  for (const w of words) {
    const cur = open[w.ch];
    if (cur && w.start - cur.end < 1200) {
      cur.end = Math.max(cur.end, w.end);
      cur.to = w.i;
    } else {
      const u: Utterance = { u: utterances.length, ch: w.ch, start: w.start, end: w.end, from: w.i, to: w.i };
      utterances.push(u);
      open[w.ch] = u;
    }
  }
  return {
    words,
    utterances,
    durationMs: typeof t.audio_duration === "number" ? t.audio_duration * 1000 : null,
    channels: t.audio_channels ?? null,
  };
}

/** Word indices of an utterance (they interleave with the other channel's words). */
export function utteranceWords(t: Transcript, u: Utterance): Word[] {
  const out: Word[] = [];
  for (let k = u.from; k <= u.to; k++) if (t.words[k].ch === u.ch) out.push(t.words[k]);
  return out;
}

export const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}'@.$/:-]+/gu, "").replace(/^[.'/:-]+|[.'/:-]+$/g, "");
