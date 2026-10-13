// End-to-end eval on the planted test calls with the REAL vendors, no TR needed:
//   AssemblyAI pass 1 → rules + entities (+ OpenRouter labels if OPENROUTER_API_KEY)
//   → bleeps → redacted audio → AssemblyAI pass 2 → second-pass check
//   → redacted transcript → (OPENROUTER_API_KEY) smart clips + coaching, 3 runs for label stability
//   → second pass mapped onto every clip + the same checks on all coaching text
// and a leak report (SPEC v0.2 §7 CI target): every planted value's words under a bleep, none in the
// redacted transcript, 0 second-pass hits, clip labels from the fixed set and stable across reruns.
//   ASSEMBLYAI_API_KEY=… [OPENROUTER_API_KEY=…] npm run eval [-- 01-classic-sale …] [--reruns 3] [--skip-long]
// Writes fixtures/out/<name>.redacted.{mp3,txt}, <name>.clips/cN.mp3, <name>.{clips,coaching}.json and
// eval-report.json. Deletes its AssemblyAI transcripts at the end.
// The calls are synthetic; every value in them is fictional.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteTranscript, getTranscript, submitTranscript, type AaiTranscript } from "../lib/assemblyai";
import { cutClip, encodeMp3, renderRedacted, writePcm } from "../lib/audio";
import { bleepIntervals, dedupe, entitySpans, inAny, nameTerms, ruleSpans, termMatches, AAI_ENTITY_MAP } from "../lib/pii/detect";
import { tokenize } from "../lib/pii/spoken";
import { llmPiiSpans } from "../lib/pii/llm";
import { clipReasons, secondPassReasons, textPiiReasons } from "../lib/qa";
import { redactedLines, transcriptTxt } from "../lib/artifacts";
import { clipAndCoach, type Clip, type CallCoaching } from "../lib/labels";
import { CLIP_LABELS, CLIPS, MODELS, PIPELINE_VERSION, SCHEMA_VERSION } from "../lib/config";
import { fromAssemblyAi, norm } from "../lib/words";
import type { Planted } from "../fixtures/parse";

const OUT = path.join(import.meta.dirname, "..", "fixtures", "out");
const PAD = 250;
const CARRIERS = ["Mutual of Omaha"];
const STOP = new Set(["and", "the", "of", "a", "an", "is", "it's", "it", "my", "as", "in", "to", "at", "dot", "on", "or", "for", "that's"]);

async function upload(file: string): Promise<string> {
  const res = await fetch("https://api.assemblyai.com/v2/upload", {
    method: "POST",
    headers: { Authorization: process.env.ASSEMBLYAI_API_KEY!, "Content-Type": "application/octet-stream" },
    body: readFileSync(file),
  });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return ((await res.json()) as { upload_url: string }).upload_url;
}

async function transcribe(file: string, multichannel: boolean, keyterms: string[], ids: string[]): Promise<AaiTranscript> {
  const { id } = await submitTranscript({ audioUrl: await upload(file), multichannel, keyterms });
  ids.push(id);
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    const t = await getTranscript(id);
    if (t.status === "completed") return t;
    if (t.status === "error") throw new Error(`transcript error`);
  }
}

