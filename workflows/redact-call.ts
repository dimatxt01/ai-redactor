// The redaction pipeline as one durable run per job.
//   claim → fetch → ASR pass 1 (multichannel) → detect → render → transcript files
//   → smart clips + coaching (SPEC v0.2) → ASR pass 2 on the redacted audio
//   → verify (full audio, every clip, all coaching text) → complete
// Exactly once: the bridge's claim lets one run own a job; a duplicate start
// returns at once. Any failure ends the job with an error code and purges
// AssemblyAI's copies; TR's bridge purges scratch + partial artifacts.
import { createWebhook, getWorkflowMetadata, sleep } from "workflow";
import { start } from "workflow/api";
import { LIMITS, MODELS, PIPELINE_VERSION, RUN_OPTIONS } from "@/lib/config";
import { codeFromError, jobError } from "@/lib/errors";
import {
  asrStatus, claimJob, clipsAndCoaching, completeJob, detectPii, failJob, fetchSource, purgeAsr, purgeJobs, renderAudio, savePass1,
  setStatus, submitAsr, verifySecondPass, writeTranscriptArtifacts, type Ctx,
} from "./steps";

const POLL = "5m";

async function transcribe(ctx: Ctx, pass: "pass1" | "pass2", durationMs: number, asrIds: string[]): Promise<string> {
  const webhook = createWebhook();
  await webhook.getConflict();   // registered before AssemblyAI can call it
  const { id } = await submitAsr(ctx, pass, webhook.url, durationMs);
  asrIds.push(id);

  // The webhook only wakes us; the status is always read from AssemblyAI with our key,
  // so a forged request to the webhook URL cannot fake a completion.
  const arrived = webhook.then(() => "hook" as const);
  let hookSeen = false;
  const rounds = Math.ceil(LIMITS.asrWaitMinutes / 5);
  for (let k = 0; k < rounds; k++) {
    const woke = hookSeen ? await sleep(POLL).then(() => "tick" as const) : await Promise.race([arrived, sleep(POLL).then(() => "tick" as const)]);
    if (woke === "hook") hookSeen = true;
    const status = await asrStatus(id);
    if (status === "completed") return id;
    if (status === "error") throw jobError("asr_failed", `${pass} transcription error`);
  }
  throw jobError("timeout", `${pass} not transcribed within ${LIMITS.asrWaitMinutes} min`);
}

export async function redactCall(jobId: string, idempotencyKey: string) {
  "use workflow";
  const runId = getWorkflowMetadata().workflowRunId;
  const asrIds: string[] = [];

  try {
    const claim = await claimJob(jobId, runId, idempotencyKey);
    if (claim.duplicate) return { status: "duplicate" as const };
    const ctx = claim.ctx;

    const src = await fetchSource(ctx);
    await setStatus(ctx, "transcribing");
    const id1 = await transcribe(ctx, "pass1", src.durationMs, asrIds);
    const pass1 = await savePass1(ctx, id1);

    await setStatus(ctx, "redacting");
    const det = await detectPii(ctx, src, pass1);
    const audio = await renderAudio(ctx, src);
    const files = await writeTranscriptArtifacts(ctx, src);
    const lab = await clipsAndCoaching(ctx, src);

    const engine = {
      asr: `assemblyai:${MODELS.asr}`,
      pii: `assemblyai-entities+rules+openrouter ${PIPELINE_VERSION}`,
      llm: `openrouter:${lab.llmModel || det.llmModel}`,
      pitch: audio.pitchEngine,
      pipeline: PIPELINE_VERSION,
    };
    await setStatus(ctx, "verifying", engine);
    const id2 = await transcribe(ctx, "pass2", src.durationMs, asrIds);
    const second = await verifySecondPass(ctx, id2);

    const qaReasons = [...det.reasons, ...lab.reasons, ...second];
    await completeJob(ctx, {
      artifacts: {
        redacted_audio: { name: "redacted.mp3", sha256: audio.sha256, bytes: audio.bytes },
        ...files,
        clips_json: lab.clips_json,
        coaching_json: lab.coaching_json,
      },
      qaReasons,
      metrics: {
        asr_confidence: pass1.avgConf,
        crosstalk: pass1.crosstalk,
        words: pass1.words,
        pii_spans: det.spanCount,
        pii_by_type: det.byType,
        pii_by_detector: det.byDetector,
        bleeped_ms: det.bleepedMs,
        duration_ms: src.durationMs,
        source: { channels: src.channels, sample_rate: src.sampleRate, bitrate_kbps: src.bitrateKbps },
        llm_calls: det.llmCalls + 1,
        clips: lab.clipCount,
        clips_exported: lab.exportedCount,
      },
      engine,
    });
    await purgeAsr(asrIds);
    return { status: "done" as const, qa_flag: qaReasons.length > 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    await purgeAsr(asrIds);
    // Another run owns the job: it is not ours to clean.
    if (msg.startsWith("DUPLICATE_RUN")) return { status: "duplicate" as const };
    // The bridge already ended it (2h deadline, month cap, takedown): nothing to record, but clean up.
    const stopped = msg.startsWith("JOB_TERMINAL");
    const { code, detail } = codeFromError(e);
    if (!stopped) await failJob(jobId, runId, code, detail);
    await purgeJobs([jobId]);
    // An upload signed before the failure can still land for ~2h: purge again after every signed URL expired.
    await start(purgeLater, [[jobId]], RUN_OPTIONS);
    return stopped ? { status: "stopped" as const } : { status: "failed" as const, error_code: code };
  }
}

/** Re-purge after every signed upload URL issued for these jobs has expired (Supabase: 2h). */
export async function purgeLater(jobIds: string[]) {
  "use workflow";
  await sleep("135m");   // 2h15m
  return purgeJobs(jobIds);
}
