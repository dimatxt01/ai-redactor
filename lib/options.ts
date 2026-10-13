// Job options as the worker uses them. TR's training-library-admin sends every field (cleanOptions), but the
// worker never trusts that: a missing or malformed value falls back to SPEC v0.2's default, and every
// redaction setting fails SAFE (pad present, health redacted). Without this, an options object without
// bleep_pad_ms produced NaN bleep intervals, i.e. nothing bleeped (caught by the simulation, sim/run.ts).
import { CLIPS } from "./config";
import type { JobOptions } from "./bridge";

const PAD = { min: 200, max: 300, fallback: 250 } as const;

export function normalizeOptions(raw: unknown, customerChannel?: unknown): Omit<JobOptions, "extra_terms"> {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, any>;
  const pad = Number(o.bleep_pad_ms);
  const max = Number(o.clips?.max_per_call);
  const ch = Number(customerChannel ?? o.customer_channel);
  return {
    bleep_pad_ms: Number.isFinite(pad) ? Math.min(PAD.max, Math.max(PAD.min, Math.round(pad))) : PAD.fallback,
    pitch_shift_customer: o.pitch_shift_customer === true,
    redact_health: o.redact_health !== false,
    clips: {
      enabled: o.clips?.enabled !== false,
      max_per_call: Number.isFinite(max) ? Math.min(CLIPS.maxPerCall, Math.max(1, Math.round(max))) : CLIPS.maxPerCall,
      min_s: CLIPS.minS,
      max_s: CLIPS.maxS,
    },
    coaching: { enabled: o.coaching?.enabled !== false, rubric: "fe_v1" },
    customer_channel: ch === 1 ? 1 : 0,
  };
}
