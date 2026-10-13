// Rule detectors + span algebra. Pure functions over words/tokens, no I/O, so
// the whole PII core is unit-tested against planted fixtures (test/pii.test.ts).
//
// A span names a word range and a type; it never carries the words' text.
import { DIGIT_RUN, BLEEP } from "../config";
import type { Transcript, Word } from "../words";
import { norm } from "../words";
import { MONTHS, tokenize, type Tok } from "./spoken";

export const PII_TYPES = [
  "PERSON_NAME", "BENEFICIARY", "PHONE", "ADDRESS", "DOB", "AGE", "SSN", "CARD", "CVV", "CARD_EXPIRY", "BANK",
  "EMAIL", "POLICY_NUMBER", "ID_NUMBER", "MBI", "HEALTH", "MEDICATION", "DIGITS", "SPELLED", "EXTRA_TERM",
] as const;
export type PiiType = (typeof PII_TYPES)[number];
export type Detector = "model" | "regex" | "digit_run" | "extra_term" | "llm";

export type Span = {
  type: PiiType;
  detector: Detector;
  from: number;   // first word index
  to: number;     // last word index (inclusive)
  start_ms: number;
  end_ms: number;
  channel: 0 | 1;
  confidence: number;
};

export type Interval = { start_ms: number; end_ms: number };

// MBI after removing spaces/dashes (CMS format: 11 chars, no S L O I B Z).
export const MBI_RE = /[1-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y][AC-HJKMNP-RT-Y0-9][0-9][AC-HJKMNP-RT-Y]{2}[0-9]{2}/g;

const STREET = new Set([
  "street", "st", "avenue", "ave", "road", "rd", "drive", "dr", "lane", "ln", "court", "ct", "boulevard", "blvd", "way",
  "circle", "cir", "place", "pl", "highway", "hwy", "route", "parkway", "pkwy", "terrace", "trail", "apartment", "apt",
  "suite", "lot", "unit",
]);
const EMAIL_HOSTS = new Set([
  "gmail", "yahoo", "hotmail", "aol", "outlook", "icloud", "msn", "comcast", "att", "live", "me", "bellsouth", "sbcglobal",
  "verizon", "cox", "earthlink", "charter", "roadrunner", "frontier", "ymail", "mac", "protonmail", "windstream", "juno",
]);
const TLD = new Set(["com", "net", "org", "edu", "us"]);
// words that end the sentence part before an email's local part
const STOP_BEFORE_EMAIL = new Set(["is", "it's", "its", "email", "e-mail", "address", "it", "that's", "use", "try", "send", "to"]);