async function evalCall(name: string) {
  const meta = JSON.parse(readFileSync(path.join(OUT, `${name}.planted.json`), "utf8")) as {
    customer_channel: 0 | 1; agent: string; caller: string; planted: Planted[]; line_starts_ms: number[]; line_ends_ms: number[]; strict?: boolean;
    lines: { speaker: "agent" | "customer"; text: string }[];
  };
  const src = path.join(OUT, `${name}.mp3`);
  const ids: string[] = [];
  const dir = mkdtempSync(path.join(tmpdir(), "sr-eval-"));
  try {
    const terms = [...meta.agent.split(" "), ...meta.caller.split(" "), ...CARRIERS];
    const raw = await transcribe(src, true, terms, ids);
    const t = fromAssemblyAi(raw);
    const durationMs = (raw.audio_duration ?? 0) * 1000 || t.words[t.words.length - 1].end + 2000;

    const model = entitySpans(t.words, raw.entities ?? [], true);
    const llm = process.env.OPENROUTER_API_KEY
      ? await llmPiiSpans(t, { customerChannel: meta.customer_channel, redactHealth: true })
      : { spans: [], unmatched: 0, costUsd: 0, calls: 0, model: "(skipped)" };
    const names = [...new Set([...nameTerms(t.words, [...model, ...llm.spans]), ...terms])];
    const spans = dedupe([...ruleSpans(t, terms), ...model, ...llm.spans, ...termMatches(t.words, names, "PERSON_NAME", "model")]);
    const bleeps = bleepIntervals(spans, PAD, durationMs);

    // leak check: the planted value's words, found in the ASR output inside its line's time window
    const leaks: string[] = [];
    // a planted word is shown in the redacted transcript iff no span of its own covers it and its midpoint is not
    // under a bleep (the rule artifacts.redactedLines applies): checked per word, at its position
    const transcriptLeaks: string[] = [];
    const ownSpan = (i: number, ch: 0 | 1) => spans.some((sp) => sp.channel === ch && i >= sp.from && i <= sp.to);
    for (const p of meta.planted) {
      const line = meta.lines[p.line];
      const ch = line.speaker === "customer" ? meta.customer_channel : (1 - meta.customer_channel) as 0 | 1;
      const lo = meta.line_starts_ms[p.line] - 300;
      const hi = (meta.line_ends_ms?.[p.line] ?? meta.line_starts_ms[p.line + 1] ?? durationMs) + 300;   // overlapping lines (06)
      const plantedTokens = new Set(p.text.split(/\s+/).map(norm).filter((w) => w.length >= 2 && !STOP.has(w)));
      const plantedDigits = tokenize(p.text.split(/\s+/).map((text, i) => ({ i, text, start: i * 300, end: i * 300 + 280, conf: 1, ch: 0 as const })))
        .map((x) => x.digits).join("");
      for (const w of t.words) {
        if (w.ch !== ch || w.start < lo || w.end > hi) continue;
        const n = norm(w.text).replace(/[^\p{L}\p{N}]/gu, "");
        const d = w.text.replace(/\D/g, "");
        const isPlanted = plantedTokens.has(norm(w.text)) || (d.length >= 2 && plantedDigits.includes(d)) || (n.length >= 3 && [...plantedTokens].some((x) => x.replace(/[^\p{L}\p{N}]/gu, "") === n));
        if (isPlanted && !inAny((w.start + w.end) / 2, bleeps)) leaks.push(`${p.kind}:"${w.text}"@${w.start}ms`);
        if (isPlanted && !ownSpan(w.i, w.ch) && !inAny((w.start + w.end) / 2, bleeps)) transcriptLeaks.push(`${p.kind}:"${w.text}"@${w.start}ms`);
      }
    }

    // render (SPEC v0.2 default: no pitch shift) + second pass
    const { pcm, engine } = await renderRedacted(src, dir, bleeps, { customerChannel: meta.customer_channel, pitch: false });
    const pcmFile = path.join(dir, "m.pcm");
    await writePcm(pcmFile, pcm);
    const redacted = path.join(OUT, `${name}.redacted.mp3`);
    await encodeMp3(pcmFile, redacted, "eval");
    const raw2 = await transcribe(redacted, false, [], ids);
    const second = secondPassReasons(fromAssemblyAi(raw2, 0), bleeps, names, raw2.entities ?? [], new Set(Object.keys(AAI_ENTITY_MAP)));

    // redacted transcript (planted words checked per position above)
    const lines = redactedLines(t, spans, bleeps, meta.customer_channel, PAD, durationMs);
    writeFileSync(path.join(OUT, `${name}.redacted.txt`), transcriptTxt(lines, `# eval ${name} · ${PIPELINE_VERSION}`));

    // strict calls (10, 11): words outside every planted line that ended up under a bleep (over-redaction; reported, not failed)
    let overBleeped = 0;
    if (meta.strict) {
      const plantedLines = new Set(meta.planted.map((p) => p.line));
      for (const w of t.words) {
        const k = meta.line_starts_ms.findIndex((st, n) => w.start >= st - 300 && w.end <= (meta.line_ends_ms?.[n] ?? st) + 300);
        if (k >= 0 && !plantedLines.has(k) && inAny((w.start + w.end) / 2, bleeps)) overBleeped++;
      }
    }

    // smart clips + coaching on the redacted transcript (the only LLM input in production), RERUNS times
    let clipsReport: Record<string, unknown> = { skipped: true };
    let clipFail = false;
    if (process.env.OPENROUTER_API_KEY && lines.length) {
      const runs: { ok: boolean; labels: string; clips: Clip[]; coaching: CallCoaching | null; cost: number; error?: string }[] = [];
      for (let k = 0; k < RERUNS; k++) {
        try {
          const r = await clipAndCoach(lines, bleeps, durationMs);
          runs.push(r.ok
            ? { ok: true, labels: r.clips.map((c) => c.label + (c.sub_label ? `:${c.sub_label}` : "")).join(","), clips: r.clips, coaching: r.coaching, cost: r.costUsd }
            : { ok: false, labels: "", clips: [], coaching: null, cost: r.costUsd, error: r.error.slice(0, 200) });
        } catch (e) {
          runs.push({ ok: false, labels: "", clips: [], coaching: null, cost: 0, error: e instanceof Error ? e.message.slice(0, 200) : "unknown" });
        }
      }
      const first = runs.find((r) => r.ok);
      const clipDir = path.join(OUT, `${name}.clips`);
      mkdirSync(clipDir, { recursive: true });
      for (const c of first?.clips ?? []) if (c.audio_exported) await cutClip(redacted, path.join(clipDir, `${c.clip_id}.mp3`), c, "eval");
      writeFileSync(path.join(OUT, `${name}.clips.json`), JSON.stringify({ schema_version: SCHEMA_VERSION, pipeline_version: PIPELINE_VERSION, items: first?.clips ?? [] }, null, 1));
      writeFileSync(path.join(OUT, `${name}.coaching.json`), JSON.stringify({ schema_version: SCHEMA_VERSION, pipeline_version: PIPELINE_VERSION, items: first?.coaching ?? null }, null, 1));
      const texts: { where: string; text: string }[] = [];
      for (const r of runs.filter((x) => x.ok)) {
        if (r.coaching) [r.coaching.summary, ...r.coaching.strengths, ...r.coaching.improvements].forEach((text, n) => texts.push({ where: `call.${n}`, text }));
        for (const c of r.clips) [c.title, c.coaching.did, c.coaching.worked, c.coaching.improve, ...c.coaching.key_lines].forEach((text, n) => texts.push({ where: `${c.clip_id}.${n}`, text }));
      }
      const labelSet = new Set(runs.filter((r) => r.ok).map((r) => r.labels));
      const labelsOk = runs.every((r) => r.ok) && runs.every((r) => r.clips.every((c) => (CLIP_LABELS as readonly string[]).includes(c.label))) 
        // a call shorter than the minimum clip length (04: 18 s) can have no clip; any longer call must have one
        && ((first?.clips.length ?? 0) > 0 || durationMs < CLIPS.minS * 1000);
      const coachingPii = textPiiReasons(texts, names);
      const clipHits = clipReasons(second, first?.clips ?? []);
      clipFail = !labelsOk || labelSet.size > 1 || coachingPii.length > 0;
      clipsReport = {
        runs: runs.length,
        valid_runs: runs.filter((r) => r.ok).length,
        errors: runs.filter((r) => !r.ok).map((r) => r.error),
        clips: first?.clips.length ?? 0,
        exported: first?.clips.filter((c) => c.audio_exported).length ?? 0,
        labels: first?.labels ?? "",
        labels_ok: labelsOk,
        stable_across_runs: labelSet.size <= 1,
        label_variants: [...labelSet],
        coaching_pii: coachingPii,
        clip_second_pass: clipHits,
        cost_usd: Math.round(runs.reduce((n, r) => n + r.cost, 0) * 10000) / 10000,
      };
    }

    const report = {
      call: name,
      words: t.words.length,
      spans: spans.length,
      bleeped_ms: bleeps.reduce((s, b) => s + b.end_ms - b.start_ms, 0),
      bleeped_share: Math.round((bleeps.reduce((s, b) => s + b.end_ms - b.start_ms, 0) / durationMs) * 1000) / 10 + "%",
      duration_min: Math.round(durationMs / 6000) / 10,
      planted: meta.planted.length,
      leaks,
      transcript_leaks: [...new Set(transcriptLeaks)],
      second_pass: second,
      over_bleeped_words: meta.strict ? overBleeped : null,
      clips: clipsReport,
      clip_fail: clipFail,
      llm: { calls: llm.calls, unmatched: llm.unmatched, cost_usd: Math.round(llm.costUsd * 10000) / 10000, model: llm.model },
      pitch: engine,
    };
    console.log(JSON.stringify(report, null, 1));
    return report;
  } finally {
    rmSync(dir, { recursive: true, force: true });
    for (const id of ids) await deleteTranscript(id);
  }
}

