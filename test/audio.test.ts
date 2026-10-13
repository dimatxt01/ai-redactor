// Real ffmpeg. The test-call part needs `npm run make-test-calls` (skipped otherwise).
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cutClip, encodeMp3, pitchShiftPcm, probe, renderRedacted, writePcm, WORK_SR } from "@/lib/audio";

let dir = "";
beforeAll(async () => { dir = await mkdtemp(path.join(tmpdir(), "sr-audio-")); });
afterAll(async () => { if (dir) await rm(dir, { recursive: true, force: true }); });

/** Index of the first sample of each loud burst (after ≥0.5 s quiet). */
function onsets(pcm: Int16Array, thr = 3000): number[] {
  const out: number[] = [];
  let quiet = WORK_SR;
  for (let k = 0; k < pcm.length; k++) {
    if (Math.abs(pcm[k]) > thr) { if (quiet >= WORK_SR / 2) out.push(k); quiet = 0; } else quiet++;
  }
  return out;
}

describe("pitch shift timing", () => {
  it("keeps length exact and never moves audio more than 100 ms, even 20 minutes in", async () => {
    const seconds = 20 * 60;
    const pcm = new Int16Array(seconds * WORK_SR);
    const marks = [5, 61, 300, 599, 900, 1190];
    for (const s of marks) for (let k = 0; k < 2000; k++) pcm[s * WORK_SR + k] = Math.round(Math.sin(k / 3) * 20000);
    await pitchShiftPcm(pcm, dir);
    expect(pcm.length).toBe(seconds * WORK_SR);
    const got = onsets(pcm);
    expect(got).toHaveLength(marks.length);
    got.forEach((k, j) => expect(Math.abs(k / WORK_SR - marks[j])).toBeLessThan(0.1));
  }, 120_000);
});

const SRC = path.join(import.meta.dirname, "..", "fixtures", "out", "01-classic-sale.mp3");
(existsSync(SRC) ? describe : describe.skip)("ffmpeg pipeline on a test call", () => {
  it("renders, keeps nothing of the source inside a bleep, encodes and cuts", async () => {
    const p = await probe(SRC);
    expect(p.channels).toBe(2);
    expect(p.sampleRate).toBe(8000);

    const bleeps = [{ start_ms: 10_000, end_ms: 12_000 }];
    const { pcm, engine } = await renderRedacted(SRC, dir, bleeps, { customerChannel: 0, pitch: true });
    expect(["rubberband", "resample"]).toContain(engine);
    expect(Math.abs((pcm.length / WORK_SR) * 1000 - p.durationMs)).toBeLessThan(200);   // mp3 decoder delay only

    // inside the bleep the mix is exactly the tone (deterministic), i.e. nothing of either leg
    const a = 10_000 * WORK_SR / 1000;
    for (let k = 200; k < 31_000; k += 997) {
      const tone = Math.round(Math.sin((2 * Math.PI * 1000 * k) / WORK_SR) * Math.pow(10, -12 / 20) * 32767);
      expect(pcm[a + k]).toBe(tone + 0);   // Int16Array has no -0
    }

    const pcmFile = path.join(dir, "m.pcm");
    await writePcm(pcmFile, pcm);
    const mp3 = path.join(dir, "r.mp3");
    await encodeMp3(pcmFile, mp3, "sr-test job_v1");
    const r = await probe(mp3);
    expect(r.channels).toBe(1);
    expect(r.sampleRate).toBe(44100);

    const hl = path.join(dir, "h.mp3");
    await cutClip(mp3, hl, { start_ms: 5_000, end_ms: 65_000 }, "sr-test job_v1");
    expect(Math.abs((await probe(hl)).durationMs - 60_000)).toBeLessThan(200);
  }, 60_000);
});
