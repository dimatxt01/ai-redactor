import type { Transcript, Word } from "@/lib/words";

/** Build a transcript from [channel, text] lines; each word lasts 300 ms, lines follow each other. */
export function script(lines: [0 | 1, string][], opts: { wordMs?: number; gapMs?: number; conf?: number } = {}): Transcript {
  const wordMs = opts.wordMs ?? 300;
  const gap = opts.gapMs ?? 400;
  const words: Word[] = [];
  let t = 1000;
  for (const [ch, text] of lines) {
    for (const tok of text.split(/\s+/).filter(Boolean)) {
      words.push({ i: words.length, text: tok, start: t, end: t + wordMs - 20, conf: opts.conf ?? 0.95, ch });
      t += wordMs;
    }
    t += gap;
  }
  return { words, utterances: [], durationMs: t + 1000, channels: 2 };
}

/** Indices of words whose text (case-insensitive, punctuation-trimmed) equals one of `needles`, in order. */
export function idx(t: Transcript, ...needles: string[]): number[] {
  const n = needles.map((s) => s.toLowerCase());
  return t.words.filter((w) => n.includes(w.text.toLowerCase().replace(/[.,?!]$/, ""))).map((w) => w.i);
}

export function covered(spans: { from: number; to: number; channel: number }[], t: Transcript, i: number): boolean {
  return spans.some((s) => i >= s.from && i <= s.to && t.words[i].ch === s.channel);
}
