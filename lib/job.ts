// One job, start to finish, inside the worker process:
//   claim → fetch → ASR pass 1 (multichannel) → detect → render → transcript files
//   → smart clips + coaching (SPEC v0.2) → ASR pass 2 on the redacted audio
//   → verify (full audio, every clip, all coaching text) → complete
// Exactly once: the bridge's claim lets one run own a job; a run that loses the claim returns at once.
// Any failure ends the job with an error code; TR's bridge purges scratch + partial artifacts. Every ending
// deletes this run's AssemblyAI copies and reports them (`vendor_purged`), which also ends the heartbeat.
// `signal` aborts the job: reason "stop" (cancelled / failed / deleted elsewhere: nothing to record) or "shutdown"
// (the worker is restarting: the job fails as internal, the AM retries).
import { vendorPurged } from "./bridge";
import { LIMITS, MODELS, PIPELINE_VERSION } from "./config";
import { codeFromError, jobError } from "./errors";
import { log } from "./log";
import { sleep, withRetry } from "./retry";
import {
  asrStatus, claimJob, clipsAndCoaching, completeJob, detectPii, failJob, fetchSource, purgeAsr, purgeJobs, renderAudio, savePass1,
  setStatus, submitAsr, verifySecondPass, writeTranscriptArtifacts, type Ctx,
} from "./steps";

const ASR_POLL_MS = (Number(process.env.ASR_POLL_S) || 10) * 1000;

export type JobResult = { status: "done"; qa_flag: boolean } | { status: "duplicate" | "stopped" } | { status: "failed"; error_code: string };

export async function runJob(jobId: string, idempotencyKey: string, runId: string, signal: AbortSignal, asrIds: string[] = []): Promise<JobResult> {
  let claimed = false;
  let gone = false;   // the job row no longer exists (NO_JOB)
  const step = <T>(fn: (attempt: number) => Promise<T>) => withRetry(fn, { signal });

  const transcribe = async (ctx: Ctx, pass: "pass1" | "pass2", durationMs: number): Promise<string> => {
    const { id } = await step(() => submitAsr(ctx, pass, durationMs));
    asrIds.push(id);
    // no inbound webhook: the worker asks AssemblyAI (with its own key) until the transcript is ready
    const deadline = Date.now() + LIMITS.asrWaitMinutes * 60_000;
    while (Date.now() < deadline) {
      await sleep(ASR_POLL_MS, signal);
      const status = await step(() => asrStatus(id));
      if (status === "completed") return id;
      if (status === "error") throw jobError("asr_failed", `${pass} transcription error`);
    }
    throw jobError("timeout", `${pass} not transcribed within ${LIMITS.asrWaitMinutes} min`);
  };

  try {
    const claim = await step(() => claimJob(jobId, runId, idempotencyKey));
    if (claim.duplicate) return { status: "duplicate" };
    claimed = true;
    const ctx = claim.ctx;

    const src = await step(() => fetchSource(ctx));
    await step(() => setStatus(ctx, "transcribing"));
    const id1 = await transcribe(ctx, "pass1", src.durationMs);
    const pass1 = await step(() => savePass1(ctx, id1));

    await step(() => setStatus(ctx, "redacting"));
    const det = await step((attempt) => detectPii(ctx, src, pass1, attempt));
    const audio = await step(() => renderAudio(ctx, src));
    const files = await step(() => writeTranscriptArtifacts(ctx, src));
    const lab = await step((attempt) => clipsAndCoaching(ctx, src, attempt));

    const engine = {
      asr: `assemblyai:${MODELS.asr}`,
      pii: `assemblyai-entities+rules+openrouter ${PIPELINE_VERSION}`,
      llm: `openrouter:${lab.llmModel || det.llmModel}`,
      pitch: audio.pitchEngine,
      pipeline: PIPELINE_VERSION,
    };
    await step(() => setStatus(ctx, "verifying", engine));
    const id2 = await transcribe(ctx, "pass2", src.durationMs);
    const second = await step(() => verifySecondPass(ctx, id2));

    const qaReasons = [...det.reasons, ...lab.reasons, ...second];
    await step(() => completeJob(ctx, {
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
    }));
    return { status: "done", qa_flag: qaReasons.length > 0 };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.startsWith("DUPLICATE_RUN")) return { status: "duplicate" };
    // the call was deleted on TR's side: the row is gone; nothing to record or report
    if (msg.startsWith("NO_JOB")) gone = true;
    // ended elsewhere (cancelled, 2 h deadline, month cap, failed by the bridge, deleted): nothing to record
    const stopped = gone || msg.startsWith("JOB_TERMINAL") || (signal.aborted && signal.reason === "stop");
    const { code, detail } = signal.aborted && signal.reason === "shutdown"
      ? { code: "internal", detail: "worker restarted; retry the job" }
      : codeFromError(e);
    if (claimed && !stopped) await failJob(jobId, runId, code, detail);
    if (claimed && !gone) await purgeJobs([jobId]);
    return stopped ? { status: "stopped" } : { status: "failed", error_code: code };
  } finally {
    if (claimed) {
      const { deleted } = await purgeAsr(asrIds);   // always: AssemblyAI keeps nothing, whatever happened to the row
      // the last word of this run: vendor copies gone and the heartbeat ends (that is what lets TR delete the call).
      // A row that is gone (NO_JOB) has nobody to tell.
      if (!gone) try {
        await withRetry(() => vendorPurged(jobId, runId, deleted), { attempts: 3 });
      } catch {
        log("vendor_report_failed", { job_id: jobId });   // the bridge's cleanup list hands it out again once the heartbeat is stale
      }
    }
  }
}
