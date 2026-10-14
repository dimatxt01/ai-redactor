// SIMULATION ONLY. The fake outside world for `npm run simulate`, one local HTTP server:
//   /storage/v1/object/...   Supabase Storage signed URLs (files on disk; tokens from fake-supabase.ts)
//   /telnyx/v2/recordings/…  Telnyx "fresh recording link" API → /recordings/<id>.mp3 (the test call)
//   /aai/v2/transcript…      AssemblyAI: words from the test call's script, entities for its planted values;
//                            the verification pass LISTENS to the redacted mp3 (bleep-noise detection) and only
//                            returns words that are still audible, the way a real transcriber would
//   /openrouter/api/v1/…     OpenRouter: no extra PII labels; a valid clips + coaching answer (invalid on each
//                            job's first try, so the worker's one retry-with-the-error is exercised)
// Everything it serves is fictional (the synthetic test calls).
import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";
import { BLEEP } from "../lib/config";

export type Manifest = {
  name: string; customer_channel: 0 | 1; agent: string; caller: string; strict: boolean;
  planted: { kind: string; text: string; line: number; from: number; to: number }[];
  line_starts_ms: number[]; line_ends_ms: number[]; total_ms: number;
  lines: { speaker: "customer" | "agent"; text: string }[];
};
export type Word = { text: string; start: number; end: number; confidence: number; ch: 0 | 1; line: number; tok: number };

/** The test call's words with times spread evenly over each line (the same timeline the fake ASR returns). */
export function wordsOf(m: Manifest): Word[] {
  const out: Word[] = [];
  m.lines.forEach((l, i) => {
    const toks = l.text.split(/\s+/).filter(Boolean);
    const a = m.line_starts_ms[i], b = m.line_ends_ms?.[i] ?? a + toks.length * 300;
    const step = (b - a) / Math.max(1, toks.length);
    const ch = (l.speaker === "customer" ? m.customer_channel : 1 - m.customer_channel) as 0 | 1;
    toks.forEach((t, k) => out.push({ text: t, start: Math.round(a + k * step), end: Math.round(a + (k + 0.85) * step), confidence: 0.93, ch, line: i, tok: k }));
  });
  return out;
}

/** The words of one planted value. */
export function plantedWords(m: Manifest, words: Word[], p: Manifest["planted"][number]): Word[] {
  return words.filter((w) => w.line === p.line && w.tok >= p.from && w.tok <= p.to);
}

const ENTITY: Record<string, string> = {
  ADDRESS: "location_address", CITY: "location_city", BANK: "banking_information", DOB: "date_of_birth",
  PHONE: "phone_number", CARD: "credit_card_number", POLICY: "account_number", MEDICATION: "drug",
  HEALTH: "medical_condition", MBI: "healthcare_number", SSN: "us_social_security_number", BENEFICIARY: "person_name",
  CARD_EXPIRY: "credit_card_expiration", CVV: "credit_card_cvv", AGE: "person_age", EMAIL: "email_address",
  // NAME: the agent's and caller's names come from TR's own rows (bridge `job` → extra_terms), not the vendor
  // TERM: the carrier name is an extra term the AM adds on submit
};

/** Decoded redacted audio, per channel, 16 kHz float. */
export function decodeStereo(file: string): [Float32Array, Float32Array] {
  const raw = execFileSync(ffmpegPath as unknown as string, ["-v", "error", "-i", file, "-ac", "2", "-ar", "16000", "-f", "f32le", "-"], { maxBuffer: 1 << 30 });
  const all = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const l = new Float32Array(all.length / 2), r = new Float32Array(all.length / 2);
  for (let i = 0; i < l.length; i++) { l[i] = all[2 * i]; r[i] = all[2 * i + 1]; }
  return [l, r];
}

