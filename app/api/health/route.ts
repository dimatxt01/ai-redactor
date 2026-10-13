import { ffmpegInfo, hasFilter } from "@/lib/audio";
import { MODELS, PIPELINE_VERSION } from "@/lib/config";

// Unauthenticated, no data: what this deployment would run with.
export async function GET() {
  const ffmpeg = await ffmpegInfo();
  return Response.json({
    ok: ffmpeg.ok,
    ffmpeg,
    pipeline_version: PIPELINE_VERSION,
    models: MODELS,
    rubberband: await hasFilter("rubberband"),
    configured: {
      bridge: !!process.env.TR_BRIDGE_URL && !!process.env.SAMPLE_REDACTOR_BRIDGE_SECRET,
      start_secret: !!process.env.SAMPLE_REDACTOR_START_SECRET,
      assemblyai: !!process.env.ASSEMBLYAI_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
    },
  }, { status: ffmpeg.ok ? 200 : 503 });   // no ffmpeg = every job would fail at render: say so here
}