export function spanOf(words: Word[], type: PiiType, detector: Detector, from: number, to: number, confidence?: number): Span {
  const ws = words.slice(from, to + 1);
  const ch = words[from].ch;
  const own = ws.filter((w) => w.ch === ch);
  return {
    type, detector, from, to,
    start_ms: Math.min(...own.map((w) => w.start)),
    end_ms: Math.max(...own.map((w) => w.end)),
    channel: ch,
    confidence: round3(confidence ?? Math.min(...own.map((w) => w.conf))),
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Group marked tokens into spans: same channel, ≤1.5s apart. */
function groupMarked(words: Word[], toks: Tok[], marked: Set<number>, type: PiiType, detector: Detector): Span[] {
  const out: Span[] = [];
  for (const ch of [0, 1] as const) {
    const seq = toks.filter((t) => t.ch === ch && marked.has(t.i));
    let first: Tok | null = null, last: Tok | null = null;
    for (const t of seq) {
      if (first && last && t.start - last.end <= 1500) { last = t; continue; }
      if (first && last) out.push(spanOf(words, type, detector, first.i, last.i));
      first = t; last = t;
    }
    if (first && last) out.push(spanOf(words, type, detector, first.i, last.i));
  }
  return out;
}

// A number followed by one of these is a count or an amount, not part of an ID
// ("two kids", "ten thousand dollars", "one second"). Ages have their own rule.
const QUANTITY_NOUNS = new Set([
  "kids", "kid", "children", "child", "grandkids", "grandchildren", "sons", "daughters", "brothers", "sisters", "people",
  "years", "year", "months", "month", "weeks", "week", "days", "day", "hours", "hour", "minutes", "minute", "seconds",
  "second", "times", "parts", "things", "ways", "policies", "plans", "options", "dollars", "dollar", "bucks", "cents",
  "percent", "pills", "doctors", "visits", "cigarettes", "packs", "drinks", "pounds", "feet", "inches",
  "plan", "policy", "option", "doctor", "visit", "coverage", "benefit", "benefits", "grand", "k",
]);
const PER = new Set(["a", "per", "each", "every"]);
const PERIOD = new Set(["month", "year", "week", "day", "monthly"]);

function isQuantity(t: Tok, toks: Tok[]): boolean {
  if (t.w.startsWith("$") || t.w.endsWith("%")) return true;
  if (/^\d{1,2}:\d{2}(am|pm)?$/.test(t.w)) return true;              // clock time
  const k = toks.findIndex((o) => o.ch === t.ch && o.i > t.i);
  const next = k >= 0 ? toks[k] : undefined;
  if (!next || next.start - t.end > 800) return false;
  if (QUANTITY_NOUNS.has(next.w)) return true;
  if (PER.has(next.w) && toks[k + 1] && PERIOD.has(toks[k + 1].w)) return true;   // "25 50 a month"
  if (next.w === "monthly" || next.w === "o'clock" || next.w === "am" || next.w === "pm") return true;
  // "five hundred dollars": look one word further past hundred/thousand
  if (next.digits && (next.w === "hundred" || next.w === "thousand")) return isQuantity(next, toks);
  return false;
}

/** Any ≥4 digits inside an 8s window, across both channels (read-backs count). Counts/amounts excluded. */
function slidingRuns(dt: Tok[]): Set<number> {
  const marked = new Set<number>();
  let l = 0, sum = 0;
  for (let r = 0; r < dt.length; r++) {
    sum += dt[r].digits.length;
    while (l < r && dt[r].end - dt[l].start > DIGIT_RUN.windowMs) { sum -= dt[l].digits.length; l++; }
    if (sum >= DIGIT_RUN.minDigits) for (let k = l; k <= r; k++) marked.add(dt[k].i);
  }
  return marked;
}

export function digitRuns(words: Word[], toks: Tok[] = tokenize(words)): Span[] {
  const sameCh = { 0: toks.filter((t) => t.ch === 0), 1: toks.filter((t) => t.ch === 1) } as const;
  const all = toks.filter((t) => t.digits.length > 0).sort((a, b) => a.start - b.start);
  const qty = new Set(all.filter((t) => isQuantity(t, sameCh[t.ch])).map((t) => t.i));
  const dt = all.filter((t) => !qty.has(t.i));
  const marked = slidingRuns(dt);
  // a "count" word that is really the tail of an ID ("…oh one nine eight, day or night") rides with its run
  for (const t of all) {
    if (!qty.has(t.i)) continue;
    if (dt.some((d) => marked.has(d.i) && d.ch === t.ch && Math.abs(d.end - t.start) < 1500)) marked.add(t.i);
  }
  // spelled letters inside a digit run, and the words that build digits ("double", "dash"), belong to the same ID
  const CONNECTORS = new Set(["double", "triple", "dash", "-", "hyphen"]);
  for (const t of toks) {
    if (marked.has(t.i) || !(t.letter || CONNECTORS.has(t.w))) continue;
    const reach = t.letter ? 2000 : 1000;
    if (dt.some((d) => marked.has(d.i) && d.ch === t.ch && Math.abs(d.start - t.start) < reach)) marked.add(t.i);
  }
  return groupMarked(words, toks, marked, "DIGITS", "digit_run");
}

/** Three or more spelled letters in a row (a name or email spelled out): always personal. */
export function spelledRuns(words: Word[], toks: Tok[] = tokenize(words)): Span[] {
  const out: Span[] = [];
  for (const ch of [0, 1] as const) {
    const seq = toks.filter((t) => t.ch === ch);
    let run: Tok[] = [];
    const flush = () => {
      const letters = run.reduce((n, t) => n + (t.digits ? 0 : t.chars.length), 0);
      if (letters >= 3) out.push(spanOf(words, "SPELLED", "regex", run[0].i, run[run.length - 1].i));
      run = [];
    };
    for (const t of seq) {
      const prev = run[run.length - 1];
      if (t.letter && (!prev || t.start - prev.end < 2000)) { run.push(t); continue; }
      flush();
      if (t.letter) run.push(t);
    }
    flush();
  }
  return out;
}

/** MBI on the per-channel stream of spelled characters (letters + digits), separators dropped. */
export function mbiMatches(words: Word[], toks: Tok[] = tokenize(words)): Span[] {
  const out: Span[] = [];
  for (const ch of [0, 1] as const) {
    const seq = toks.filter((t) => t.ch === ch);
    let run: Tok[] = [];
    const flush = () => {
      const withChars = run.filter((t) => t.chars);
      if (withChars.length) {
        let s = "";
        const owner: number[] = [];
        for (const t of withChars) for (const c of t.chars) { s += c; owner.push(t.i); }
        for (const m of s.matchAll(MBI_RE)) {
          const from = owner[m.index!], to = owner[m.index! + m[0].length - 1];
          out.push(spanOf(words, "MBI", "regex", from, to));
        }
      }
      run = [];
    };
    for (const t of seq) {
      const idish = !!t.chars || t.letter || t.w === "dash" || t.w === "-";
      const prev = run[run.length - 1];
      if (idish && (!prev || t.start - prev.end < 3000)) { run.push(t); continue; }
      flush();
      if (idish) run.push(t);
    }
    flush();
  }
  return out;
}

/** Emails (written or spoken), street addresses, dates of birth, ages. */
export function patternMatches(words: Word[], toks: Tok[] = tokenize(words)): Span[] {
  const out: Span[] = [];
  for (const ch of [0, 1] as const) {
    const seq = toks.filter((t) => t.ch === ch);
    for (let k = 0; k < seq.length; k++) {
      const t = seq[k];
      if (t.w.includes("@") && /[a-z0-9]@[a-z0-9]/.test(t.w)) out.push(spanOf(words, "EMAIL", "regex", t.i, t.i));
      // spoken email: "<local part> at <host> [dot com]" — host known, or followed by "dot"/a TLD, or "host.com"
      if (t.w === "at" && seq[k + 1]) {
        const host = seq[k + 1].w.split(".")[0];
        const inlineTld = /\.[a-z]{2,4}$/.test(seq[k + 1].w);
        const tldAt = seq.slice(k + 2, k + 5).findIndex((o) => TLD.has(o.w));
        const dotted = seq[k + 2]?.w === "dot";
        if (EMAIL_HOSTS.has(host) || inlineTld || (dotted && tldAt >= 0)) {
          const last = tldAt >= 0 ? seq[k + 2 + tldAt] : dotted ? seq[k + 2] : seq[k + 1];
          // the local part: the whole same-speaker stretch before "at" (≤1.5 s gaps, ≤10 words)
          let j = k;
          while (j > 0 && k - j < 10 && seq[j].start - seq[j - 1].end < 1500 && !STOP_BEFORE_EMAIL.has(seq[j - 1].w)) j--;
          out.push(spanOf(words, "EMAIL", "regex", seq[j === k ? Math.max(0, k - 1) : j].i, last.i));
        }
      }
      // "1234 Oak Street", "apartment 5"
      if (t.digits && !t.letter && !isQuantity(t, seq)) {
        const ahead = seq.slice(k + 1, k + 5);
        const sfx = ahead.findIndex((o) => STREET.has(o.w));
        if (sfx >= 0 && ahead[sfx].start - t.end < 4000) out.push(spanOf(words, "ADDRESS", "regex", t.i, ahead[sfx].i));
      }
      if ((t.w === "apartment" || t.w === "apt" || t.w === "unit" || t.w === "suite" || t.w === "lot") && seq[k + 1]?.digits) {
        out.push(spanOf(words, "ADDRESS", "regex", t.i, seq[k + 1].i));
      }
      if (t.w === "box" && seq[k + 1]?.digits) {
        const p1 = seq[k - 1], p2 = seq[k - 2];
        const first = p1 && /^p\.?o\.?$|^po$/.test(p1.w) ? p1 : p1?.w === "o" && p2?.w === "p" ? p2 : null;
        if (first) {
          let last = k + 1;
          while (seq[last + 1]?.digits && seq[last + 1].start - seq[last].end < 1500) last++;
          out.push(spanOf(words, "ADDRESS", "regex", first.i, seq[last].i));
        }
      }
      // month next to a day/year → date (of birth, or anything personal)
      if ((MONTHS.has(t.w) && t.w !== "may") || (t.w === "may" && (seq[k + 1]?.digits || seq[k - 1]?.digits))) {
        const win = seq.slice(Math.max(0, k - 3), k + 5).filter((o) => o.digits);
        if (win.length) {
          const all = [t, ...win];
          out.push(spanOf(words, "DOB", "regex", Math.min(...all.map((o) => o.i)), Math.max(...all.map((o) => o.i))));
        }
      }
      // CVV: 3–4 digits within 10 s after "security code", "cvv", "on the back" — either speaker answers
      if (t.w === "cvv" || t.w === "cvc" || t.w === "csc" || (t.w === "code" && ["security", "the", "verification"].includes(seq[k - 1]?.w ?? "")) || (t.w === "back" && seq[k - 1]?.w === "the")) {
        const after = toks.filter((o) => o.digits && o.start > t.end && o.start - t.end < 10_000).sort((a, b) => a.start - b.start);
        let n = 0;
        const take: Tok[] = [];
        for (const o of after) { if (n >= 4) break; take.push(o); n += o.digits.length; }
        if (n >= 3 && n <= 4) for (const ch2 of [0, 1] as const) {
          const own = take.filter((o) => o.ch === ch2);
          if (own.length) out.push(spanOf(words, "CVV", "regex", own[0].i, own[own.length - 1].i));
        }
      }
      // "72 years old", "I'm 72" is left to the model; the explicit form is a rule
      if (t.digits && seq[k + 1]?.w === "years" && seq[k + 2]?.w === "old") {
        let j = k;   // "seventy eight years old": take the whole number
        while (j > 0 && seq[j - 1].digits && seq[j].start - seq[j - 1].end < 1000) j--;
        out.push(spanOf(words, "AGE", "regex", seq[j].i, seq[k + 2].i));
      }
    }
  }
  return out;
}

/** Every occurrence of a known name/term (single tokens ≥2 chars, multi-word terms as sequences). */
export function termMatches(words: Word[], terms: string[], type: PiiType, detector: Detector): Span[] {
  const seqs = [...new Set(terms.map((t) => t.split(/\s+/).map(norm).filter(Boolean).join(" ")).filter((t) => t.length >= 2))]
    .map((t) => t.split(" "));
  if (!seqs.length) return [];
  const out: Span[] = [];
  const byCh: Record<0 | 1, Word[]> = { 0: [], 1: [] };
  for (const w of words) byCh[w.ch].push(w);
  for (const seq of [byCh[0], byCh[1]]) {
    const ws = seq.map((w) => norm(w.text).replace(/'s$/, ""));
    for (let k = 0; k < ws.length; k++) {
      for (const s of seqs) {
        if (k + s.length > ws.length) continue;
        let ok = true;
        for (let m = 0; m < s.length; m++) if (ws[k + m] !== s[m]) { ok = false; break; }
        if (ok) out.push(spanOf(words, type, detector, seq[k].i, seq[k + s.length - 1].i));
      }
    }
  }
  return out;
}

// AssemblyAI entity_type → our type. Types not listed are not PII for this library.
export const AAI_ENTITY_MAP: Record<string, PiiType | "HEALTH_OPT" | "MEDICATION_OPT"> = {
  person_name: "PERSON_NAME",
  phone_number: "PHONE",
  location: "ADDRESS",
  location_address: "ADDRESS",
  location_address_street: "ADDRESS",
  location_city: "ADDRESS",
  location_zip: "ADDRESS",
  location_coordinate: "ADDRESS",
  date_of_birth: "DOB",
  person_age: "AGE",
  us_social_security_number: "SSN",
  credit_card_number: "CARD",
  credit_card_cvv: "CVV",
  credit_card_expiration: "CARD_EXPIRY",
  banking_information: "BANK",
  account_number: "BANK",
  email_address: "EMAIL",
  healthcare_number: "MBI",
  drivers_license: "ID_NUMBER",
  passport_number: "ID_NUMBER",
  vehicle_id: "ID_NUMBER",
  number_sequence: "ID_NUMBER",
  username: "ID_NUMBER",
  password: "ID_NUMBER",
  medical_condition: "HEALTH_OPT",
  injury: "HEALTH_OPT",
  medical_process: "HEALTH_OPT",
  blood_type: "HEALTH_OPT",
  drug: "MEDICATION_OPT",
};

/** AssemblyAI entities carry times, not word indices or channels: map each to the words it covers. */
export function entitySpans(
  words: Word[],
  entities: { entity_type: string; start: number; end: number; text?: string }[],
  redactHealth: boolean,
): Span[] {
  const out: Span[] = [];
  for (const e of entities) {
    let type = AAI_ENTITY_MAP[e.entity_type];
    if (!type) continue;
    if (type === "HEALTH_OPT" || type === "MEDICATION_OPT") {
      if (!redactHealth) continue;
      type = type === "HEALTH_OPT" ? "HEALTH" : "MEDICATION";
    }
    const covered = words.filter((w) => w.start < e.end && w.end > e.start);
    if (!covered.length) continue;
    // Entities carry no channel. Pick it by the entity's own text; failing that, by overlap
    // time; when both channels overlap and the text decides nothing, bleep both.
    const etoks = new Set(String((e as { text?: string }).text ?? "").split(/\s+/).map((x) => norm(x).replace(/'s$/, "")).filter(Boolean));
    const score = (ch: 0 | 1) => covered.filter((w) => w.ch === ch && etoks.has(norm(w.text).replace(/'s$/, ""))).length;
    const overlap = (ch: 0 | 1) => covered.filter((w) => w.ch === ch).reduce((s, w) => s + Math.min(w.end, e.end) - Math.max(w.start, e.start), 0);
    const s0 = score(0), s1 = score(1);
    const chans: (0 | 1)[] = s0 !== s1 ? [s0 > s1 ? 0 : 1]
      : overlap(0) > 0 && overlap(1) > 0 ? [0, 1]
      : [overlap(1) > overlap(0) ? 1 : 0];
    for (const ch of chans) {
      const own = covered.filter((w) => w.ch === ch);
      if (!own.length) continue;
      const conf = own.reduce((acc, w) => acc + w.conf, 0) / own.length;
      const sp = spanOf(words, type as PiiType, "model", own[0].i, own[own.length - 1].i);
      // cover at least the entity's own time range
      out.push({ ...sp, start_ms: Math.min(sp.start_ms, e.start), end_ms: Math.max(sp.end_ms, e.end), confidence: round3(conf) });
    }
  }
  return out;
}

/** Name tokens found by the model/LLM become a term list, so every later mention is caught too. */
export function nameTerms(words: Word[], spans: Span[]): string[] {
  const out = new Set<string>();
  for (const s of spans) {
    if (s.type !== "PERSON_NAME" && s.type !== "BENEFICIARY") continue;
    for (let k = s.from; k <= s.to; k++) {
      if (words[k].ch !== s.channel) continue;
      const w = norm(words[k].text).replace(/'s$/, "");
      if (w.length >= 3 && /^[\p{L}'-]+$/u.test(w) && !NOT_NAMES.has(w)) out.add(w);
    }
  }
  return [...out];
}

// Words a name entity can swallow that must not become a global bleep term.
const NOT_NAMES = new Set([
  "mrs", "mr", "miss", "ms", "dr", "sir", "maam", "the", "and", "his", "her", "my", "your", "wife", "husband", "son",
  "daughter", "mother", "father", "mom", "dad", "brother", "sister", "honey", "dear", "agent", "insurance", "life",
  "doctor", "mister", "missus", "misses", "grandson", "granddaughter", "grandma", "grandpa", "grandmother", "grandfather",
  "aunt", "auntie", "uncle", "nephew", "niece", "cousin", "pastor", "reverend", "father", "nurse", "okay", "yeah", "yes",
  "um", "uh", "hmm", "well", "so", "but", "with", "from", "for", "this", "that", "him", "she", "he", "they", "them",
]);

/** Dedupe identical ranges, keeping the highest-confidence detector's row. */
export function dedupe(spans: Span[]): Span[] {
  const best = new Map<string, Span>();
  for (const s of spans) {
    const k = `${s.from}:${s.to}:${s.type}`;
    const cur = best.get(k);
    if (!cur || s.confidence > cur.confidence) best.set(k, s);
  }
  return [...best.values()].sort((a, b) => a.start_ms - b.start_ms || a.from - b.from);
}

export function padSpan(s: Span, padMs: number, durationMs: number): Interval {
  return { start_ms: Math.max(0, s.start_ms - padMs), end_ms: Math.min(durationMs, s.end_ms + padMs) };
}

/** Padded spans → bleep intervals, merging anything closer than 500 ms. */
export function bleepIntervals(spans: Span[], padMs: number, durationMs: number): Interval[] {
  const iv = spans.map((s) => padSpan(s, padMs, durationMs)).sort((a, b) => a.start_ms - b.start_ms);
  const out: Interval[] = [];
  for (const x of iv) {
    const last = out[out.length - 1];
    if (last && x.start_ms - last.end_ms < BLEEP.mergeGapMs) last.end_ms = Math.max(last.end_ms, x.end_ms);
    else out.push({ ...x });
  }
  return out;
}

export function totalMs(iv: Interval[]): number {
  return iv.reduce((s, x) => s + (x.end_ms - x.start_ms), 0);
}

export function inAny(ms: number, iv: Interval[]): boolean {
  return iv.some((x) => ms >= x.start_ms && ms <= x.end_ms);
}

/** All rule detectors (everything that does not need a model). */
export function ruleSpans(t: Transcript, extraTerms: string[]): Span[] {
  const toks = tokenize(t.words);
  return [
    ...digitRuns(t.words, toks),
    ...mbiMatches(t.words, toks),
    ...spelledRuns(t.words, toks),
    ...patternMatches(t.words, toks),
    ...termMatches(t.words, extraTerms, "EXTRA_TERM", "extra_term"),
  ];
}
