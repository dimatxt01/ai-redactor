// Steps of the redaction workflow. Each step does its own I/O (bridge, vendors,
// ffmpeg) and passes ONLY non-PII values onward: ids, counts, hashes, millisecond
// offsets, detector/type names. Transcripts and names live in TR's private
// sample-work bucket between steps and in local /tmp inside one step (removed in
// `finally`), so the workflow event log never holds personal data.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { FatalError, getStepMetadata } from "workflow";
import { deleteTranscript, getTranscript, submitTranscript, type AaiEntity } from "@/lib/assemblyai";
import { bridge, getWork, getWorkJson, putWork, signUrls, uploadSigned, downloadSigned, type JobInputs, type JobOptions } from "@/lib/bridge";
import { cutHighlight, encodeMp3, probe, renderRedacted, writePcm, type PitchEngine } from "@/lib/audio";
import { envelope, redactedLines, sha256, spansJson, transcriptJson, transcriptTxt, versionTag } from "@/lib/artifacts";
import { LIMITS, MODELS, PIPELINE_VERSION } from "@/lib/config";
import { asrCostUsd, charge, guard, LLM_RESERVE } from "@/lib/cost";
import { jobError } from "@/lib/errors";
import { labelCall, snapHighlight, type RedactedLine } from "@/lib/labels";
import { log } from "@/lib/log";
import {
  AAI_ENTITY_MAP, bleepIntervals, dedupe, entitySpans, nameTerms, ruleSpans, termMatches, totalMs, type Interval, type Span,
} from "@/lib/pii/detect";
import { llmPiiSpans } from "@/lib/pii/llm";
import { avgConfidence, crosstalk, firstPassReasons, secondPassReasons } from "@/lib/qa";
import { fromAssemblyAi, type Transcript } from "@/lib/words";

export type Ctx = {
  jobId: string;
  runId: string;
  callId: string;
  version: number;
  options: Omit<JobOptions, "extra_terms">;
  durationS: number;
  channelMapVerified: boolean;
  jobCapUsd: number;
  asrUsdPerHour: number;
};

export type Source = { durationMs: number; channels: number; sampleRate: number; bitrateKbps: number | null; lengthOk: boolean };

type Pass1 = { transcript: Transcript; entities: AaiEntity[] };
type SpansFile = { spans: Span[]; bleeps: Interval[] };
type NamesFile = { names: string[] };

