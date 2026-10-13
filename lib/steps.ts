// Steps of the redaction workflow. Each step does its own I/O (bridge, vendors,
// ffmpeg) and passes ONLY non-PII values onward: ids, counts, hashes, millisecond
// offsets, detector/type names. Transcripts and names live in TR's private
// sample-src/<job_id>/ scratch prefix between steps and in local /tmp inside one step (removed in
// `finally`), so nothing the worker keeps in memory or logs between steps is personal data.
// lib/job.ts runs them in order; a step that throws anything but FatalError is retried (lib/retry.ts).
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deleteTranscript, getTranscript, submitTranscript, type AaiEntity } from "@/lib/assemblyai";
import { bridge, getWork, getWorkJson, putWork, signUrls, uploadSigned, downloadSigned, type JobInputs, type JobOptions } from "@/lib/bridge";
import { cutClip, encodeMp3, probe, renderRedacted, writePcm, type PitchEngine } from "@/lib/audio";
import { envelope, redactedLines, sha256, spansJson, transcriptJson, transcriptTxt, versionTag } from "@/lib/artifacts";
import { CLIPS, LIMITS, MODELS, PIPELINE_VERSION, SCHEMA_VERSION } from "@/lib/config";
import { asrCostUsd, charge, guard, LLM_RESERVE } from "@/lib/cost";
import { FatalError, jobError } from "@/lib/errors";
import { clipAndCoach, type CallCoaching, type Clip, type RedactedLine } from "@/lib/labels";
import { log } from "@/lib/log";
import { normalizeOptions } from "@/lib/options";
import {
  AAI_ENTITY_MAP, bleepIntervals, dedupe, entitySpans, nameTerms, ruleSpans, termMatches, totalMs, type Interval, type Span,
} from "@/lib/pii/detect";
import { llmPiiSpans } from "@/lib/pii/llm";
import { avgConfidence, clipReasons, crosstalk, firstPassReasons, secondPassReasons, textPiiReasons } from "@/lib/qa";
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
// scratch only: clip windows + generated text, read back by verify and complete (never in step I/O)
type ClipsFile = { clips: (Clip & { audio: { name: string; sha256: string } | null })[]; coaching: CallCoaching | null };

