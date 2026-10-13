// Build gate: ffmpeg-static downloads its binary in a postinstall script. An install with
// --ignore-scripts (some CI) leaves it missing, and every job would then fail at render time.
// Runs as postinstall and before tests: a missing binary fails the install / image build, not the first job.
import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
const bin = createRequire(import.meta.url)("ffmpeg-static");
if (!bin || !existsSync(bin) || statSync(bin).size < 1_000_000) {
  console.error(`ffmpeg-static binary missing (${bin ?? "no path"}). Run \`npm rebuild ffmpeg-static\` (install scripts must run).`);
  process.exit(1);
}
console.log(`ffmpeg-static ok: ${bin}`);