/** In-place radix-2 FFT (n a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci, ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar; im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar; im[i + k] += ai;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

const FRAME = 512, HOP = 256, SR = 16000;
const HANN = Float64Array.from({ length: FRAME }, (_, k) => 0.5 - 0.5 * Math.cos((2 * Math.PI * k) / FRAME));
const BAND = [Math.round((300 * FRAME) / SR), Math.round((3400 * FRAME) / SR)] as const;

/** A word's sound, from 32 ms frames over its middle 60% (its edges can hold a fade): the spectral flatness of the
 *  frame-averaged spectrum in 300–3400 Hz after undoing pink's 1/f slope (noise ≈ 1, speech low: its energy sits in
 *  harmonics and formants), the mean level and how much the level moves from frame to frame (noise is steady). */
export function wordSound(x: Float32Array, startMs: number, endMs: number): { flat: number; db: number; dbStd: number } {
  const a = Math.max(0, Math.floor(((startMs + (endMs - startMs) * 0.2) / 1000) * SR));
  const b = Math.min(x.length, Math.floor(((endMs - (endMs - startMs) * 0.2) / 1000) * SR));
  const psd = new Float64Array(BAND[1] - BAND[0] + 1);
  const dbs: number[] = [];
  for (let at = a; at + FRAME <= b || (dbs.length === 0 && at < b); at += HOP) {
    const re = new Float64Array(FRAME), im = new Float64Array(FRAME);
    let sq = 0;
    for (let k = 0; k < FRAME; k++) { const v = x[at + k] ?? 0; sq += v * v; re[k] = v * HANN[k]; }
    fft(re, im);
    for (let bin = BAND[0]; bin <= BAND[1]; bin++) psd[bin - BAND[0]] += (re[bin] * re[bin] + im[bin] * im[bin]) * bin;
    dbs.push(10 * Math.log10(sq / FRAME + 1e-20));
  }
  let logSum = 0, sum = 0;
  for (const p of psd) { logSum += Math.log(p + 1e-20); sum += p; }
  const db = dbs.reduce((s, v) => s + v, 0) / dbs.length;
  return { flat: Math.exp(logSum / psd.length) / (sum / psd.length + 1e-20), db, dbStd: Math.sqrt(dbs.reduce((s, v) => s + (v - db) ** 2, 0) / dbs.length) };
}

/** 1 = the word is under the bleep (soft pink noise), 0 = speech or silence. Measured on the test calls
 *  (mp3 → 16 kHz stereo decode): noise flatness ≥ 0.88, speech ≤ 0.60. The level only rules out digital silence
 *  (flat by definition) and loud sounds: a clip's 1 s fade-in or fade-out turns the noise down, not less flat. */
export function bleepShare(x: Float32Array, startMs: number, endMs: number): number {
  const w = wordSound(x, startMs, endMs);
  return w.flat > BLEEP_FLAT && w.db > -70 && w.db < BLEEP.rmsDbfs + 4 ? 1 : 0;
}
export const BLEEP_FLAT = 0.75;
export const BLEEPED = 0.5;

type Transcript = Record<string, unknown> & { id: string; job: string; pass: 1 | 2 };

export class Fakes {
  readonly transcripts = new Map<string, Transcript>();
  readonly deleted = new Set<string>();
  readonly llm = { calls: 0, retries: 0, clips: 0, systems: [] as string[] };
  readonly telnyx = { lookups: 0, expired: new Set<string>() };
  readonly webhooks: string[] = [];
  /** while true, every transcript reads back as still processing (keeps a job mid-run for the cancel / crash scenarios) */
  holdAsr = false;
  listCalls = 0;
  readonly uploads: string[] = [];
  readonly downloads: string[] = [];
  readonly refusedStorage: string[] = [];
  private seq = 0;
  private bySha = new Map<string, Manifest>();
  private jobFixture = new Map<string, Manifest>();
  private firstLlm = new Set<string>();

  constructor(private opts: { storageDir: string; signKey: string; fixturesDir: string; base: () => string }) {}

  /** recording id (Telnyx) → test call */
  readonly recordings = new Map<string, { file: string; m: Manifest }>();

