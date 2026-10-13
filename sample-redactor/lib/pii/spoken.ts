// Spoken digits and letters → characters, word by word, keeping each word's
// timestamps. "five five five" → 5 5 5, "double oh" → 00, "twenty one" → 21,
// "oh" → 0 only next to other digits, "B as in boy" → B, ordinals only next
// to a month (dates of birth). The detectors work on these tokens.
import type { Word } from "../words";
import { norm } from "../words";

export type Tok = {
  i: number;            // word index
  ch: 0 | 1;
  start: number;
  end: number;
  w: string;            // normalized word
  digits: string;       // digits this word contributes ("" if none)
  chars: string;        // uppercase alphanumerics for ID matching (digits + spelled letters)
  letter: boolean;      // a spelled letter (single letter or phonetic)
};

const ONES: Record<string, string> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9",
};
const TEENS: Record<string, string> = {
  ten: "10", eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15",
  sixteen: "16", seventeen: "17", eighteen: "18", nineteen: "19",
};
const TENS: Record<string, string> = {
  twenty: "2", thirty: "3", forty: "4", fourty: "4", fifty: "5", sixty: "6", seventy: "7", eighty: "8", ninety: "9",
};
const ORDINALS: Record<string, string> = {
  first: "1", second: "2", third: "3", fourth: "4", fifth: "5", sixth: "6", seventh: "7", eighth: "8", ninth: "9",
  tenth: "10", eleventh: "11", twelfth: "12", thirteenth: "13", fourteenth: "14", fifteenth: "15", sixteenth: "16",
  seventeenth: "17", eighteenth: "18", nineteenth: "19", twentieth: "20", thirtieth: "30",
};
export const MONTHS = new Set([
  "january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december",
  "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);
const NATO = new Set([
  "alpha", "alfa", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "juliett", "kilo",
  "lima", "mike", "november", "oscar", "papa", "quebec", "romeo", "sierra", "tango", "uniform", "victor", "whiskey",
  "xray", "x-ray", "yankee", "zulu",
]);
const MULTIPLIER: Record<string, number> = { double: 2, triple: 3 };

/** Digit value of a lone spoken number word (not context-dependent ones). */
function wordDigits(w: string): string | null {
  if (/\d/.test(w)) return w.replace(/\D/g, "");
  if (ONES[w]) return ONES[w];
  if (TEENS[w]) return TEENS[w];
  if (TENS[w]) return TENS[w] + "0";
  const hy = /^([a-z]+)-([a-z]+)$/.exec(w);              // twenty-one
  if (hy && TENS[hy[1]] && ONES[hy[2]]) return TENS[hy[1]] + ONES[hy[2]];
  if (w === "hundred") return "100";
  if (w === "thousand") return "1000";
  return null;
}

export function tokenize(words: Word[]): Tok[] {
  // Work per channel so "oh" / "double" / "as in" only bind to the same speaker.
  const toks: Tok[] = words.map((x) => ({ i: x.i, ch: x.ch, start: x.start, end: x.end, w: norm(x.text), digits: "", chars: "", letter: false }));
  const byCh: Record<0 | 1, Tok[]> = { 0: [], 1: [] };
  for (const t of toks) byCh[t.ch].push(t);

  for (const seq of [byCh[0], byCh[1]]) {
    // pass 1: plain numbers, ASR numerals, alphanumeric codes
    for (const t of seq) {
      if (/^[a-z](-[a-z]){2,}$/.test(t.w)) {                    // "Q-U-I-N-L-A-N": ASR's spelling form
        t.letter = true; t.chars = t.w.replace(/-/g, "").toUpperCase();
        continue;
      }
      if (/^[a-z0-9-]+$/.test(t.w) && /\d/.test(t.w) && /[a-z]/.test(t.w) && !/^\d+(st|nd|rd|th|s)$/.test(t.w)) {
        t.chars = t.w.replace(/-/g, "").toUpperCase();      // "1eg4" as one ASR token
        t.digits = t.w.replace(/\D/g, "");
        continue;
      }
      const d = wordDigits(t.w);
      if (d !== null) { t.digits = d; t.chars = d; }
    }
    for (let k = 0; k < seq.length; k++) {
      const t = seq[k], next = seq[k + 1], prev = seq[k - 1];
      const near = (o?: Tok) => !!o && Math.abs(o.start - t.start) < 2500;
      // twenty + one → 21 (replace the tens "20" with "2" and let the ones word add its digit)
      if (TENS[t.w] && next && near(next) && ONES[next.w]) { t.digits = TENS[t.w]; t.chars = t.digits; }
      // five + hundred → 500: "hundred"/"thousand" only add zeros after a number
      if ((t.w === "hundred" || t.w === "thousand") && prev && prev.digits && near(prev)) {
        t.digits = t.w === "hundred" ? "00" : "000"; t.chars = t.digits;
      }
      // double five → 55, triple oh → 000
      if (MULTIPLIER[t.w] && next && near(next)) {
        const nd = next.w === "oh" || next.w === "o" ? "0" : wordDigits(next.w);
        if (nd && nd.length === 1) { next.digits = nd.repeat(MULTIPLIER[t.w]); next.chars = next.digits; }
      }
    }
    // "oh" / "o" is 0 only between or beside digits
    for (let k = 0; k < seq.length; k++) {
      const t = seq[k];
      if ((t.w === "oh" || t.w === "o") && !t.digits) {
        const prev = seq[k - 1], next = seq[k + 1];
        const isDigitish = (o?: Tok) => !!o && Math.abs(o.start - t.start) < 2500 && (!!o.digits || o.w === "oh" || o.w === "o" || !!MULTIPLIER[o.w]);
        if (isDigitish(prev) || isDigitish(next)) { t.digits = "0"; t.chars = "0"; }
      }
    }
    // ordinals count only beside a month ("March third", "the 3rd of March")
    for (let k = 0; k < seq.length; k++) {
      const t = seq[k];
      const ord = ORDINALS[t.w] ?? (/^(\d+)(st|nd|rd|th)$/.exec(t.w)?.[1] ?? null);
      if (!ord) continue;
      const window = seq.slice(Math.max(0, k - 3), k + 4);
      if (window.some((o) => MONTHS.has(o.w))) { t.digits = ord; t.chars = ord; }
      else if (/^\d/.test(t.w)) { t.digits = ""; t.chars = ""; }   // "2nd" with no month: not an ID digit
    }
    // spelled letters: "B as in boy", "B for boy", "B like boy"; NATO words; single letters
    for (let k = 0; k < seq.length; k++) {
      const t = seq[k];
      const single = /^[a-z]\.?$/.test(t.w);
      const a = seq[k + 1], b = seq[k + 2], c = seq[k + 3];
      if (single && a && a.w === "as" && b && b.w === "in" && c) {
        t.letter = true; t.chars = t.w[0].toUpperCase();
        for (const o of [a, b, c]) o.letter = true;           // the carrier words ride inside the letter
        k += 3;
        continue;
      }
      if (single && a && (a.w === "for" || a.w === "like") && b && /^[a-z]{3,}$/.test(b.w) && b.w[0] === t.w[0]) {
        t.letter = true; t.chars = t.w[0].toUpperCase();
        a.letter = true; b.letter = true;
        k += 2;
        continue;
      }
      if (single && t.w !== "a" && t.w !== "i") { t.letter = true; t.chars = t.w[0].toUpperCase(); }
    }
    // "a"/"i" and NATO words are letters only inside a run of other letters/digits
    for (let k = 0; k < seq.length; k++) {
      const t = seq[k];
      if (t.letter) continue;   // already a letter or the carrier word of "X as in <word>"
      const isA = t.w === "a" || t.w === "i" || t.w === "a." || t.w === "i.";
      if (!isA && !NATO.has(t.w)) continue;
      const prev = seq[k - 1], next = seq[k + 1], next2 = seq[k + 2];
      const idish = (o?: Tok) => !!o && Math.abs(o.start - t.start) < 2500 && (o.letter || !!o.digits || NATO.has(o.w));
      const spelledAhead = !!next?.letter && (idish(next2));   // "A P P 7…": a/i opening a spelled run
      if ((idish(prev) && idish(next)) || (isA && spelledAhead) || (NATO.has(t.w) && (idish(prev) || idish(next)) && (idish(seq[k - 2]) || idish(next2)))) {
        t.letter = true; t.chars = t.w[0].toUpperCase();
      }
    }
  }
  return toks;
}
