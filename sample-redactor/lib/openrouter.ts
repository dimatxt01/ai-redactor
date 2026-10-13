// OpenRouter: labels and coaching only — text in, JSON out. Never audio, never
// timestamps (callers map labels back onto AssemblyAI's word times).
//   • pinned model (MODELS.llm), no fallback models
//   • provider.zdr + data_collection "deny": only zero-retention endpoints that
//     don't collect data; no endpoint qualifies → the call fails, nothing is sent elsewhere
//   • usage.cost (always returned) is the job's actual LLM spend
import { RetryableError } from "workflow";
import { z } from "zod";
import { COST, env, MODELS } from "./config";
import { jobError } from "./errors";

export type LlmResult<T> = { data: T; costUsd: number; model: string };

type LlmOpts<S extends z.ZodType> = {
  schemaName: string;
  schema: S;
  system: string;
  user: string;
  /** Called with usage.cost as soon as a response arrives — before validation — so failed attempts are billed too. */
  onCost?: (usd: number) => Promise<void>;
};

/** One call; schema failures are retried by the workflow step (RetryableError). */
export async function llmJson<S extends z.ZodType>(opts: LlmOpts<S>): Promise<LlmResult<z.infer<S>>> {
  const r = await llmJsonOnce(opts);
  if (!r.ok) throw new RetryableError(`openrouter ${r.error.startsWith("non-json") ? r.error : "schema mismatch"}`, { retryAfter: "10s" });
  return r;
}

/** One call; an invalid answer comes back as {ok:false} with the validation error, for a caller-driven retry. */
export async function llmJsonOnce<S extends z.ZodType>(opts: LlmOpts<S>): Promise<(LlmResult<z.infer<S>> & { ok: true }) | { ok: false; error: string; costUsd: number; model: string }> {
  let res: Response;
  try {
    res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env("OPENROUTER_API_KEY")}`,
        "Content-Type": "application/json",
        "X-Title": "TrueRing sample-redactor",
      },
      body: JSON.stringify({
        model: MODELS.llm,
        temperature: 0,
        seed: 7,   // deterministic labels where the provider supports it (SPEC v0.2 §7)
        max_tokens: COST.llmMaxOutputTokens,
        provider: { zdr: true, data_collection: "deny", require_parameters: true },
        response_format: {
          type: "json_schema",
          json_schema: { name: opts.schemaName, strict: true, schema: strictSchema(z.toJSONSchema(opts.schema)) },
        },
        messages: [
          { role: "system", content: opts.system },
          { role: "user", content: opts.user },
        ],
      }),
      signal: AbortSignal.timeout(180_000),
    });
  } catch {
    throw new RetryableError("openrouter unreachable", { retryAfter: "30s" });
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`openrouter ${res.status}`, { retryAfter: "1m" });
  if (!res.ok) throw jobError("internal", `openrouter ${res.status} (no zero-retention endpoint or bad request)`);

  const body = (await res.json()) as {
    model?: string;
    choices?: { message?: { content?: string }; finish_reason?: string }[];
    usage?: { cost?: number };
  };
  const costUsd = Number(body.usage?.cost ?? 0) || 0;
  if (opts.onCost) await opts.onCost(costUsd);
  const content = body.choices?.[0]?.message?.content ?? "";
  const model = body.model ?? MODELS.llm;
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return { ok: false, error: `non-json (${body.choices?.[0]?.finish_reason ?? "?"})`, costUsd, model };
  }
  const ok = opts.schema.safeParse(parsed);
  // the issue paths/messages name schema fields only, never the model's text
  if (!ok.success) return { ok: false, error: ok.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; "), costUsd, model };
  return { ok: true, data: ok.data, costUsd, model };
}

/** Strict-mode JSON schema: drop $schema and zod's safe-integer bounds, which some providers reject. */
export function strictSchema(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(strictSchema);
  if (!node || typeof node !== "object") return node;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === "$schema") continue;
    if ((k === "minimum" || k === "maximum") && Math.abs(Number(v)) === Number.MAX_SAFE_INTEGER) continue;
    out[k] = strictSchema(v);
  }
  return out;
}
