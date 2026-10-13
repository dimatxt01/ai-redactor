import { hasFilter } from "@/lib/audio";
import { MODELS, PIPELINE_VERSION } from "@/lib/config";

// Unauthenticated, no data: what this deployment would run with.
export async function GET() {
  return Response.json({
    ok: true,
    pipeline_version: PIPELINE_VERSION,
    models: MODELS,
    rubberband: await hasFilter("rubberband"),
    configured: {
      bridge: !!process.env.TR_BRIDGE_URL && !!process.env.SAMPLE_REDACTOR_BRIDGE_SECRET,
      start_secret: !!process.env.SAMPLE_REDACTOR_START_SECRET,
      assemblyai: !!process.env.ASSEMBLYAI_API_KEY,
      openrouter: !!process.env.OPENROUTER_API_KEY,
    },
  });
}