async function scratch(jobId: string): Promise<string> {
  const dir = path.join(tmpdir(), `sr-${jobId}-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function inputs(ctx: Ctx): Promise<JobInputs> {
  return bridge<JobInputs>("job", { job_id: ctx.jobId });
}

// ── 1. claim ────────────────────────────────────────────────────────────────
export async function claimJob(jobId: string, runId: string): Promise<{ duplicate: true } | { duplicate: false; ctx: Ctx }> {
  "use step";
  const inp = await bridge<JobInputs>("job", { job_id: jobId });
  try {
    await bridge("claim", { job_id: jobId, run_id: runId });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("DUPLICATE_RUN")) {
      log("job_duplicate_run", { job_id: jobId, run_id: runId });
      return { duplicate: true };
    }
    throw e;
  }
  const { extra_terms: _drop, ...options } = inp.job.options;
  log("job_claimed", { job_id: jobId, run_id: runId, version: inp.job.version, duration_s: inp.job.call_meta.duration_s });
  return {
    duplicate: false,
    ctx: {
      jobId,
      runId,
      callId: inp.job.call_id,
      version: inp.job.version,
      options: { ...options, customer_channel: inp.job.call_meta.channel_map?.customer ?? options.customer_channel ?? 0 },
      durationS: Number(inp.job.call_meta.duration_s) || 0,
      channelMapVerified: inp.job.call_meta.channel_map?.verified === true,
      jobCapUsd: inp.caps.job_usd,
      asrUsdPerHour: inp.caps.asr_usd_per_hour,
    },
  };
}

export async function setStatus(ctx: Ctx, status: "transcribing" | "redacting" | "verifying", engine?: Record<string, string>) {
  "use step";
  await bridge("status", { job_id: ctx.jobId, run_id: ctx.runId, status, ...(engine ? { engine } : {}) });
}

// ── 2. fetch ────────────────────────────────────────────────────────────────
export async function fetchSource(ctx: Ctx): Promise<Source> {
  "use step";
  const dir = await scratch(ctx.jobId);
  try {
    // A fresh Telnyx link every attempt (they expire in ~10 min); downloaded at once, never stored.
    const { url } = await bridge<{ url: string }>("source", { job_id: ctx.jobId, run_id: ctx.runId });
    const res = await fetch(url, { signal: AbortSignal.timeout(300_000) });
    if (res.status === 403 || res.status === 404) throw jobError("fetch_expired", `recording download ${res.status}`);
    if (!res.ok) throw new Error(`recording download ${res.status}`);
    const file = path.join(dir, "source.mp3");
    await writeFile(file, Buffer.from(await res.arrayBuffer()));

    let p;
    try { p = await probe(file); } catch { throw jobError("bad_audio", "not a readable audio file"); }
    if (p.channels !== 2) throw jobError("bad_audio", `expected 2 channels (one per leg), got ${p.channels}`);
    if (p.durationMs > LIMITS.maxCallSeconds * 1000 * (1 + LIMITS.durationTolerance)) {
      throw jobError("bad_audio", `recording is ${Math.round(p.durationMs / 60000)} min; limit is 60`);
    }
    const expected = ctx.durationS * 1000;
    const lengthOk = expected > 0 && Math.abs(p.durationMs - expected) <= expected * LIMITS.durationTolerance;

    await putWork(ctx.jobId, ctx.runId, "source.mp3", await readFile(file), "audio/mpeg");
    log("source_fetched", { job_id: ctx.jobId, duration_ms: p.durationMs, channels: p.channels, sample_rate: p.sampleRate, bitrate_kbps: p.bitrateKbps, length_ok: lengthOk });
    return { durationMs: p.durationMs, channels: p.channels, sampleRate: p.sampleRate, bitrateKbps: p.bitrateKbps, lengthOk };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 3. ASR (both passes) ────────────────────────────────────────────────────
export async function submitAsr(ctx: Ctx, pass: "pass1" | "pass2", webhookUrl: string, durationMs: number): Promise<{ id: string }> {
  "use step";
  const inp = await inputs(ctx);
  const channels = pass === "pass1" ? 2 : 1;
  const est = asrCostUsd(durationMs, channels, ctx.asrUsdPerHour);
  guard(inp.caps.spent_usd, est, ctx.jobCapUsd, `ASR ${pass}`);

  const urls = await signUrls(ctx.jobId, ctx.runId, [
    pass === "pass1"
      ? { target: "work", name: "source.mp3", mode: "download" }
      : { target: "library", name: "redacted.mp3", mode: "download" },
  ]);
  const audioUrl = Object.values(urls)[0];
  const { id } = await submitTranscript({
    audioUrl,
    multichannel: pass === "pass1",
    webhookUrl,
    // pass 1: names TR knows, so the model spells them the way the name pass looks for them
    keyterms: pass === "pass1" ? inp.extra_terms.filter((t) => t.split(/\s+/).length <= 6) : [],
  });
  try {
    await bridge("asr", { job_id: ctx.jobId, run_id: ctx.runId, transcript_id: id });
    await charge(ctx.jobId, ctx.runId, `asr:${pass}`, est);
  } catch (e) {
    // this attempt's transcript would be orphaned (a retry submits a new one; a fatal error never returns the id)
    await deleteTranscript(id);
    throw e;
  }
  log("asr_submitted", { job_id: ctx.jobId, pass, transcript_id: id, channels });
  return { id };
}

export async function asrStatus(id: string): Promise<"queued" | "processing" | "completed" | "error"> {
  "use step";
  const t = await getTranscript(id);
  return t.status;
}

export async function savePass1(ctx: Ctx, id: string): Promise<{ words: number; avgConf: number; crosstalk: number }> {
  "use step";
  const raw = await getTranscript(id);
  if (raw.status !== "completed") throw jobError("asr_failed", `pass1 status ${raw.status}`);
  const transcript = fromAssemblyAi(raw);
  if (!transcript.words.length) throw jobError("asr_failed", "pass1 returned no words");
  const file: Pass1 = { transcript, entities: (raw.entities ?? []).map(({ entity_type, start, end, text }) => ({ entity_type, start, end, text })) };
  await putWork(ctx.jobId, ctx.runId, "asr-pass1.json", JSON.stringify(file), "application/json");
  const r = { words: transcript.words.length, avgConf: round(avgConfidence(transcript.words)), crosstalk: round(crosstalk(transcript.words)) };
  log("asr_pass1_saved", { job_id: ctx.jobId, ...r });
  return r;
}

// ── 4. detect ───────────────────────────────────────────────────────────────
export async function detectPii(ctx: Ctx, src: Source, pass1: { avgConf: number; crosstalk: number }) {
  "use step";
  const attempt = getStepMetadata().attempt;
  const inp = await inputs(ctx);
  const { transcript: t, entities } = await getWorkJson<Pass1>(ctx.jobId, ctx.runId, "asr-pass1.json");

  const rules = ruleSpans(t, inp.extra_terms);
  const model = entitySpans(t.words, entities, ctx.options.redact_health);

  const chunks = Math.max(1, Math.ceil(t.words.length / 2500));
  guard(inp.caps.spent_usd, chunks * LLM_RESERVE, ctx.jobCapUsd, "LLM entity labels");
  let n = 0;
  const llm = await llmPiiSpans(t, {
    customerChannel: ctx.options.customer_channel,
    redactHealth: ctx.options.redact_health,
    onCost: async (usd) => { await charge(ctx.jobId, ctx.runId, `llm:pii:a${attempt}:${n++}`, usd); },
  });

  // Every name any detector found (plus TR's names) is bleeped wherever it is said.
  const names = [...new Set([...nameTerms(t.words, [...model, ...llm.spans]), ...inp.extra_terms])];
  const nameSpans = termMatches(t.words, names, "PERSON_NAME", "model");
  const spans = dedupe([...rules, ...model, ...llm.spans, ...nameSpans]);
  const bleeps = bleepIntervals(spans, ctx.options.bleep_pad_ms, src.durationMs);

  await putWork(ctx.jobId, ctx.runId, "spans.json", JSON.stringify({ spans, bleeps } satisfies SpansFile), "application/json");
  await putWork(ctx.jobId, ctx.runId, "names.json", JSON.stringify({ names } satisfies NamesFile), "application/json");

  const reasons = firstPassReasons({
    avgConf: pass1.avgConf,
    spans,
    crosstalk: pass1.crosstalk,
    lengthOk: src.lengthOk,
    llmUnmatched: llm.unmatched,
    channelMapVerified: ctx.channelMapVerified,
  });
  const out = {
    spanCount: spans.length,
    bleepedMs: totalMs(bleeps),
    byDetector: countBy(spans, (s) => s.detector),
    byType: countBy(spans, (s) => s.type),
    llmCalls: llm.calls,
    llmModel: llm.model || MODELS.llm,
    reasons,
  };
  log("pii_detected", { job_id: ctx.jobId, spans: out.spanCount, bleeped_ms: out.bleepedMs, llm_calls: llm.calls, llm_unmatched: llm.unmatched, reasons: reasons.length });
  return out;
}

// ── 5. audio ────────────────────────────────────────────────────────────────
export async function renderAudio(ctx: Ctx, src: Source): Promise<{ sha256: string; bytes: number; pitchEngine: PitchEngine }> {
  "use step";
  const dir = await scratch(ctx.jobId);
  try {
    const source = path.join(dir, "source.mp3"), pcm = path.join(dir, "mono.pcm"), out = path.join(dir, "redacted.mp3");
    await writeFile(source, await getWork(ctx.jobId, ctx.runId, "source.mp3"));
    const { bleeps } = await getWorkJson<SpansFile>(ctx.jobId, ctx.runId, "spans.json");

    // PII silenced on both legs on the source timeline first; pitch shift and tone after (lib/audio.ts)
    const { pcm: samples, engine: pitchEngine } = await renderRedacted(source, dir, bleeps, {
      customerChannel: ctx.options.customer_channel,
      pitch: ctx.options.pitch_shift_customer,
    });
    await writePcm(pcm, samples);
    await encodeMp3(pcm, out, versionTag(ctx.version));

    const bytes = await readFile(out);
    const urls = await signUrls(ctx.jobId, ctx.runId, [{ target: "library", name: "redacted.mp3", mode: "upload" }]);
    await uploadSigned(urls["library:redacted.mp3:upload"], bytes, "audio/mpeg");
    log("audio_rendered", { job_id: ctx.jobId, bytes: bytes.length, pitch: pitchEngine, bleeps: bleeps.length });
    return { sha256: sha256(bytes), bytes: bytes.length, pitchEngine };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ── 6. transcript artifacts ─────────────────────────────────────────────────
export async function writeTranscriptArtifacts(ctx: Ctx, src: Source) {
  "use step";
  const { transcript: t } = await getWorkJson<Pass1>(ctx.jobId, ctx.runId, "asr-pass1.json");
  const { spans, bleeps } = await getWorkJson<SpansFile>(ctx.jobId, ctx.runId, "spans.json");
  const lines = redactedLines(t, spans, bleeps, ctx.options.customer_channel, ctx.options.bleep_pad_ms, src.durationMs);

  const tj = JSON.stringify(envelope("tr.sample.transcript", ctx.version, ctx.callId, transcriptJson(lines, ctx.options.customer_channel)), null, 1);
  const tt = transcriptTxt(lines, `# TrueRing redacted transcript · call ${ctx.callId} · job v${ctx.version} · ${PIPELINE_VERSION}`);
  const sj = JSON.stringify(envelope("tr.sample.pii_spans", ctx.version, ctx.callId, { spans: spansJson(spans, ctx.options.bleep_pad_ms, src.durationMs), bleeps }), null, 1);

  const urls = await signUrls(ctx.jobId, ctx.runId, [
    { target: "library", name: "transcript.json", mode: "upload" },
    { target: "library", name: "transcript.txt", mode: "upload" },
    { target: "library", name: "pii_spans.json", mode: "upload" },
  ]);
  await uploadSigned(urls["library:transcript.json:upload"], tj, "application/json");
  await uploadSigned(urls["library:transcript.txt:upload"], tt, "text/plain");
  await uploadSigned(urls["library:pii_spans.json:upload"], sj, "application/json");
  // already redacted: the labelling step reads this, never the raw transcript
  await putWork(ctx.jobId, ctx.runId, "redacted-lines.json", JSON.stringify(lines), "application/json");
  return {
    transcript_json: { name: "transcript.json", sha256: sha256(tj) },
    transcript_txt: { name: "transcript.txt", sha256: sha256(tt) },
    pii_spans_json: { name: "pii_spans.json", sha256: sha256(sj) },
  };
}

// ── 7. labels, coaching, highlight ──────────────────────────────────────────
export async function labelAndHighlight(ctx: Ctx, src: Source) {
  "use step";
  const attempt = getStepMetadata().attempt;
  const inp = await inputs(ctx);
  const lines = await getWorkJson<RedactedLine[]>(ctx.jobId, ctx.runId, "redacted-lines.json");
  const { bleeps } = await getWorkJson<SpansFile>(ctx.jobId, ctx.runId, "spans.json");
  if (!lines.length) throw jobError("asr_failed", "no utterances to label");

  guard(inp.caps.spent_usd, LLM_RESERVE, ctx.jobCapUsd, "LLM labels/coaching");
  const r = await labelCall(lines, ctx.options.highlight.target_s, async (usd) => {
    await charge(ctx.jobId, ctx.runId, `llm:labels:a${attempt}`, usd);
  });

  const hl = ctx.options.highlight.enabled ? snapHighlight(r.highlight, bleeps, src.durationMs) : null;
  const lj = JSON.stringify(envelope("tr.sample.labels", ctx.version, ctx.callId, { segments: r.segments, highlight: hl }), null, 1);
  const cj = JSON.stringify(envelope("tr.sample.coaching", ctx.version, ctx.callId, r.coaching), null, 1);
  const urls = await signUrls(ctx.jobId, ctx.runId, [
    { target: "library", name: "labels.json", mode: "upload" },
    { target: "library", name: "coaching.json", mode: "upload" },
    ...(hl ? [{ target: "library" as const, name: "redacted.mp3", mode: "download" as const }, { target: "library" as const, name: "highlight.mp3", mode: "upload" as const }] : []),
  ]);
  await uploadSigned(urls["library:labels.json:upload"], lj, "application/json");
  await uploadSigned(urls["library:coaching.json:upload"], cj, "application/json");

  let highlight: { name: string; sha256: string; start_ms: number; end_ms: number } | null = null;
  if (hl) {
    const dir = await scratch(ctx.jobId);
    try {
      const inFile = path.join(dir, "redacted.mp3"), outFile = path.join(dir, "highlight.mp3");
      await writeFile(inFile, await downloadSigned(urls["library:redacted.mp3:download"]));
      await cutHighlight(inFile, outFile, hl, versionTag(ctx.version));
      const bytes = await readFile(outFile);
      await uploadSigned(urls["library:highlight.mp3:upload"], bytes, "audio/mpeg");
      highlight = { name: "highlight.mp3", sha256: sha256(bytes), start_ms: hl.start_ms, end_ms: hl.end_ms };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  log("labelled", { job_id: ctx.jobId, segments: r.segments.length, highlight: !!highlight });
  return {
    labels_json: { name: "labels.json", sha256: sha256(lj) },
    coaching_json: { name: "coaching.json", sha256: sha256(cj) },
    highlight_audio: highlight,
    llmModel: r.model,
    highlightReason: ctx.options.highlight.enabled && !hl ? "highlight_no_valid_window" : null,
  };
}

// ── 8. verify ───────────────────────────────────────────────────────────────
const PII_ENTITY_TYPES = new Set(Object.keys(AAI_ENTITY_MAP));

export async function verifySecondPass(ctx: Ctx, id: string): Promise<string[]> {
  "use step";
  const raw = await getTranscript(id);
  if (raw.status !== "completed") throw jobError("asr_failed", `pass2 status ${raw.status}`);
  const t2 = fromAssemblyAi(raw, 0);
  const { names } = await getWorkJson<NamesFile>(ctx.jobId, ctx.runId, "names.json");
  const { bleeps } = await getWorkJson<SpansFile>(ctx.jobId, ctx.runId, "spans.json");
  const types = ctx.options.redact_health
    ? PII_ENTITY_TYPES
    : new Set([...PII_ENTITY_TYPES].filter((k) => !String(AAI_ENTITY_MAP[k]).endsWith("_OPT")));
  const reasons = secondPassReasons(t2, bleeps, names, raw.entities ?? [], types);
  log("second_pass", { job_id: ctx.jobId, words: t2.words.length, hits: reasons.length });
  return reasons;
}

// ── 9. finish ───────────────────────────────────────────────────────────────
export async function completeJob(ctx: Ctx, payload: {
  artifacts: Record<string, unknown>;
  qaReasons: string[];
  metrics: Record<string, unknown>;
  engine: Record<string, string>;
}) {
  "use step";
  const artifacts = Object.fromEntries(Object.entries(payload.artifacts).filter(([, v]) => v));
  await bridge("complete", {
    job_id: ctx.jobId,
    run_id: ctx.runId,
    pipeline_version: PIPELINE_VERSION,
    qa_flag: payload.qaReasons.length > 0,
    qa_reasons: payload.qaReasons,
    metrics: payload.metrics,
    engine: payload.engine,
    artifacts,
  });
  log("job_done", { job_id: ctx.jobId, qa_flag: payload.qaReasons.length > 0, reasons: payload.qaReasons.length });
}

/**
 * Cleanup for jobs that ended badly or were taken down: TR's bridge removes scratch
 * (and artifacts of failed/deleted jobs) and returns every vendor transcript id
 * ever recorded for the job, which are then deleted. Never throws.
 */
export async function purgeJobs(jobIds: string[]): Promise<{ jobs: number; transcripts: number; failed: number }> {
  "use step";
  let transcripts = 0, failed = 0;
  for (const jobId of jobIds) {
    try {
      const r = await bridge<{ asr_transcript_ids: string[] }>("purge", { job_id: jobId });
      for (const id of r.asr_transcript_ids ?? []) {
        if (await deleteTranscript(id)) transcripts++; else failed++;
      }
    } catch {
      failed++;   // still-running job (JOB_LIVE) or bridge down: the next scheduled purge retries
    }
  }
  log("jobs_purged", { jobs: jobIds.length, transcripts, failed });
  return { jobs: jobIds.length, transcripts, failed };
}

/** Delete AssemblyAI's copies. Never throws: a leftover id stays on the job row for the delete action. */
export async function purgeAsr(ids: string[]): Promise<{ purged: number; failed: number }> {
  "use step";
  let purged = 0, failed = 0;
  for (const id of ids) {
    if (await deleteTranscript(id)) purged++; else failed++;
  }
  log("asr_purged", { purged, failed });
  return { purged, failed };
}

export async function failJob(jobId: string, runId: string, code: string, detail: string) {
  "use step";
  try {
    await bridge("fail", { job_id: jobId, run_id: runId, error_code: code, error_detail: detail, pipeline_version: PIPELINE_VERSION });
  } catch (e) {
    // already terminal / owned elsewhere: nothing to record
    if (!(e instanceof FatalError)) throw e;
  }
  log("job_failed", { job_id: jobId, code });
}

const round = (n: number) => Math.round(n * 1000) / 1000;
function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}