  addRecording(id: string, file: string, m: Manifest) {
    this.recordings.set(id, { file, m });
    this.bySha.set(createHash("sha256").update(readFileSync(file)).digest("hex"), m);
  }

  manifestForJob(job: string) { return this.jobFixture.get(job); }

  /** a transcript nobody recorded (as if its worker died right after submitting), created `agoMs` ago */
  plantOrphan(id: string, agoMs: number) {
    this.transcripts.set(id, { id, job: "orphan", pass: 1, status: "completed", created: new Date(Date.now() - agoMs).toISOString(), words: [], entities: [] });
  }

  private checkToken(bucket: string, p: string, mode: "upload" | "download", token: string): boolean {
    const [body, mac] = token.split(".");
    if (!body || !mac) return false;
    const want = createHmac("sha256", this.opts.signKey).update(body).digest();
    const got = Buffer.from(mac, "hex");
    if (got.length !== want.length || !timingSafeEqual(want, got)) return false;
    const t = JSON.parse(Buffer.from(body, "base64").toString("utf8"));
    return t.b === bucket && t.p === p && t.m === mode && t.e > Date.now() / 1000;
  }

  /** read a signed download URL the way AssemblyAI would fetch it */
  private readSigned(url: string): { bucket: string; p: string; bytes: Buffer } | null {
    const u = new URL(url);
    const m = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(u.pathname);
    if (!m || !this.checkToken(m[1], m[2], "download", u.searchParams.get("token") ?? "")) return null;
    const f = path.join(this.opts.storageDir, m[1], m[2]);
    return existsSync(f) ? { bucket: m[1], p: m[2], bytes: readFileSync(f) } : null;
  }

  listen(port: number) {
    const server = createServer((req, res) => {
      this.handle(req, res).catch((e) => { res.writeHead(500); res.end(String(e?.message ?? e)); });
    });
    return new Promise<typeof server>((ok) => server.listen(port, "127.0.0.1", () => ok(server)));
  }

