// AssemblyAI: the dedicated transcriber. It alone produces timestamps.
// Model pinned (MODELS.asr, exactly one entry in speech_models). The transcript
// is deleted from AssemblyAI as soon as the job no longer needs it.
import { RetryableError } from "./errors";
import { env, MODELS } from "./config";
import { jobError } from "./errors";

const BASE = "https://api.assemblyai.com/v2";

export type AaiWord = { text: string; start: number; end: number; confidence: number; channel?: string; speaker?: string | null };
export type AaiUtterance = { text: string; start: number; end: number; confidence: number; channel?: string; speaker?: string | null; words: AaiWord[] };
export type AaiEntity = { entity_type: string; text: string; start: number; end: number };
export type AaiTranscript = {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  error?: string;
  audio_duration?: number | null;
  audio_channels?: number | null;
  speech_model_used?: string | null;
  words?: AaiWord[];
  utterances?: AaiUtterance[];
  entities?: AaiEntity[];
};

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { Authorization: env("ASSEMBLYAI_API_KEY"), "Content-Type": "application/json", ...(init.headers ?? {}) },
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new RetryableError("assemblyai unreachable", { retryAfter: "30s" });
  }
  if (res.status === 429 || res.status >= 500) throw new RetryableError(`assemblyai ${res.status}`, { retryAfter: "1m" });
  return res;
}

export async function submitTranscript(opts: {
  audioUrl: string;
  multichannel: boolean;
  keyterms: string[];
}): Promise<{ id: string }> {
  const res = await call("/transcript", {
    method: "POST",
    body: JSON.stringify({
      audio_url: opts.audioUrl,
      speech_models: [MODELS.asr],
      language_code: "en_us",
      multichannel: opts.multichannel,
      entity_detection: true,
      punctuate: true,
      format_text: true,
      // Names TR already knows (agent, caller) help the model spell them, so the name pass finds them.
      ...(opts.keyterms.length ? { keyterms_prompt: opts.keyterms.slice(0, 200) } : {}),
    }),
  });
  if (!res.ok) throw jobError("asr_failed", `assemblyai submit ${res.status}`);
  const j = (await res.json()) as { id?: string };
  if (!j.id) throw jobError("asr_failed", "assemblyai submit returned no id");
  return { id: j.id };
}

export async function getTranscript(id: string): Promise<AaiTranscript> {
  const res = await call(`/transcript/${encodeURIComponent(id)}`);
  if (!res.ok) throw jobError("asr_failed", `assemblyai get ${res.status}`);
  return (await res.json()) as AaiTranscript;
}

/** Deletes AssemblyAI's copy. 404 = already gone. Returns false on any other failure. */
export async function deleteTranscript(id: string): Promise<boolean> {
  try {
    const res = await call(`/transcript/${encodeURIComponent(id)}`, { method: "DELETE" });
    return res.ok || res.status === 404;
  } catch {
    return false;
  }
}

export type AaiListed = { id: string; status: string; created: string; audio_url?: string | null };

/**
 * This account's transcripts created before `olderThan` (and after `notBefore`), newest first, following the
 * list API's prev_url pages. Used by the orphan sweep only. Throws on any failure (the sweep just retries later).
 */
export async function listTranscriptsBetween(notBefore: Date, olderThan: Date, maxPages = 20): Promise<AaiListed[]> {
  const out: AaiListed[] = [];
  let path: string | null = "/transcript?limit=200";
  for (let page = 0; path && page < maxPages; page++) {
    const res = await call(path);
    if (!res.ok) throw new Error(`assemblyai list ${res.status}`);
    const j = (await res.json()) as { transcripts?: AaiListed[]; page_details?: { prev_url?: string | null } };
    const rows = j.transcripts ?? [];
    for (const t of rows) {
      const at = new Date(t.created).getTime();
      if (at < olderThan.getTime() && at >= notBefore.getTime()) out.push(t);
    }
    // pages run newest → oldest; stop once a page reaches past the window
    if (!rows.length || rows.some((t) => new Date(t.created).getTime() < notBefore.getTime())) break;
    const prev: string | null = j.page_details?.prev_url ?? null;
    path = prev ? prev.replace(/^https:\/\/api\.assemblyai\.com\/v2/, "") : null;
  }
  return out;
}
