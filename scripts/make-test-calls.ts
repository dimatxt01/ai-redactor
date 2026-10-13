// Turns fixtures/calls/*.txt into real dual-channel telephony mp3s with planted
// fake PII: customer on channel 0, agent on channel 1 (pass --customer-channel 1
// to swap), 8 kHz, like Telnyx `record_start {channels:'dual'}`.
//   npm run make-test-calls [-- <name> ...]   → fixtures/out/<name>.mp3 + <name>.planted.json
// Lines follow each other with a 0.4 s gap; a `>>-<ms>` line starts that many ms before
// the previous line ends (crosstalk), so both channels carry speech at once.
// macOS only (uses `say`). Values are fictional; nothing here is real data.
import { execFile } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import ffmpegStatic from "ffmpeg-static";
import { loadScripts } from "../fixtures/parse";

const run = promisify(execFile);
const ffmpeg = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
const root = path.join(import.meta.dirname, "..", "fixtures");
const out = path.join(root, "out");
const args = process.argv.slice(2);
const customerChannel = args.includes("--customer-channel") && args[args.indexOf("--customer-channel") + 1] === "1" ? 1 : 0;
const only = args.filter((a, k) => !a.startsWith("--") && args[k - 1] !== "--customer-channel");
const VOICES = { agent: process.env.AGENT_VOICE ?? "Samantha", customer: process.env.CUSTOMER_VOICE ?? "Fred" };
const SR = 8000;
const GAP_MS = 400;
const POOL = Math.max(2, Math.min(8, os.cpus().length));

/** Speak one line and return it as 8 kHz mono s16 samples. */
async function speak(tmp: string, k: number, voice: string, text: string): Promise<Int16Array> {
  const aiff = path.join(tmp, `${k}.aiff`), raw = path.join(tmp, `${k}.raw`);
  await run("say", ["-v", voice, "-o", aiff, text]);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", aiff, "-ac", "1", "-ar", String(SR), "-f", "s16le", raw]);
  const b = readFileSync(raw);
  rmSync(aiff, { force: true });
  rmSync(raw, { force: true });
  return new Int16Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));   // own, aligned copy
}

async function pool<T>(n: number, jobs: (() => Promise<T>)[]): Promise<T[]> {
  const res: T[] = new Array(jobs.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, jobs.length) }, async () => {
    while (next < jobs.length) { const k = next++; res[k] = await jobs[k](); }
  }));
  return res;
}

mkdirSync(out, { recursive: true });
const t0 = Date.now();
for (const call of loadScripts(path.join(root, "calls")).filter((c) => !only.length || only.includes(c.name))) {
  const started = Date.now();
  const tmp = path.join(out, `.tmp-${call.name}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const pcm = await pool(POOL, call.lines.map((line, k) => () => speak(tmp, k, line.speaker === "agent" ? VOICES.agent : VOICES.customer, line.text)));

  // timeline: each line after the previous one (+ gap), or overlapping it by overlap_ms
  const ms = (n: number) => Math.round((n / SR) * 1000);
  const starts: number[] = [], ends: number[] = [];
  let cursor = 0, lastEnd = 0;
  call.lines.forEach((line, k) => {
    const start = k > 0 && line.overlap_ms > 0 ? Math.max(starts[k - 1], ends[k - 1] - line.overlap_ms) : cursor;
    starts.push(start);
    ends.push(start + ms(pcm[k].length));
    lastEnd = Math.max(lastEnd, ends[k]);
    cursor = lastEnd + GAP_MS;
  });
  const totalMs = lastEnd + GAP_MS;

  // mix each speaker onto their own channel, interleave, encode
  const n = Math.ceil((totalMs / 1000) * SR);
  const stereo = new Int16Array(n * 2);
  call.lines.forEach((line, k) => {
    const onLeft = (line.speaker === "customer") === (customerChannel === 0);
    const c = onLeft ? 0 : 1;
    const off = Math.round((starts[k] / 1000) * SR);
    const s = pcm[k];
    for (let i = 0; i < s.length && off + i < n; i++) {
      const j = (off + i) * 2 + c;
      stereo[j] = Math.max(-32768, Math.min(32767, stereo[j] + s[i]));
    }
  });
  const rawFile = path.join(tmp, "mix.raw");
  writeFileSync(rawFile, Buffer.from(stereo.buffer));
  const mp3 = path.join(out, `${call.name}.mp3`);
  await run(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "s16le", "-ar", String(SR), "-ac", "2", "-i", rawFile, "-ac", "2", "-ar", String(SR), "-b:a", "32k", mp3]);
  writeFileSync(
    path.join(out, `${call.name}.planted.json`),
    JSON.stringify({
      name: call.name, customer_channel: customerChannel, agent: call.agent, caller: call.caller, strict: call.strict,
      planted: call.planted, line_starts_ms: starts, line_ends_ms: ends, total_ms: totalMs,
      lines: call.lines.map((l) => ({ speaker: l.speaker, text: l.text, overlap_ms: l.overlap_ms })),
    }, null, 1),
  );
  rmSync(tmp, { recursive: true, force: true });
  const overlaps = call.lines.filter((l) => l.overlap_ms > 0).length;
  console.log(`wrote ${path.relative(process.cwd(), mp3)} (${(totalMs / 60000).toFixed(1)} min, ${call.planted.length} planted values${overlaps ? `, ${overlaps} overlapping lines` : ""}, ${((Date.now() - started) / 1000).toFixed(0)} s)`);
}
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
