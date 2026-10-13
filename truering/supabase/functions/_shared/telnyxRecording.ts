// Fresh download link for a stored Telnyx recording. Same lookup recording-proxy
// does inline (direct GET by the recording UUID in the S3 filename, then the
// call_control_id filter); recording-proxy is deliberately NOT refactored onto
// this file. Read-only: it never writes calls.recording_url (that path is
// _shared/recordingUrl.ts + the set_call_recording_url RPC).

const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const BUDGET_MS = 8000;

export function isTelnyxRecordingUrl(url: string): boolean {
  return url.includes('s3.amazonaws.com/telephony-recorder') || url.includes('telnyx') || url.includes('X-Amz-');
}

function recordingIdFromUrl(url: string): string | null {
  try {
    const filename = new URL(url).pathname.split('/').pop() ?? '';
    const stem = filename.split('.')[0];
    return stem.match(UUID_PREFIX)?.[0] ?? null;
  } catch {
    return null;
  }
}

type TelnyxRecording = { download_urls?: { mp3?: string } };
async function getJson<T>(url: string, apiKey: string): Promise<T | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), BUDGET_MS);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: ctl.signal });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Returns a freshly signed mp3 link (Telnyx: ~10 min), or null if Telnyx no longer has it. */
export async function freshTelnyxRecordingUrl(
  storedUrl: string,
  callControlId: string | null,
): Promise<string | null> {
  const apiKey = Deno.env.get('TELNYX_API_KEY');
  if (!apiKey) throw new Error('TELNYX_API_KEY not configured');

  const recordingId = recordingIdFromUrl(storedUrl);
  if (recordingId) {
    const j = await getJson<{ data?: TelnyxRecording }>(`https://api.telnyx.com/v2/recordings/${recordingId}`, apiKey);
    const url = j?.data?.download_urls?.mp3;
    if (url) return url;
  }
  if (callControlId) {
    const j = await getJson<{ data?: TelnyxRecording[] }>(
      `https://api.telnyx.com/v2/recordings?filter[call_control_id]=${encodeURIComponent(callControlId)}`,
      apiKey,
    );
    const url = j?.data?.[0]?.download_urls?.mp3;
    if (url) return url;
  }
  return null;
}
