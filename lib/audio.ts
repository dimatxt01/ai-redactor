// Audio DSP via ffmpeg (ffmpeg-static). Bleeping itself is done on PCM in JS so
// it is sample-exact and testable; ffmpeg does decode, channel split, the
// customer pitch-shift, the mono mix and encoding.
import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { BLEEP, CLIPS, PITCH_SEMITONES } from "./config";
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

/** Health: is the bundled binary there, and does it run on this platform? (proves ffmpeg-static shipped) */
export function ffmpegInfo(): Promise<{ ok: boolean; version: string | null; bytes: number | null; platform: string }> {
  const bin = ffmpegPath();
  let bytes: number | null = null;
  try { bytes = statSync(bin).size; } catch { /* missing */ }
  return new Promise((resolve) => {
    const done = (version: string | null) => resolve({ ok: !!version, version, bytes, platform: `${process.platform}-${process.arch}` });
    if (bytes === null) return done(null);
    const p = spawn(bin, ["-hide_banner", "-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", (code) => done(code === 0 ? (/^ffmpeg version (\S+)/.exec(out)?.[1] ?? "unknown") : null));
    p.on("error", () => done(null));
  });
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
 * pitch-shifted, legs summed with a hard ceiling, then the bleep (soft pink noise)
 * laid over every interval. Returns 16 kHz mono s16.
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

/** Seeded uniform PRNG in [-1, 1) (mulberry32): the same intervals always render the same noise. */
function noiseSource(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return (((r ^ (r >>> 14)) >>> 0) / 4294967296) * 2 - 1;
  };
}

/** n samples of pink noise (Paul Kellet's economy filter, warmed up first), scaled to `rms`. */
export function pinkNoise(n: number, rms: number, seed: number): Float64Array {
  const white = noiseSource(seed);
  let b0 = 0, b1 = 0, b2 = 0;
  const step = () => {
    const w = white();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    return b0 + b1 + b2 + w * 0.1848;
  };
  for (let k = 0; k < 4000; k++) step();   // past the filter's start-up
  const out = new Float64Array(n);
  let sq = 0;
  for (let k = 0; k < n; k++) { out[k] = step(); sq += out[k] * out[k]; }
  const g = n ? rms / Math.sqrt(sq / n || 1) : 0;
  for (let k = 0; k < n; k++) out[k] *= g;
  return out;
}

/** Replace every interval with soft pink noise at BLEEP.rmsDbfs (raised-cosine fades on the noise only). In place. */
export function bleepPcm(pcm: Int16Array, sr: number, intervals: Interval[]): number {
  const rms = Math.pow(10, BLEEP.rmsDbfs / 20) * 32767;
  const fade = Math.max(1, Math.round((BLEEP.edgeFadeMs / 1000) * sr));
  let samples = 0;
  intervals.forEach((iv, i) => {
    const a = Math.max(0, Math.floor((iv.start_ms / 1000) * sr));
    const b = Math.min(pcm.length, Math.ceil((iv.end_ms / 1000) * sr));
    const n = Math.max(0, b - a);
    const noise = pinkNoise(n, rms, BLEEP.seed + i);
    for (let k = 0; k < n; k++) {
      const edge = Math.min(k, n - 1 - k);
      const g = edge < fade ? 0.5 - 0.5 * Math.cos((Math.PI * edge) / fade) : 1;
      // the interval's original samples are dropped entirely; only the noise fades in and out
      const v = Math.round(noise[k] * g);
      pcm[a + k] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
    }
    samples += n;
  });
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

/** Cut a clip [start,end] from the already-redacted mp3 with 1 s fades (SPEC v0.2 §2.6). */
export async function cutClip(srcMp3: string, outMp3: string, iv: Interval, versionTag: string): Promise<void> {
  const ss = iv.start_ms / 1000;
  const dur = (iv.end_ms - iv.start_ms) / 1000;
  const f = CLIPS.fadeS;
  await must(
    ["-ss", ss.toFixed(3), "-t", dur.toFixed(3), "-i", srcMp3,
      "-af", `afade=t=in:st=0:d=${f},afade=t=out:st=${Math.max(0, dur - f).toFixed(3)}:d=${f}`,
      "-ar", "44100", "-ac", "1", "-b:a", "128k", "-id3v2_version", "3", "-metadata", `comment=${versionTag}`, outMp3],
    "clip",
  );
}
