// SIMULATION ONLY. Preloaded into the worker process by sim/run.ts (node --import), never in a deployment:
// sends the worker's AssemblyAI and OpenRouter calls to the simulation's fake vendors. The worker code is
// unchanged; this only rewrites the two vendor origins.
const target = process.env.SIM_VENDOR_BASE;
if (!target) throw new Error("vendor-redirect: SIM_VENDOR_BASE not set");
if (process.env.VERCEL || process.env.VERCEL_DEPLOYMENT_ID) throw new Error("vendor-redirect must never load on Vercel");

const VENDORS = { "https://api.assemblyai.com": "/aai", "https://openrouter.ai": "/openrouter" };
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  for (const [origin, path] of Object.entries(VENDORS)) {
    if (url.startsWith(origin + "/")) {
      const to = target + path + url.slice(origin.length);
      return realFetch(typeof input === "string" || input instanceof URL ? to : new Request(to, input), init);
    }
  }
  return realFetch(input, init);
};
