// Every model and threshold the pipeline uses, in one place. Model ids are
// PINNED: one exact id each, no fallback lists, no "latest" aliases. Changing
// one is a pipeline change: bump PIPELINE_VERSION with it, so every result says
// which pipeline produced it.

export const PIPELINE_VERSION = "sr-2.1.0";   // 2.0: SPEC v0.2 clip taxonomy, smart clips, fe_v1 coaching · 2.1: clip cap by length, clips repaired/dropped one by one, preferred LLM provider

// Output schema (SPEC v0.2 §7): adding fields = minor, renaming/removing = major (30 days side by side).
export const SCHEMA_VERSION = "1.0";

export const MODELS = {
  // AssemblyAI: transcription + word timestamps + entity detection. Exactly one model.
  asr: process.env.ASSEMBLYAI_SPEECH_MODEL ?? "universal-3-5-pro",
  // OpenRouter: text only (PII entity labels on the raw transcript, clip labels
  // and coaching on the redacted one). Never timestamps, never audio.
  llm: process.env.OPENROUTER_MODEL ?? "google/gemini-2.5-flash",
} as const;

export const LIMITS = {
  maxCallSeconds: 3600,            // calls up to 60 minutes (longer: bad_audio "too_long")
  jobDeadlineMs: 2 * 60 * 60 * 1000, // 2 hours of processing per job
  durationTolerance: 0.05,         // ±5% vs calls.duration
  asrWaitMinutes: 90,              // per ASR pass, inside the job deadline
} as const;

export const BLEEP = {
  toneHz: 1000,
  dbfs: -12,
  mergeGapMs: 500,
  edgeFadeMs: 5,
} as const;

export const QA = {
  minAvgWordConfidence: 0.85,
  minSpanConfidence: 0.7,
  maxCrosstalk: 0.1,
} as const;

export const DIGIT_RUN = { minDigits: 4, windowMs: 8000 } as const;

// SPEC v0.2 §2.6: smart clips cut from the redacted audio.
export const CLIPS = { maxPerCall: 6, minS: 20, maxS: 240, fadeS: 1, snapSearchMs: 30_000 } as const;

export const PITCH_SEMITONES = -3;

// The lines of insurance TR samples (TR resolves it from the call's agent and refuses anything else; the worker
// never defaults it). One rubric (fe_v1) for all three until Dmitry rules on per-vertical rubrics.
export const VERTICALS = { final_expense: "final-expense", medicare: "Medicare", aca: "ACA (Affordable Care Act) health" } as const;
export type Vertical = keyof typeof VERTICALS;

// Fixed clip labels (SPEC v0.2 §2.6): the only labels any result may carry.
export const CLIP_LABELS = [
  "opener",
  "rapport",
  "discovery",
  "budget",
  "presentation",
  "objection",
  "close",
  "application",
  "wrap_up",
] as const;
// Objection sub-labels, fixed too ("none" for every other label).
export const OBJECTION_SUBLABELS = ["price", "think_about_it", "spouse", "already_covered", "trust", "health", "timing", "other"] as const;
// Clips with these labels are labelled and coached but their audio is never exported (densest in PII).
export const NO_AUDIO_LABELS = ["application"] as const;
// Rubric fe_v1 (SPEC v0.2 §2.7): each dimension scored 1–5.
export const RUBRIC = { id: "fe_v1", dims: ["rapport", "discovery", "objections", "close", "compliance"] } as const;
export type ClipLabel = (typeof CLIP_LABELS)[number];

export const COST = {
  // USD per audio-hour per channel transcribed; TR's bridge sends the configured
  // value (SAMPLE_ASR_USD_PER_HOUR) and this is only the local fallback.
  asrUsdPerHourFallback: 0.45,
  // Pre-flight allowance for one OpenRouter call; the actual usage.cost is recorded after.
  llmCallReserveUsd: 0.1,
  llmMaxOutputTokens: 8000,
} as const;

export function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}
