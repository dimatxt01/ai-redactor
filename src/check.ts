// Self-test, also run by the worker at startup (it refuses to start on a failure):
//   npm run check               config present + the bundled ffmpeg runs on this machine
//   npm run check -- --bridge   + one signed `poll` with capacity 0: the bridge URL and the shared secret work
// Prints JSON with no secret values. Exit code 0 = ok.
import { poll } from "../lib/bridge";
import { ffmpegInfo } from "../lib/audio";
import { MODELS, PIPELINE_VERSION } from "../lib/config";

const REQUIRED = ["TR_BRIDGE_URL", "SAMPLE_REDACTOR_BRIDGE_SECRET", "ASSEMBLYAI_API_KEY", "OPENROUTER_API_KEY"] as const;

export async function selfCheck(opts: { bridge?: boolean; worker?: string } = {}) {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  const ffmpeg = await ffmpegInfo();
  let bridge: { ok: boolean; detail: string } | null = null;
  if (opts.bridge) {
    if (missing.some((k) => k.startsWith("TR_") || k.startsWith("SAMPLE_"))) bridge = { ok: false, detail: "bridge env not set" };
    else {
      try {
        await poll(opts.worker ?? "check", [], 0);
        bridge = { ok: true, detail: new URL(process.env.TR_BRIDGE_URL!).host };
      } catch (e) {
        bridge = { ok: false, detail: e instanceof Error ? e.message.slice(0, 120) : "error" };
      }
    }
  }
  const ok = missing.length === 0 && ffmpeg.ok && (bridge?.ok ?? true);
  return { ok, pipeline_version: PIPELINE_VERSION, models: MODELS, missing_env: missing, ffmpeg, bridge };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const r = await selfCheck({ bridge: process.argv.includes("--bridge") });
  console.log(JSON.stringify(r, null, 2));
  process.exit(r.ok ? 0 : 1);
}