async function scratch(jobId: string): Promise<string> {
  const dir = path.join(tmpdir(), `sr-${jobId}-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function inputs(ctx: Ctx): Promise<JobInputs> {
  return bridge<JobInputs>("job", { job_id: ctx.jobId });
}

// ── 1. claim ────────────────────────────────────────────────────────────────
export async function claimJob(jobId: string, runId: string, idempotencyKey: string): Promise<{ duplicate: true } | { duplicate: false; ctx: Ctx }> {
  const inp = await bridge<JobInputs>("job", { job_id: jobId });
  try {
    // the bridge refuses a start whose key is not this job's key
    await bridge("claim", { job_id: jobId, run_id: runId, idempotency_key: idempotencyKey });
  } catch (e) {
    if (e instanceof Error && e.message.startsWith("DUPLICATE_RUN")) {
      log("job_duplicate_run", { job_id: jobId, run_id: runId });
      return { duplicate: true };
    }
    throw e;
  }
  // every redaction setting fails safe when TR's row lacks it (lib/options.ts)
  const options = normalizeOptions(inp.job.options, inp.job.call_meta.channel_map?.customer);
  log("job_claimed", { job_id: jobId, run_id: runId, version: inp.job.version, duration_s: inp.job.call_meta.duration_s });
  return {
    duplicate: false,
    ctx: {
      jobId,
      runId,
      callId: inp.job.call_id,
      version: inp.job.version,
      options,
      durationS: Number(inp.job.call_meta.duration_s) || 0,
      channelMapVerified: inp.job.call_meta.channel_map?.verified === true,
      jobCapUsd: inp.caps.job_usd,
      asrUsdPerHour: inp.caps.asr_usd_per_hour,
    },
  };
}

export async function setStatus(ctx: Ctx, status: "transcribing" | "redacting" | "verifying", engine?: Record<string, string>) {
  await bridge("status", { job_id: ctx.jobId, run_id: ctx.runId, status, ...(engine ? { engine } : {}) });
}

// ── 2. fetch ────────────────────────────────────────────────────────────────
export async function fetchSource(ctx: Ctx): Promise<Source> {
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
      throw jobError("bad_audio", `too_long: recording is ${Math.round(p.durationMs / 60000)} min; limit is 60`);
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
export async function submitAsr(ctx: Ctx, pass: "pass1" | "pass2", durationMs: number): Promise<{ id: string }> {
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
  const t = await getTranscript(id);
  return t.status;
}

export async function savePass1(ctx: Ctx, id: string): Promise<{ words: number; avgConf: number; crosstalk: number }> {
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
// `attempt` (the step retry, from lib/retry.ts) keeps the cost-ledger item keys unique per paid call
export async function detectPii(ctx: Ctx, src: Source, pass1: { avgConf: number; crosstalk: number }, attempt = 1) {
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

// ── 7. smart clips + coaching (SPEC v0.2 §2.6–2.7) ──────────────────────────
export async function clipsAndCoaching(ctx: Ctx, src: Source, stepAttempt = 1) {
  const inp = await inputs(ctx);
  const lines = await getWorkJson<RedactedLine[]>(ctx.jobId, ctx.runId, "redacted-lines.json");
  const { bleeps } = await getWorkJson<SpansFile>(ctx.jobId, ctx.runId, "spans.json");
  if (!lines.length) throw jobError("asr_failed", "no utterances to label");
  const want = { clips: ctx.options.clips?.enabled !== false, coaching: ctx.options.coaching?.enabled !== false };

  let clips: Clip[] = [];
  let coaching: CallCoaching | null = null;
  const reasons: string[] = [];
  let llmModel = "";
  if (want.clips || want.coaching) {
    guard(inp.caps.spent_usd, 2 * LLM_RESERVE, ctx.jobCapUsd, "LLM clips/coaching");
    const r = await clipAndCoach(lines, bleeps, src.durationMs, {
      maxClips: Math.min(CLIPS.maxPerCall, ctx.options.clips?.max_per_call ?? CLIPS.maxPerCall),
      onCost: async (usd, attempt) => { await charge(ctx.jobId, ctx.runId, `llm:clips:s${stepAttempt}:a${attempt}`, usd); },
    });
    llmModel = r.model;
    if (r.ok) {
      clips = r.clips;
      coaching = r.coaching;
      reasons.push(...r.dropped);
      if (r.attempts > 1) log("labels_retried", { job_id: ctx.jobId });
    } else {
      // SPEC v0.2 §7: still invalid after one retry => flag it, never return free-form labels
      reasons.push("labels_invalid");
      log("labels_invalid", { job_id: ctx.jobId });
    }
    if (!want.clips) {
      clips = [];
      if (coaching) coaching = { ...coaching, turning_point_clip_id: null };
    }
    if (!want.coaching) {
      coaching = null;
      clips = clips.map((c) => ({ ...c, coaching: { did: "", worked: "", improve: "", key_lines: [], scores: c.coaching.scores } }));
    }
  }

  // cut the exported clips from the redacted audio
  const exported = clips.filter((c) => c.audio_exported);
  const withAudio: ClipsFile["clips"] = clips.map((c) => ({ ...c, audio: null }));
  if (exported.length) {
    const urls = await signUrls(ctx.jobId, ctx.runId, [
      { target: "library", name: "redacted.mp3", mode: "download" },
      ...exported.map((c) => ({ target: "library" as const, name: `clips/${c.clip_id}.mp3`, mode: "upload" as const })),
    ]);
    const dir = await scratch(ctx.jobId);
    try {
      const inFile = path.join(dir, "redacted.mp3");
      await writeFile(inFile, await downloadSigned(urls["library:redacted.mp3:download"]));
      for (const c of exported) {
        const outFile = path.join(dir, `${c.clip_id}.mp3`);
        await cutClip(inFile, outFile, c, versionTag(ctx.version));
        const bytes = await readFile(outFile);
        await uploadSigned(urls[`library:clips/${c.clip_id}.mp3:upload`], bytes, "audio/mpeg");
        withAudio.find((x) => x.clip_id === c.clip_id)!.audio = { name: `clips/${c.clip_id}.mp3`, sha256: sha256(bytes) };
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  const cj = JSON.stringify(envelope("tr.training.clips", ctx.version, ctx.callId, clips), null, 1);
  const kj = JSON.stringify(envelope("tr.training.coaching", ctx.version, ctx.callId, coaching), null, 1);
  const urls = await signUrls(ctx.jobId, ctx.runId, [
    { target: "library", name: "clips.json", mode: "upload" },
    { target: "library", name: "coaching.json", mode: "upload" },
  ]);
  await uploadSigned(urls["library:clips.json:upload"], cj, "application/json");
  await uploadSigned(urls["library:coaching.json:upload"], kj, "application/json");
  await putWork(ctx.jobId, ctx.runId, "clips-meta.json", JSON.stringify({ clips: withAudio, coaching } satisfies ClipsFile), "application/json");

  log("clips_done", { job_id: ctx.jobId, clips: clips.length, exported: exported.length, coaching: !!coaching, reasons: reasons.length });
  return {
    clips_json: { name: "clips.json", sha256: sha256(cj) },
    coaching_json: { name: "coaching.json", sha256: sha256(kj) },
    clipCount: clips.length,
    exportedCount: exported.length,
    llmModel,
    reasons,
  };
}

// ── 8. verify ───────────────────────────────────────────────────────────────
const PII_ENTITY_TYPES = new Set(Object.keys(AAI_ENTITY_MAP));

export async function verifySecondPass(ctx: Ctx, id: string): Promise<string[]> {
  const raw = await getTranscript(id);
  if (raw.status !== "completed") throw jobError("asr_failed", `pass2 status ${raw.status}`);
  const t2 = fromAssemblyAi(raw, 0);
  const { names } = await getWorkJson<NamesFile>(ctx.jobId, ctx.runId, "names.json");
  const { bleeps } = await getWorkJson<SpansFile>(ctx.jobId, ctx.runId, "spans.json");
  const types = ctx.options.redact_health
    ? PII_ENTITY_TYPES
    : new Set([...PII_ENTITY_TYPES].filter((k) => !String(AAI_ENTITY_MAP[k]).endsWith("_OPT")));
  const full = secondPassReasons(t2, bleeps, names, raw.entities ?? [], types);
  // SPEC v0.2 §2.8: the same checks on every clip and on all coaching text
  const { clips, coaching } = await getWorkJson<ClipsFile>(ctx.jobId, ctx.runId, "clips-meta.json");
  const texts: { where: string; text: string }[] = [];
  if (coaching) {
    texts.push({ where: "call.summary", text: coaching.summary });
    coaching.strengths.forEach((t, i) => texts.push({ where: `call.strengths.${i}`, text: t }));
    coaching.improvements.forEach((t, i) => texts.push({ where: `call.improvements.${i}`, text: t }));
  }
  for (const c of clips) {
    for (const k of ["did", "worked", "improve"] as const) texts.push({ where: `${c.clip_id}.${k}`, text: c.coaching[k] });
    c.coaching.key_lines.forEach((t, i) => texts.push({ where: `${c.clip_id}.key_lines.${i}`, text: t }));
    texts.push({ where: `${c.clip_id}.title`, text: c.title });
  }
  const reasons = [...full, ...clipReasons(full, clips), ...textPiiReasons(texts, names)];
  log("second_pass", { job_id: ctx.jobId, words: t2.words.length, hits: full.length, total: reasons.length });
  return reasons;
}

// ── 9. finish ───────────────────────────────────────────────────────────────
export async function completeJob(ctx: Ctx, payload: {
  artifacts: Record<string, unknown>;
  qaReasons: string[];
  metrics: Record<string, unknown>;
  engine: Record<string, string>;
}) {
  const artifacts = Object.fromEntries(Object.entries(payload.artifacts).filter(([, v]) => v));
  const { clips, coaching } = await getWorkJson<ClipsFile>(ctx.jobId, ctx.runId, "clips-meta.json");
  const r = await bridge<{ library_call_id: string }>("complete", {
    job_id: ctx.jobId,
    run_id: ctx.runId,
    pipeline_version: PIPELINE_VERSION,
    schema_version: SCHEMA_VERSION,
    qa_flag: payload.qaReasons.length > 0,
    qa_reasons: payload.qaReasons,
    metrics: payload.metrics,
    engine: payload.engine,
    artifacts,
    coaching: coaching ?? {},
    clips: clips.map((c) => ({
      clip_id: c.clip_id, label: c.label, sub_label: c.sub_label, start_ms: c.start_ms, end_ms: c.end_ms,
      audio_exported: c.audio_exported && !!c.audio, audio: c.audio, title: c.title, coaching: c.coaching, confidence: c.confidence,
    })),
  });
  log("job_done", { job_id: ctx.jobId, library_call_id: r.library_call_id, qa_flag: payload.qaReasons.length > 0, reasons: payload.qaReasons.length });
}

/**
 * Cleanup for jobs that ended badly or were taken down: TR's bridge removes scratch
 * (and artifacts of failed/deleted jobs) and returns every vendor transcript id
 * ever recorded for the job, which are then deleted. Never throws.
 */
export async function purgeJobs(jobIds: string[]): Promise<{ jobs: number; transcripts: number; failed: number }> {
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
export async function purgeAsr(ids: string[]): Promise<{ purged: number; failed: number; deleted: string[] }> {
  const deleted: string[] = [];
  for (const id of ids) if (await deleteTranscript(id)) deleted.push(id);
  log("asr_purged", { purged: deleted.length, failed: ids.length - deleted.length });
  return { purged: deleted.length, failed: ids.length - deleted.length, deleted };
}

export async function failJob(jobId: string, runId: string, code: string, detail: string) {
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
