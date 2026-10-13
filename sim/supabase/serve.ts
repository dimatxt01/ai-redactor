// SIMULATION ONLY. Runs one REAL TrueRing edge function (truering/supabase/functions/<name>/index.ts, unchanged)
// on a local port:  deno run -A --import-map=sim/supabase/import_map.json sim/supabase/serve.ts <name> <port>
// The import map swaps supabase-js for fake-supabase.ts (local Postgres + disk storage) and stubs the two
// TrueRing helpers that live outside this repo. Telnyx API calls are sent to the simulation harness.
const [name, port] = Deno.args;
const TELNYX = Deno.env.get("SIM_TELNYX_BASE");
const realFetch = globalThis.fetch;
globalThis.fetch = (input: Request | URL | string, init?: RequestInit) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  if (TELNYX && url.startsWith("https://api.telnyx.com/")) return realFetch(TELNYX + url.slice("https://api.telnyx.com".length), init);
  return realFetch(input, init);
};
const realServe = Deno.serve;
// deno-lint-ignore no-explicit-any
(Deno as any).serve = (handler: any) => realServe({ port: Number(port), hostname: "127.0.0.1", onListen: () => console.log(`[sim] ${name} on :${port}`) }, handler);
await import(new URL(`../../truering/supabase/functions/${name}/index.ts`, import.meta.url).href);