  private async body(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private json(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const u = new URL(req.url ?? "/", "http://x");
    const p = u.pathname;

    // ── Supabase Storage signed URLs ──
    let m = /^\/storage\/v1\/object\/upload\/sign\/([^/]+)\/(.+)$/.exec(p);
    if (m && (req.method === "PUT" || req.method === "POST")) {
      if (!this.checkToken(m[1], m[2], "upload", u.searchParams.get("token") ?? "")) { this.refusedStorage.push(`upload ${m[1]}/${m[2]}`); return this.json(res, 403, { error: "bad token" }); }
      const f = path.join(this.opts.storageDir, m[1], m[2]);
      mkdirSync(path.dirname(f), { recursive: true });
      writeFileSync(f, await this.body(req));
      this.uploads.push(`${m[1]}/${m[2]}`);
      return this.json(res, 200, { Key: `${m[1]}/${m[2]}` });
    }
    m = /^\/storage\/v1\/object\/sign\/([^/]+)\/(.+)$/.exec(p);
    if (m && req.method === "GET") {
      if (!this.checkToken(m[1], m[2], "download", u.searchParams.get("token") ?? "")) { this.refusedStorage.push(`download ${m[1]}/${m[2]}`); return this.json(res, 403, { error: "bad token" }); }
      const f = path.join(this.opts.storageDir, m[1], m[2]);
      if (!existsSync(f)) return this.json(res, 404, { error: "not found" });
      this.downloads.push(`${m[1]}/${m[2]}`);
      res.writeHead(200); return res.end(readFileSync(f));
    }

    // ── Telnyx ──
    m = /^\/telnyx\/v2\/recordings\/([0-9a-f-]{36})$/.exec(p);
    if (m) {
      this.telnyx.lookups++;
      const rec = this.recordings.get(m[1]);
      if (!rec || this.telnyx.expired.has(m[1])) return this.json(res, 404, { errors: [{ code: "10005", title: "Resource not found" }] });
      return this.json(res, 200, { data: { id: m[1], download_urls: { mp3: `${this.opts.base()}/recordings/${m[1]}.mp3` } } });
    }
    if (p.startsWith("/telnyx/v2/recordings")) return this.json(res, 200, { data: [] });
    m = /^\/recordings\/([0-9a-f-]{36})\.mp3$/.exec(p);
    if (m) {
      const rec = this.recordings.get(m[1]);
      if (!rec || this.telnyx.expired.has(m[1])) return this.json(res, 404, {});
      res.writeHead(200, { "content-type": "audio/mpeg" }); return res.end(readFileSync(rec.file));
    }

    // ── AssemblyAI ──
    if (p === "/aai/v2/transcript" && req.method === "POST") {
      if (!req.headers.authorization) return this.json(res, 401, { error: "no key" });
      const b = JSON.parse((await this.body(req)).toString("utf8"));
      const file = this.readSigned(String(b.audio_url));
      if (!file) return this.json(res, 400, { error: "could not download audio_url" });
      const job = file.p.split("/")[0];
      let t: Transcript;
      const id = `sim_${String(++this.seq).padStart(4, "0")}_${job.slice(0, 8)}`;
      if (b.multichannel) {
        const fx = this.bySha.get(createHash("sha256").update(file.bytes).digest("hex"));
        if (!fx) return this.json(res, 400, { error: "unknown audio" });
        this.jobFixture.set(job, fx);
        const words = wordsOf(fx);
        const entities = fx.planted.filter((x) => ENTITY[x.kind]).map((x) => {
          const ws = plantedWords(fx, words, x);
          return { entity_type: ENTITY[x.kind], text: x.text, start: ws[0].start, end: ws[ws.length - 1].end };
        });
        t = {
          id, job, pass: 1, status: "completed", audio_duration: fx.total_ms / 1000, audio_channels: 2, speech_model_used: b.speech_models?.[0],
          words: words.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence, channel: String(w.ch + 1) })),
          utterances: [], entities,
        };
      } else {
        const fx = this.jobFixture.get(job);
        if (!fx) return this.json(res, 400, { error: "verification before pass 1" });
        const tmp = path.join(this.opts.storageDir, `.decode-${id}.mp3`);
        writeFileSync(tmp, file.bytes);
        const chans = decodeStereo(tmp);
        const words = wordsOf(fx);
        const audible = (w: Word) => bleepShare(chans[w.ch], w.start, w.end) < BLEEPED;
        const kept = words.filter(audible);
        const entities = fx.planted.filter((x) => ENTITY[x.kind]).flatMap((x) => {
          const ws = plantedWords(fx, words, x).filter(audible);
          return ws.length ? [{ entity_type: ENTITY[x.kind], text: ws.map((w) => w.text).join(" "), start: ws[0].start, end: ws[ws.length - 1].end }] : [];
        });
        t = {
          id, job, pass: 2, status: "completed", audio_duration: fx.total_ms / 1000, audio_channels: 1, speech_model_used: b.speech_models?.[0],
          words: kept.map((w) => ({ text: w.text, start: w.start, end: w.end, confidence: w.confidence })),
          utterances: [], entities,
        };
      }
      t.created = new Date().toISOString();
      this.transcripts.set(id, t);
      // AssemblyAI calls the webhook when the transcript is ready
      if (b.webhook_url) {
        setTimeout(() => {
          this.webhooks.push(id);
          fetch(b.webhook_url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transcript_id: id, status: "completed" }) }).catch(() => {});
        }, 300);
      }
      return this.json(res, 200, { id, status: "queued" });
    }
    // list (the worker's orphan sweep): newest first, like AssemblyAI; deleted ones keep a placeholder audio_url
    if (p === "/aai/v2/transcript" && req.method === "GET") {
      this.listCalls++;
      const rows = [...this.transcripts.values()].reverse().map((t) => ({
        id: t.id, status: "completed", created: t.created as string,
        audio_url: this.deleted.has(t.id) ? "http://deleted_by_user" : "https://storage.example/audio",
      }));
      return this.json(res, 200, { transcripts: rows.slice(0, 200), page_details: { prev_url: null } });
    }
    m = /^\/aai\/v2\/transcript\/([A-Za-z0-9_-]+)$/.exec(p);
    if (m) {
      const t = this.transcripts.get(m[1]);
      if (req.method === "DELETE") {
        if (!t) return this.json(res, 404, { error: "not found" });
        this.deleted.add(m[1]);
        return this.json(res, 200, { id: m[1], status: "completed", words: [], text: "" });
      }
      if (!t || this.deleted.has(m[1])) return this.json(res, 404, { error: "not found" });
      const { job: _j, pass: _p, ...pub } = t;
      if (this.holdAsr) return this.json(res, 200, { id: pub.id, status: "processing" });
      return this.json(res, 200, pub);
    }

    // ── OpenRouter ──
    if (p === "/openrouter/api/v1/chat/completions") {
      const b = JSON.parse((await this.body(req)).toString("utf8"));
      const schema = b.response_format?.json_schema?.name;
      const user = String(b.messages?.find((x: { role: string }) => x.role === "user")?.content ?? "");
      this.llm.calls++;
      let content: unknown;
      if (schema === "pii_items") content = { items: [] };
      else if (schema === "call_clips_coaching") {
        this.llm.systems.push(String(b.messages?.find((x: { role: string }) => x.role === "system")?.content ?? ""));
        content = this.coaching(user);
      }
      else return this.json(res, 400, { error: `unknown schema ${schema}` });
      return this.json(res, 200, { model: b.model, choices: [{ message: { content: JSON.stringify(content) }, finish_reason: "stop" }], usage: { cost: 0.0012 } });
    }

    this.json(res, 404, { error: `sim: no route ${req.method} ${p}` });
  }

  private coaching(user: string) {
    const ids = [...user.matchAll(/^u(\d+) \[/gm)].map((x) => Number(x[1]));
    const key = ids.join(",");
    const retry = /previous answer was invalid/.test(user);
    if (retry) this.llm.retries++;
    const at = (f: number) => ids[Math.min(ids.length - 1, Math.max(0, Math.floor(ids.length * f)))];
    const span = (f: number, n: number) => { const a = ids.indexOf(at(f)); return [ids[a], ids[Math.min(ids.length - 1, a + n)]] as const; };
    const s = { rapport: 4, discovery: 3, objections: 4, close: 4, compliance: 5 };
    const clip = (label: string, sub: string, [a, z]: readonly [number, number], title: string) => ({
      label, sub_label: sub, from_u: a, to_u: z, title, did: "Asked open questions and listened.", worked: "Kept a calm, friendly pace.",
      improve: "Confirm the monthly budget before presenting.", key_line_ids: [a], scores: { ...s, close: null }, confidence: 0.82,
    });
    const answer = {
      clips: [
        clip("opener", "none", span(0, 3), "Warm opener sets the tone"),
        clip("objection", "price", span(0.45, 3), "Handling a price concern"),
        clip("application", "none", span(0.7, 3), "Taking the application"),
        clip("close", "none", span(0.88, 3), "Clear next step at the close"),
      ],
      call: {
        summary: "The agent opened warmly and built rapport. They found the need and handled a price objection. They closed with a clear next step.",
        strengths: ["Warm opener", "Clear explanation of coverage", "Calm close"],
        improvements: ["Ask about budget sooner", "Summarise benefits once more", "Confirm the beneficiary earlier"],
        scores: s, turning_point_clip: 1,
      },
    };
    if (!retry && !this.firstLlm.has(key)) {
      this.firstLlm.add(key);
      return { ...answer, call: { ...answer.call, strengths: ["only one"] } };   // invalid: needs exactly 3
    }
    this.llm.clips += answer.clips.length;
    return answer;
  }
}
