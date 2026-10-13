// End-to-end eval on the planted test calls with the REAL vendors, no TR needed:
//   AssemblyAI pass 1 → rules + entities (+ OpenRouter labels if OPENROUTER_API_KEY)
//   → bleeps → redacted audio → AssemblyAI pass 2 → second-pass check
//   → redacted transcript (+ OpenRouter labels/coaching on it if OPENROUTER_API_KEY)
// and a leak report: every planted value's words must sit under a bleep, and none
// may appear in the redacted transcript.
//   ASSEMBLYAI_API_KEY=… [OPENROUTER_API_KEY=…] npm run eval [-- 01-classic-sale]
// Writes fixtures/out/<name>.redacted.{mp3,txt} (+ .labels.json/.coaching.json) and eval-report.json. Deletes its AssemblyAI transcripts at the end.
// The calls are synthetic; every value in them is fictional.
import { readFileSync, existsSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteTranscript, getTranscript, submitTranscript, type AaiTranscript } from "../lib/assemblyai";
import { encodeMp3, renderRedacted, writePcm } from "../lib/audio";
import { bleepIntervals, dedupe, entitySpans, inAny, nameTerms, ruleSpans, termMatches, AAI_ENTITY_MAP } from "../lib/pii/detect";
import { tokenize } from "../lib/pii/spoken";
import { llmPiiSpans } from "../lib/pii/llm";
import { secondPassReasons } from "../lib/qa";
import { redactedLines, transcriptTxt } from "../lib/artifacts";
import { labelCall } from "../lib/labels";
import { CLIP_LABELS, MODELS, PIPELINE_VERSION } from "../lib/config";
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
    customer_channel: 0 | 1; agent: string; caller: string; planted: Planted[]; line_starts_ms: number[];
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
    for (const p of meta.planted) {
      const line = meta.lines[p.line];
      const ch = line.speaker === "customer" ? meta.customer_channel : (1 - meta.customer_channel) as 0 | 1;
      const lo = meta.line_starts_ms[p.line] - 300;
      const hi = (meta.line_starts_ms[p.line + 1] ?? durationMs) + 300;
      const plantedTokens = new Set(p.text.split(/\s+/).map(norm).filter((w) => w.length >= 2 && !STOP.has(w)));
      const plantedDigits = tokenize(p.text.split(/\s+/).map((text, i) => ({ i, text, start: i * 300, end: i * 300 + 280, conf: 1, ch: 0 as const })))
        .map((x) => x.digits).join("");
      for (const w of t.words) {
        if (w.ch !== ch || w.start < lo || w.end > hi) continue;
        const n = norm(w.text).replace(/[^\p{L}\p{N}]/gu, "");
        const d = w.text.replace(/\D/g, "");
        const isPlanted = plantedTokens.has(norm(w.text)) || (d.length >= 2 && plantedDigits.includes(d)) || (n.length >= 3 && [...plantedTokens].some((x) => x.replace(/[^\p{L}\p{N}]/gu, "") === n));
        if (isPlanted && !inAny((w.start + w.end) / 2, bleeps)) leaks.push(`${p.kind}:"${w.text}"@${w.start}ms`);
      }
    }

    // render + second pass
    const { pcm, engine } = await renderRedacted(src, dir, bleeps, { customerChannel: meta.customer_channel, pitch: true });
    const pcmFile = path.join(dir, "m.pcm");
    await writePcm(pcmFile, pcm);
    const redacted = path.join(OUT, `${name}.redacted.mp3`);
    await encodeMp3(pcmFile, redacted, "eval");
    const raw2 = await transcribe(redacted, false, [], ids);
    const second = secondPassReasons(fromAssemblyAi(raw2, 0), bleeps, names, raw2.entities ?? [], new Set(Object.keys(AAI_ENTITY_MAP)));

    // redacted transcript: no planted token may survive as text
    const lines = redactedLines(t, spans, bleeps, meta.customer_channel, PAD, durationMs);
    writeFileSync(path.join(OUT, `${name}.redacted.txt`), transcriptTxt(lines, `# eval ${name} · ${PIPELINE_VERSION}`));
    const transcriptLeaks: string[] = [];
    const redactedWords = new Set(lines.flatMap((l) => l.text.split(/\s+/)).map(norm).filter((x) => !x.startsWith("[redacted")));
    for (const p of meta.planted) {
      for (const tok of p.text.split(/\s+/).map(norm)) {
        if (tok.length >= 3 && !STOP.has(tok) && redactedWords.has(tok)) transcriptLeaks.push(`${p.kind}:"${tok}"`);
      }
    }

    // labels + coaching on the redacted transcript (the only LLM input in production)
    let labels: { segments: number; labels_ok: boolean; highlight_ms: number; cost_usd: number } | { skipped: true } | { error: string } = { skipped: true };
    if (process.env.OPENROUTER_API_KEY && lines.length) {
      try {
        const r = await labelCall(lines, 300);
        writeFileSync(path.join(OUT, `${name}.labels.json`), JSON.stringify({ pipeline_version: PIPELINE_VERSION, segments: r.segments, highlight: r.highlight }, null, 1));
        writeFileSync(path.join(OUT, `${name}.coaching.json`), JSON.stringify({ pipeline_version: PIPELINE_VERSION, ...r.coaching }, null, 1));
        labels = {
          segments: r.segments.length,
          labels_ok: r.segments.length > 0 && r.segments.every((x) => (CLIP_LABELS as readonly string[]).includes(x.label)),
          highlight_ms: r.highlight.end_ms - r.highlight.start_ms,
          cost_usd: Math.round(r.costUsd * 10000) / 10000,
        };
      } catch (e) {
        labels = { error: e instanceof Error ? e.message.slice(0, 200) : "unknown" };
      }
    }

    const report = {
      call: name,
      words: t.words.length,
      spans: spans.length,
      bleeped_ms: bleeps.reduce((s, b) => s + b.end_ms - b.start_ms, 0),
      bleeped_share: Math.round((bleeps.reduce((s, b) => s + b.end_ms - b.start_ms, 0) / durationMs) * 1000) / 10 + "%",
      planted: meta.planted.length,
      leaks,
      transcript_leaks: [...new Set(transcriptLeaks)],
      second_pass: second,
      labels,
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
const only = process.argv.slice(2);
type Report = Awaited<ReturnType<typeof evalCall>>;
const names = ["01-classic-sale", "02-readback-and-spelling", "03-ids-and-boxes", "04-no-pii-control"].filter((n) => !only.length || only.includes(n));
let failed = 0;
const reports: (Report | { call: string; error: string })[] = [];
for (const n of names) {
  if (!existsSync(path.join(OUT, `${n}.mp3`))) { console.error(`missing ${n}.mp3 — run npm run make-test-calls`); process.exit(2); }
  try {
    const r = await evalCall(n);
    reports.push(r);
    const labelsBad = "error" in r.labels || ("labels_ok" in r.labels && !r.labels.labels_ok);
    if (r.leaks.length || r.transcript_leaks.length || r.second_pass.length || labelsBad) failed++;
  } catch (e) {
    // error messages carry codes and statuses only, never transcript text
    const error = e instanceof Error ? e.message.slice(0, 200) : "unknown";
    console.log(JSON.stringify({ call: n, error }));
    reports.push({ call: n, error });
    failed++;
  }
}
const summary = `${new Date().toISOString()} ${PIPELINE_VERSION} asr=${MODELS.asr} llm=${process.env.OPENROUTER_API_KEY ? MODELS.llm : "(skipped)"} · ${names.length} calls, ${failed} failed (leak, transcript leak, second-pass hit, label error or crash)`;
writeFileSync(path.join(OUT, "eval-report.json"), JSON.stringify({ summary, reports }, null, 1));
writeFileSync(path.join(OUT, "eval-summary.txt"), summary + "\n");
console.log(`\n${summary}`);
console.log(failed ? `${failed} call(s) failed — do not ship` : "no leaks");
process.exit(failed ? 1 : 0);
