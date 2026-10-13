// Audio DSP via ffmpeg (ffmpeg-static). Bleeping itself is done on PCM in JS so
// it is sample-exact and testable; ffmpeg does decode, channel split, the
// customer pitch-shift, the mono mix and encoding.
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { BLEEP, HIGHLIGHT, PITCH_SEMITONES } from "./config";
import type { Interval } from "./pii/detect";

export const WORK_SR = 16_000;   // processing rate; telephony source is ≤16 kHz

const ffmpegPath = () => process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);

function run(args: string[]): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr = (stderr + d.toString()).slice(-20_000); });
    p.on("error", reject);
    p.on("close", (code) => resolve({ code: code ?? -1, stderr }));
  });
}

async function must(args: string[], what: string) {
  const r = await run(["-y", "-loglevel", "error", ...args]);
  if (r.code !== 0) throw new Error(`ffmpeg ${what} failed (${r.code})`);
}

export type Probe = { durationMs: number; channels: number; sampleRate: number; bitrateKbps: number | null; codec: string };

export async function probe(file: string): Promise<Probe> {
  const { stderr } = await run(["-i", file]);   // exits non-zero (no output); stderr has the stream info
  const d = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const a = /Audio: ([a-z0-9_]+)[^,]*, (\d+) Hz, ([^,]+)/.exec(stderr);
  const br = /bitrate: (\d+) kb\/s/.exec(stderr);
  if (!d || !a) throw new Error("probe: no audio stream");
  const layout = a[3].trim();
  const channels = layout === "mono" ? 1 : layout === "stereo" ? 2 : Number(/(\d+) channels/.exec(layout)?.[1] ?? 0);
  return {
    durationMs: Math.round((Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3])) * 1000),
    channels,
    sampleRate: Number(a[2]),
    bitrateKbps: br ? Number(br[1]) : null,
    codec: a[1],
  };
}

