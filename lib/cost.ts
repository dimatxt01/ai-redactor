// Spend accounting against the caps TR sets ($2/job, $100/month by default).
// ASR is charged at the configured per-audio-hour rate × channels transcribed
// (AssemblyAI bills by audio duration; the rate is the operator's number);
// OpenRouter is charged at its reported usage.cost.
import { COST } from "./config";
import { bridge } from "./bridge";
import { jobError } from "./errors";

export const asrCostUsd = (durationMs: number, channels: number, usdPerHour: number) =>
  (durationMs / 3_600_000) * channels * usdPerHour;

/** Same formula as sample-library-admin's pre-submit estimate. */
export const estimateJobUsd = (durationS: number, usdPerHour: number) => (durationS / 3600) * usdPerHour * 3 + 0.25;

/** Records spend (idempotent per item). Throws cost_cap once the job's total passes its cap. */
export async function charge(jobId: string, runId: string, item: string, usd: number): Promise<number> {
  const r = await bridge<{ spent_usd: number; over_cap: boolean; job_cap_usd: number }>("cost", {
    job_id: jobId, run_id: runId, item, add_usd: Math.round(usd * 10000) / 10000,
  });
  if (r.over_cap) throw jobError("cost_cap", `job spend $${r.spent_usd.toFixed(2)} passed the $${r.job_cap_usd} cap`);
  return r.spent_usd;
}

/** Refuse to start a paid call that would push the job past its cap. */
export function guard(spentUsd: number, nextUsd: number, capUsd: number, what: string): void {
  if (spentUsd + nextUsd > capUsd) {
    throw jobError("cost_cap", `${what} would bring the job to $${(spentUsd + nextUsd).toFixed(2)} (cap $${capUsd})`);
  }
}

export const LLM_RESERVE = COST.llmCallReserveUsd;
