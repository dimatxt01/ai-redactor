// Turns fixtures/calls/*.txt into real dual-channel telephony mp3s with planted
// fake PII: customer on channel 0, agent on channel 1 (pass --customer-channel 1
// to swap), 8 kHz, like Telnyx `record_start {channels:'dual'}`.
//   npm run make-test-calls            → fixtures/out/<name>.mp3 + <name>.planted.json
// macOS only (uses `say`). Values are fictional; nothing here is real data.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import ffmpegStatic from "ffmpeg-static";
import { loadScripts } from "../fixtures/parse";

const ffmpeg = process.env.FFMPEG_PATH || (ffmpegStatic as unknown as string);
const root = path.join(import.meta.dirname, "..", "fixtures");
const out = path.join(root, "out");
const customerChannel = process.argv.includes("--customer-channel") && process.argv[process.argv.indexOf("--customer-channel") + 1] === "1" ? 1 : 0;
const VOICES = { agent: process.env.AGENT_VOICE ?? "Samantha", customer: process.env.CUSTOMER_VOICE ?? "Fred" };

mkdirSync(out, { recursive: true });
for (const call of loadScripts(path.join(root, "calls"))) {
  const tmp = path.join(out, `.tmp-${call.name}`);
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  const segs: string[] = [];
  const lineStartsMs: number[] = [];
  let at = 0;
  call.lines.forEach((line, k) => {
    const aiff = path.join(tmp, `${k}.aiff`);
    execFileSync("say", ["-v", line.speaker === "agent" ? VOICES.agent : VOICES.customer, "-o", aiff, line.text]);
    // one stereo segment per line: the speaker on their channel, silence on the other, 0.4 s gap after
    const onLeft = (line.speaker === "customer") === (customerChannel === 0);
    const pan = onLeft ? "pan=stereo|c0=c0|c1=0*c0" : "pan=stereo|c0=0*c0|c1=c0";
    const seg = path.join(tmp, `${k}.wav`);
    execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-i", aiff, "-af", `aresample=8000,${pan},apad=pad_dur=0.4`, "-ar", "8000", seg]);
    segs.push(seg);
    lineStartsMs.push(at);
    const info = spawnSync(ffmpeg, ["-hide_banner", "-i", seg, "-f", "null", "-"], { encoding: "utf8" }).stderr;
    const d = /time=(\d+):(\d+):(\d+\.\d+)/g;
    let last: RegExpExecArray | null = null, m: RegExpExecArray | null;
    while ((m = d.exec(info))) last = m;
    at += last ? Math.round((Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3])) * 1000) : 0;
  });
  const list = path.join(tmp, "list.txt");
  writeFileSync(list, segs.map((s) => `file '${s}'`).join("\n"));
  const mp3 = path.join(out, `${call.name}.mp3`);
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-ac", "2", "-ar", "8000", "-b:a", "32k", mp3]);
  writeFileSync(
    path.join(out, `${call.name}.planted.json`),
    JSON.stringify({ name: call.name, customer_channel: customerChannel, agent: call.agent, caller: call.caller, planted: call.planted, line_starts_ms: lineStartsMs, total_ms: at, lines: call.lines.map((l) => ({ speaker: l.speaker, text: l.text })) }, null, 1),
  );
  rmSync(tmp, { recursive: true, force: true });
  console.log(`wrote ${path.relative(process.cwd(), mp3)} (${call.planted.length} planted values)`);
}