let filterList: Promise<string> | null = null;
export function hasFilter(name: string): Promise<boolean> {
  // `ffmpeg -filters` prints the table on stdout
  filterList ??= new Promise<string>((resolve) => {
    const p = spawn(ffmpegPath(), ["-hide_banner", "-filters"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => resolve(out));
    p.on("error", () => resolve(""));
  });
  return filterList.then((list) => new RegExp(`\\s${name}\\s`).test(list));
}

export type PitchEngine = "rubberband" | "resample" | "none";

const PITCH_CHUNK_S = 30;

/** Stereo source → two 16 kHz s16 channels (index 0 = left/channel 0). */
export async function decodeChannels(src: string, dir: string): Promise<[Int16Array, Int16Array]> {
  const file = path.join(dir, "stereo.pcm");
  await must(["-i", src, "-af", "aformat=channel_layouts=stereo", "-ac", "2", "-ar", String(WORK_SR), "-f", "s16le", file], "decode");
  const buf = await readFile(file);
  await rm(file, { force: true });
  const inter = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const n = Math.floor(inter.length / 2);
  const a = new Int16Array(n), b = new Int16Array(n);
  for (let k = 0; k < n; k++) { a[k] = inter[2 * k]; b[k] = inter[2 * k + 1]; }
  return [a, b];
}

/** Zero every interval (both legs: the read-back echo leaks too). In place. */
export function silencePcm(pcm: Int16Array, sr: number, intervals: Interval[]): void {
  for (const iv of intervals) {
    const a = Math.max(0, Math.floor((iv.start_ms / 1000) * sr));
    const b = Math.min(pcm.length, Math.ceil((iv.end_ms / 1000) * sr));
    pcm.fill(0, a, Math.max(a, b));
  }
}

/**
 * Pitch-shift one channel, 30 s at a time, each chunk trimmed/padded back to
 * its exact length: the shift never moves audio more than one chunk's drift
 * (tens of ms) and the drift cannot accumulate over an hour-long call.
 * Runs AFTER the PII is silenced, so timing error can never expose PII.
 */
export async function pitchShiftPcm(pcm: Int16Array, dir: string): Promise<PitchEngine> {
  const ratio = Math.pow(2, PITCH_SEMITONES / 12);
  const rubber = await hasFilter("rubberband");
  const chain = rubber
    ? `rubberband=pitch=${ratio.toFixed(6)}:formant=preserved`
    : `asetrate=${Math.round(WORK_SR * ratio)},aresample=${WORK_SR},atempo=${(1 / ratio).toFixed(6)}`;
  const chunk = PITCH_CHUNK_S * WORK_SR;
  const inF = path.join(dir, "chunk-in.pcm"), outF = path.join(dir, "chunk-out.pcm");
  for (let a = 0; a < pcm.length; a += chunk) {
    const part = pcm.subarray(a, Math.min(pcm.length, a + chunk));
    await writeFile(inF, Buffer.from(part.buffer, part.byteOffset, part.byteLength));
    await must(["-f", "s16le", "-ar", String(WORK_SR), "-ac", "1", "-i", inF, "-af", chain, "-ar", String(WORK_SR), "-ac", "1", "-f", "s16le", outF], "pitch");
    const shifted = await readPcm(outF);
    const n = Math.min(part.length, shifted.length);
    part.set(shifted.subarray(0, n));
    if (n < part.length) part.fill(0, n);
  }
  await rm(inF, { force: true });
  await rm(outF, { force: true });
  return rubber ? "rubberband" : "resample";
}

/**
 * The redacted mono mix: PII silenced on both legs on the ORIGINAL timeline
 * (where AssemblyAI's timestamps are true), customer leg optionally
 * pitch-shifted, legs summed with a hard ceiling, then the tone laid over every
 * interval. Returns 16 kHz mono s16.
 */
export async function renderRedacted(src: string, dir: string, bleeps: Interval[], opts: { customerChannel: 0 | 1; pitch: boolean }): Promise<{ pcm: Int16Array; engine: PitchEngine }> {
  const [ch0, ch1] = await decodeChannels(src, dir);
  silencePcm(ch0, WORK_SR, bleeps);
  silencePcm(ch1, WORK_SR, bleeps);
  const customer = opts.customerChannel === 0 ? ch0 : ch1;
  const agent = opts.customerChannel === 0 ? ch1 : ch0;
  const engine: PitchEngine = opts.pitch ? await pitchShiftPcm(customer, dir) : "none";
  const n = Math.min(customer.length, agent.length);
  const mix = new Int16Array(n);
  for (let k = 0; k < n; k++) {
    const v = customer[k] + agent[k];
    mix[k] = v > 31128 ? 31128 : v < -31128 ? -31128 : v;   // -0.45 dBFS ceiling
  }
  bleepPcm(mix, WORK_SR, bleeps);
  return { pcm: mix, engine };
}

/** Replace every interval with a 1 kHz tone at -12 dBFS (5 ms raised-cosine ramps on the tone only). In place. */
export function bleepPcm(pcm: Int16Array, sr: number, intervals: Interval[]): number {
  const amp = Math.pow(10, BLEEP.dbfs / 20) * 32767;
  const fade = Math.max(1, Math.round((BLEEP.edgeFadeMs / 1000) * sr));
  let samples = 0;
  for (const iv of intervals) {
    const a = Math.max(0, Math.floor((iv.start_ms / 1000) * sr));
    const b = Math.min(pcm.length, Math.ceil((iv.end_ms / 1000) * sr));
    const n = Math.max(0, b - a);
    for (let k = 0; k < n; k++) {
      const edge = Math.min(k, n - 1 - k);
      const g = edge < fade ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade) : 1;
      // the interval's original samples are dropped entirely; only the tone ramps in and out
      pcm[a + k] = Math.round(Math.sin((2 * Math.PI * BLEEP.toneHz * k) / sr) * amp * g);
    }
    samples += n;
  }
  return samples;
}

export async function readPcm(file: string): Promise<Int16Array> {
  const buf = await readFile(file);
  return new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
}

export async function writePcm(file: string, pcm: Int16Array): Promise<void> {
  await writeFile(file, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));
}

/** Mono PCM → mp3 44.1 kHz / 128 kbps, version stamped in the ID3 comment. */
export async function encodeMp3(pcmFile: string, outMp3: string, versionTag: string): Promise<void> {
  await must(
    ["-f", "s16le", "-ar", String(WORK_SR), "-ac", "1", "-i", pcmFile, "-ar", "44100", "-ac", "1", "-b:a", "128k",
      "-id3v2_version", "3", "-metadata", `comment=${versionTag}`, "-metadata", "title=TrueRing redacted sample", outMp3],
    "encode",
  );
}

/** Cut [start,end] from the already-redacted mp3 with 1 s fades. */
export async function cutHighlight(srcMp3: string, outMp3: string, iv: Interval, versionTag: string): Promise<void> {
  const ss = iv.start_ms / 1000;
  const dur = (iv.end_ms - iv.start_ms) / 1000;
  const f = HIGHLIGHT.fadeS;
  await must(
    ["-ss", ss.toFixed(3), "-t", dur.toFixed(3), "-i", srcMp3,
      "-af", `afade=t=in:st=0:d=${f},afade=t=out:st=${Math.max(0, dur - f).toFixed(3)}:d=${f}`,
      "-ar", "44100", "-ac", "1", "-b:a", "128k", "-id3v2_version", "3", "-metadata", `comment=${versionTag}`, outMp3],
    "highlight",
  );
}