if (!process.env.ASSEMBLYAI_API_KEY) {
  console.error("set ASSEMBLYAI_API_KEY (and optionally OPENROUTER_API_KEY)");
  process.exit(2);
}
const argv = process.argv.slice(2);
const flag = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv.splice(i, 2)[1] : undefined; };
const RERUNS = Math.max(1, Math.min(5, Number(flag("--reruns") ?? process.env.EVAL_RERUNS ?? 3) || 3));
const skipLong = argv.includes("--skip-long");
const only = argv.filter((a) => !a.startsWith("--"));
type Report = Awaited<ReturnType<typeof evalCall>>;
const names = readdirSync(OUT).filter((f) => /^\d\d-.*\.planted\.json$/.test(f)).map((f) => f.replace(".planted.json", "")).sort()
  .filter((n) => !only.length || only.includes(n)).filter((n) => !(skipLong && n.includes("long-call")));
let failed = 0;
const reports: (Report | { call: string; error: string })[] = [];
for (const n of names) {
  if (!existsSync(path.join(OUT, `${n}.mp3`))) { console.error(`missing ${n}.mp3 — run npm run make-test-calls`); process.exit(2); }
  try {
    const r = await evalCall(n);
    reports.push(r);
    if (r.leaks.length || r.transcript_leaks.length || r.second_pass.length || r.clip_fail) failed++;
  } catch (e) {
    // error messages carry codes and statuses only, never transcript text
    const error = e instanceof Error ? e.message.slice(0, 200) : "unknown";
    console.log(JSON.stringify({ call: n, error }));
    reports.push({ call: n, error });
    failed++;
  }
}
const summary = `${new Date().toISOString()} ${PIPELINE_VERSION} asr=${MODELS.asr} llm=${process.env.OPENROUTER_API_KEY ? MODELS.llm : "(skipped)"} · ${names.length} calls, ${failed} failed (leak, transcript leak, second-pass hit, invalid/unstable labels, PII in coaching, or crash) · reruns ${RERUNS}`;
writeFileSync(path.join(OUT, "eval-report.json"), JSON.stringify({ summary, reports }, null, 1));
writeFileSync(path.join(OUT, "eval-summary.txt"), summary + "\n");
console.log(`\n${summary}`);
console.log(failed ? `${failed} call(s) failed — do not ship` : "no leaks");
process.exit(failed ? 1 : 0);
