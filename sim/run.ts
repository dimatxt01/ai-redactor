// `npm run simulate` — the whole system on this machine, the way it will run in production:
//
//   AM (this script) ─► training-library-admin ─► worker /api/jobs ─► Workflow run ─► sample-redaction-bridge ─► Postgres
//        REAL TR edge function (Deno)             REAL worker (next start, local Workflow World)   REAL TR edge function   REAL migrations
//
// Faked: only what lives outside both repos — Supabase's HTTP layer (fake-supabase.ts: same queries, on a throwaway
// local Postgres with the RL-1 + worker migrations; storage on disk), Telnyx, AssemblyAI, OpenRouter (fakes.ts).
// The fake transcriber LISTENS to the redacted audio for the verification pass, so a value the worker failed
// to bleep stays audible and is caught exactly as it would be in production.
//
// Touches nothing live: no Supabase project, no Vercel, no vendor, no keys. Every value in the calls is fictional.
//   npm run simulate                 # build the worker, run every scenario, write sim-out/<time>/report.md
//   npm run simulate -- --no-build   # reuse .next from the last build
//   npm run simulate -- --keep       # leave the servers running at the end (Ctrl-C to stop)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import path from "node:path";
import { signBody } from "../lib/signature";
import { CLIP_LABELS, NO_AUDIO_LABELS, PIPELINE_VERSION, SCHEMA_VERSION } from "../lib/config";
import { BLEEPED, decodeStereo, Fakes, plantedWords, toneShare, wordsOf, type Manifest } from "./fakes";

const ROOT = path.resolve(import.meta.dirname, "..");
const TR = path.join(ROOT, "truering");
const args = process.argv.slice(2);
const NO_BUILD = args.includes("--no-build");
const KEEP = args.includes("--keep");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const OUT = path.join(ROOT, "sim-out", STAMP);
const LOGS = path.join(OUT, "logs");
const STORAGE = path.join(OUT, "storage");
mkdirSync(LOGS, { recursive: true });
mkdirSync(STORAGE, { recursive: true });

// the Next.js integration keeps the local Workflow World under .next/; cleared per run, copied to OUT at the end
const WF_DATA = path.join(ROOT, ".next", "workflow-data");
const PORT = { pg: 5491, bridge: 3231, admin: 3232, fakes: 3233, worker: 3234 };
const BASE = (p: number) => `http://127.0.0.1:${p}`;
const SECRET = { bridge: `sim-bridge-${randomBytes(16).toString("hex")}`, start: `sim-start-${randomBytes(16).toString("hex")}`, sign: randomBytes(32).toString("hex") };
const AM = "22222222-0000-0000-0000-0000000000a3";      // account_manager in the RL-1 fixture
const ADMIN = "22222222-0000-0000-0000-0000000000ad";   // admin in the RL-1 fixture
const CALLS = ["01-classic-sale", "07-bank-and-card", "09-objections"] as const;

// ── tiny report ──────────────────────────────────────────────────────────────
type Row = { section: string; ok: boolean; name: string; detail: string };
const rows: Row[] = [];
let section = "";
const t0 = Date.now();
function sectionStart(s: string) { section = s; console.log(`\n── ${s}`); }
function check(name: string, ok: boolean, detail = "") {
  rows.push({ section, ok, name, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  return ok;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── processes ────────────────────────────────────────────────────────────────
const procs: ChildProcess[] = [];
function startProc(name: string, cmd: string, argv: string[], env: Record<string, string>, cwd = ROOT) {
  const fd = openSync(path.join(LOGS, `${name}.log`), "a");
  const p = spawn(cmd, argv, { cwd, env: { ...process.env, ...env }, stdio: ["ignore", fd, fd], detached: true });
  closeSync(fd);
  procs.push(p);
  return p;
}
function stopAll() {
  for (const p of procs) { try { process.kill(-p.pid!, "SIGTERM"); } catch { /* gone */ } }
}
process.on("exit", stopAll);
process.on("SIGINT", () => { stopAll(); process.exit(130); });

async function waitFor(what: string, url: string, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const r = await fetch(url, { method: url.endsWith("/api/health") ? "GET" : "POST", body: url.endsWith("/api/health") ? undefined : "{}" }); if (r.status < 500 || r.status === 501) return; } catch { /* not up */ }
    await sleep(500);
  }
  throw new Error(`${what} did not come up (${url}); see ${path.relative(ROOT, LOGS)}/`);
}

// ── Postgres ─────────────────────────────────────────────────────────────────
function pgBin(): string {
  if (process.env.PGBIN) return process.env.PGBIN;
  const cands = [
    ...["17", "16", "15"].map((v) => `/opt/homebrew/opt/postgresql@${v}/bin`),
    ...["17", "16", "15"].map((v) => `/usr/lib/postgresql/${v}/bin`),
    "/usr/local/bin", "/opt/homebrew/bin",
  ];
  for (const c of cands) {
    if (!existsSync(path.join(c, "initdb"))) continue;
    const v = Number(/(\d+)/.exec(execFileSync(path.join(c, "initdb"), ["--version"]).toString())?.[1]);
    if (v >= 15) return c;
  }
  throw new Error("PostgreSQL 15+ not found (brew install postgresql@17, or set PGBIN)");
}
const PGBIN = pgBin();
const PGDIR = path.join(OUT, "pg");
const DB_URL = `postgres://postgres@127.0.0.1:${PORT.pg}/postgres`;
function psql(sql: string, file?: string): string {
  const a = ["-X", "-h", "127.0.0.1", "-p", String(PORT.pg), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-At"];
  return execFileSync(path.join(PGBIN, "psql"), [...a, ...(file ? ["-f", file] : ["-c", sql])], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const q1 = <T = any>(sql: string): T => JSON.parse(psql(`select coalesce((select row_to_json(x) from (${sql}) x limit 1)::text, 'null')`));
const qa = <T = any>(sql: string): T[] => JSON.parse(psql(`select coalesce((select json_agg(x) from (${sql}) x)::text, '[]')`));
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

// ── HTTP helpers ─────────────────────────────────────────────────────────────
async function asStaff(user: string, body: Record<string, unknown>) {
  const r = await fetch(BASE(PORT.admin), { method: "POST", headers: { authorization: `Bearer sim:${user}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
async function toWorker(p: string, payload: unknown, secret = SECRET.start) {
  const raw = JSON.stringify(payload);
  const r = await fetch(BASE(PORT.worker) + p, { method: "POST", headers: { "content-type": "application/json", "x-tr-signature": signBody(secret, raw) }, body: raw });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
}
async function waitJob(id: string, until: (s: string) => boolean, ms = 240_000) {
  const seen: string[] = [];
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const j = q1(`select status, error_code from sample_redaction_jobs where id = ${lit(id)}`);
    if (j && seen[seen.length - 1] !== j.status) seen.push(j.status);
    if (j && until(j.status)) return { ...j, seen };
    await sleep(250);
  }
  const j = q1(`select status, error_code from sample_redaction_jobs where id = ${lit(id)}`);
  return { ...j, seen, timedOut: true };
}
const filesUnder = (bucket: string, prefix: string): string[] => {
  const dir = path.join(STORAGE, bucket, prefix);
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const walk = (d: string, rel: string) => { for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f, `${rel}${n}/`); else out.push(`${rel}${n}`); } };
  walk(dir, "");
  return out.sort();
};

// ── leak checks (independent of the worker's own QA) ──────────────────────────
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
/** Every string inside a JSON value (or the text itself), joined: spoken values split over a words[] array still match. */
function textOf(raw: string): string {
  try {
    const out: string[] = [];
    const walk = (v: unknown) => { if (typeof v === "string") out.push(v); else if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") Object.values(v).forEach(walk); };
    walk(JSON.parse(raw));
    return norm(out.join(" "));
  } catch { return norm(raw); }
}
function leaksIn(text: string, m: Manifest): string[] {
  const t = ` ${text} `;
  return [...new Set(m.planted.map((p) => norm(p.text)).filter((v) => v.length >= 3 && t.includes(` ${v} `)))];
}
function audibleValues(file: string, m: Manifest, fromMs = 0, toMs = Infinity): string[] {
  const chans = decodeStereo(file);
  const words = wordsOf(m);
  const out: string[] = [];
  for (const p of m.planted) {
    const ws = plantedWords(m, words, p).filter((w) => w.start >= fromMs && w.end <= toMs);
    const heard = ws.filter((w) => toneShare(chans[w.ch], w.start - fromMs, w.end - fromMs) < BLEEPED);
    if (heard.length) out.push(`${p.kind} "${heard.map((w) => w.text).join(" ")}" @${heard[0].start}ms`);
  }
  return out;
}
// TERM (the carrier name) is configuration the AM types in on submit; it is stored on the job by design
/** Workflow World files: step inputs/outputs are base64 `devl…` (devalue JSON) or `zstd…` (compressed devl). */
function workflowText(raw: string): string {
  const out: string[] = [];
  const bytes = (b: Buffer): void => {
    const head = b.subarray(0, 4).toString("latin1");
    if (head === "zstd") return bytes(zstdDecompressSync(b.subarray(4)));
    if (head === "devl") return walk(JSON.parse(b.subarray(4).toString("utf8")));
    out.push(b.toString("utf8"));
  };
  const walk = (v: unknown): void => {
    if (typeof v === "string") out.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (o.__type === "Uint8Array" && typeof o.data === "string") return bytes(Buffer.from(o.data, "base64"));
      Object.values(o).forEach(walk);
    }
  };
  try { walk(JSON.parse(raw)); } catch { out.push(raw); }
  return norm(out.join(" "));
}
const PLANTED_TEXTS = (ms: Manifest[]) => [...new Set(ms.flatMap((m) => m.planted.filter((p) => p.kind !== "TERM").map((p) => norm(p.text)).filter((v) => v.length >= 4)))];

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`sample-redactor simulation · ${STAMP}\nout: ${path.relative(ROOT, OUT)}/  (logs, storage = every file TR would hold, report.md)`);

  sectionStart("setup");
  const fixtures = path.join(ROOT, "fixtures", "out");
  const missing = CALLS.filter((c) => !existsSync(path.join(fixtures, `${c}.mp3`)) || !existsSync(path.join(fixtures, `${c}.planted.json`)));
  if (missing.length) {
    console.log(`generating test calls: ${missing.join(", ")} (macOS say)`);
    execFileSync("npx", ["tsx", "scripts/make-test-calls.ts", ...missing], { cwd: ROOT, stdio: "inherit" });
  }
  const M = Object.fromEntries(CALLS.map((c) => [c, JSON.parse(readFileSync(path.join(fixtures, `${c}.planted.json`), "utf8")) as Manifest])) as Record<(typeof CALLS)[number], Manifest>;
  check("test calls ready", true, CALLS.map((c) => `${c} (${Math.round(M[c].total_ms / 1000)} s, ${M[c].planted.length} planted values)`).join(", "));

  if (!NO_BUILD || !existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
    execFileSync("npx", ["next", "build"], { cwd: ROOT, stdio: ["ignore", openSync(path.join(LOGS, "build.log"), "a"), openSync(path.join(LOGS, "build.log"), "a")] });
  }
  check("worker built (next build)", existsSync(path.join(ROOT, ".next", "BUILD_ID")));
  rmSync(WF_DATA, { recursive: true, force: true });   // no runs left over from an earlier simulation

  // Postgres with the real migrations
  execFileSync(path.join(PGBIN, "initdb"), ["-D", PGDIR, "-U", "postgres", "-A", "trust"], { stdio: "ignore" });
  // the Unix socket goes in a short temp dir: macOS caps socket paths at 103 bytes, and checkouts can be deep
  const SOCK = mkdtempSync(path.join(tmpdir(), "srpg-"));
  execFileSync(path.join(PGBIN, "pg_ctl"), ["-D", PGDIR, "-o", `-p ${PORT.pg} -c listen_addresses=127.0.0.1 -k ${SOCK}`, "-l", path.join(LOGS, "postgres.log"), "-w", "start"], { stdio: "ignore" });
  process.on("exit", () => {
    try { execFileSync(path.join(PGBIN, "pg_ctl"), ["-D", PGDIR, "-m", "immediate", "stop"], { stdio: "ignore" }); } catch { /* stopped */ }
    rmSync(SOCK, { recursive: true, force: true });
  });
  psql("", path.join(TR, "supabase/tests/training_library/_fixture.sql"));
  psql("", path.join(TR, "supabase/migrations/20261012180000_training_library.sql"));
  psql("", path.join(TR, "supabase/migrations/20261013090000_sample_redaction_worker.sql"));
  psql("", path.join(ROOT, "sim/seed.sql"));
  check("Postgres: RL-1 + worker migration applied", q1(`select count(*)::int n from pg_trigger where tgname in ('sample_redaction_jobs_service_columns','sample_redaction_takedown_guard')`).n === 2,
    "real migrations from truering/supabase/migrations on a throwaway cluster");

  // TR rows: one agent per test call (consent on file), the call with a Telnyx-style recording URL
  const fakes = new Fakes({ storageDir: STORAGE, signKey: SECRET.sign, fixturesDir: fixtures, base: () => BASE(PORT.fakes) });
  const callId: Record<string, string> = {}, recId: Record<string, string> = {}, agentId: Record<string, string> = {};
  for (const c of CALLS) {
    callId[c] = randomUUID(); recId[c] = randomUUID(); agentId[c] = randomUUID();
    const dur = Math.max(60, Math.round(M[c].total_ms / 1000));
    psql(`insert into agents (id, full_name) values (${lit(agentId[c])}, ${lit(M[c].agent)});
      insert into agent_training_consents (agent_id, consent_version, source) values (${lit(agentId[c])}, 'v1', 'offline');
      insert into calls (id, agent_id, duration, disposition_id, recording_url, caller_name, caller_number)
        values (${lit(callId[c])}, ${lit(agentId[c])}, ${dur}, (select id from call_dispositions where name = 'Sale'),
                ${lit(`https://s3.amazonaws.com/telephony-recorder-prod/${recId[c]}-1700000000.mp3`)}, ${lit(M[c].caller)}, '+15125550100');`);
    fakes.addRecording(recId[c], path.join(fixtures, `${c}.mp3`), M[c]);
  }
  // out-of-scope rows: a Twilio-era call, an agent without consent
  const twilioCall = randomUUID(), noConsentCall = randomUUID(), noConsentAgent = randomUUID();
  psql(`insert into agents (id, full_name) values (${lit(noConsentAgent)}, 'Pat Nobody');
    insert into calls (id, agent_id, duration, disposition_id, recording_url) values
      (${lit(twilioCall)}, ${lit(agentId[CALLS[0]])}, 300, (select id from call_dispositions where name = 'Sale'), 'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE0.mp3'),
      (${lit(noConsentCall)}, ${lit(noConsentAgent)}, 300, (select id from call_dispositions where name = 'Sale'), ${lit(`https://s3.amazonaws.com/telephony-recorder-prod/${randomUUID()}-1.mp3`)});`);

  const fakeServer = await fakes.listen(PORT.fakes);
  process.on("exit", () => fakeServer.close());

  const deno = ["-y", "deno@2.9.6", "run", "-A", "--no-lock", "--node-modules-dir=none", `--import-map=${path.join(ROOT, "sim/supabase/import_map.json")}`, path.join(ROOT, "sim/supabase/serve.ts")];
  const fnEnv = {
    SUPABASE_URL: "http://sim.invalid", SUPABASE_SERVICE_ROLE_KEY: "sim-service-role",
    SIM_DATABASE_URL: DB_URL, SIM_STORAGE_DIR: STORAGE, SIM_STORAGE_BASE: BASE(PORT.fakes), SIM_SIGN_KEY: SECRET.sign,
    SIM_TELNYX_BASE: `${BASE(PORT.fakes)}/telnyx`, TELNYX_API_KEY: "sim-telnyx",
    SAMPLE_JOB_CAP_USD: "2", SAMPLE_MONTH_CAP_USD: "100", SAMPLE_ASR_USD_PER_HOUR: "0.45",
  };
  startProc("bridge", "npx", [...deno, "sample-redaction-bridge", String(PORT.bridge)], { ...fnEnv, SAMPLE_REDACTOR_BRIDGE_SECRET: SECRET.bridge });
  startProc("admin", "npx", [...deno, "training-library-admin", String(PORT.admin)], { ...fnEnv, SAMPLE_REDACTOR_URL: BASE(PORT.worker), SAMPLE_REDACTOR_START_SECRET: SECRET.start });
  startProc("worker", process.execPath, [path.join(ROOT, "node_modules/next/dist/bin/next"), "start", "-p", String(PORT.worker), "-H", "127.0.0.1"], {
    NODE_OPTIONS: `--import ${path.join(ROOT, "sim/vendor-redirect.mjs")}`, SIM_VENDOR_BASE: BASE(PORT.fakes),
    PORT: String(PORT.worker), WORKFLOW_LOCAL_BASE_URL: BASE(PORT.worker), WORKFLOW_LOCAL_RECOVER_ACTIVE_RUNS: "0",
    TR_BRIDGE_URL: BASE(PORT.bridge), SAMPLE_REDACTOR_BRIDGE_SECRET: SECRET.bridge, SAMPLE_REDACTOR_START_SECRET: SECRET.start,
    ASSEMBLYAI_API_KEY: "sim-assemblyai", OPENROUTER_API_KEY: "sim-openrouter",
  });
  await waitFor("bridge (Deno)", BASE(PORT.bridge));
  await waitFor("training-library-admin (Deno)", BASE(PORT.admin));
  await waitFor("worker (next start)", `${BASE(PORT.worker)}/api/health`);
  const health = await (await fetch(`${BASE(PORT.worker)}/api/health`)).json();
  check("services up: bridge + training-library-admin (real code, Deno) · worker (next start)",
    health.ok && health.configured.bridge && health.configured.start_secret, `worker ${health.pipeline_version}, models ${JSON.stringify(health.models)}`);

  // ── 1. connection + auth ──
  sectionStart("1. connection and auth (TR ↔ worker, both directions)");
  {
    const bad = await toWorker("/api/jobs", { job_id: randomUUID(), idempotency_key: `call:${randomUUID()}:v1` }, "wrong-secret");
    check("worker refuses a start signed with the wrong secret", bad.status === 401, `HTTP ${bad.status}`);
    const raw = JSON.stringify({ action: "job", job_id: randomUUID() });
    const r = await fetch(BASE(PORT.bridge), { method: "POST", headers: { "x-tr-signature": signBody("wrong", raw) }, body: raw });
    check("bridge refuses a worker call signed with the wrong secret", r.status === 401, `HTTP ${r.status}`);
    const r2 = await fetch(BASE(PORT.bridge), { method: "POST", headers: { "x-tr-signature": signBody(SECRET.bridge, raw) }, body: raw });
    check("bridge accepts the worker's signature (unknown job → 404, not 401)", r2.status === 404, `HTTP ${r2.status}`);
    const noStaff = await asStaff("11111111-0000-0000-0000-0000000000a1", { action: "pick" });
    check("training-library-admin refuses a non-staff user", noStaff.status === 403, `${noStaff.status} ${noStaff.body.error_code}`);
  }

  // ── 2. AM curation rules ──
  sectionStart("2. what an AM can submit (flag, scope, consent)");
  const c1 = CALLS[0], c7 = CALLS[1], c9 = CALLS[2];
  const opts = { extra_terms: ["Mutual of Omaha"], customer_channel: M[c1].customer_channel };
  {
    const off = await asStaff(AM, { action: "submit", call_id: callId[c1], options: opts });
    check("flag recording_library OFF → submit refused", off.status === 403 && off.body.error_code === "FLAG_OFF", `${off.status} ${off.body.error_code}`);
    psql(`update feature_flags set enabled = true where key = 'recording_library'`);
    const pick = await asStaff(AM, { action: "pick", min_s: 60, max_s: 3600 });
    const ours = (pick.body.rows ?? []).filter((r: any) => Object.values(callId).includes(r.id));
    check("pick lists the Sale calls with a Telnyx recording, agent name and consent", ours.length === CALLS.length && ours.every((r: any) => r.consent && r.agent_name),
      `${pick.body.rows?.length ?? 0} rows; Twilio call listed: ${(pick.body.rows ?? []).some((r: any) => r.id === twilioCall)}`);
    const tw = await asStaff(AM, { action: "submit", call_id: twilioCall, options: opts });
    check("Twilio-era recording → refused", tw.status === 422 && tw.body.error_code === "OUT_OF_SCOPE", `${tw.status} ${tw.body.error_code}`);
    const nc = await asStaff(AM, { action: "submit", call_id: noConsentCall, options: opts });
    check("agent without training consent → refused", nc.status === 422 && nc.body.error_code === "NO_CONSENT", `${nc.status} ${nc.body.error_code}`);
    // month cap: a job that already spent $99.90 this month
    const spent = randomUUID();
    psql(`insert into sample_redaction_jobs (id, call_id, version, idempotency_key, status, cost_usd, reserved_usd, completed_at)
          values (${lit(spent)}, 'cccccccc-0000-0000-0000-000000000003', 1, 'call:cccccccc-0000-0000-0000-000000000003:v1', 'done', 99.9, 0, now())`);
    const cap = await asStaff(AM, { action: "submit", call_id: callId[c1], options: opts });
    const logged = q1(`select count(*)::int n from security_activity_log where event_type = 'sample_cost_cap_blocked'`).n;
    check("$100/month cap → submit refused and the ops alert event logged", cap.status === 402 && cap.body.error_code === "COST_CAP" && logged >= 1, `${cap.status} ${cap.body.error_code}, alert events ${logged}`);
    psql(`delete from sample_redaction_jobs where id = ${lit(spent)}`);
  }

  // ── 3. the happy path ──
  sectionStart(`3. ${c1}: AM submits → worker redacts → library draft`);
  const sub = await asStaff(AM, { action: "submit", call_id: callId[c1], options: opts });
  check("submit accepted; worker run started", sub.status === 200 && !!sub.body.run_id, `${sub.status} job ${sub.body.job_id ?? "-"} key ${sub.body.idempotency_key ?? "-"} reserved $${sub.body.reserved_usd ?? "-"}`);
  const job1 = String(sub.body.job_id);
  const again = await asStaff(AM, { action: "submit", call_id: callId[c1], options: opts });
  check("submitting the same call again does nothing twice", again.status === 200 && again.body.existing === true && again.body.job_id === job1, `${again.status} existing=${again.body.existing}`);
  const w1 = await waitJob(job1, (s) => s === "done" || s === "failed");
  check("job reached done", w1.status === "done", `stages seen: ${w1.seen.join(" → ")}${w1.error_code ? ` (${w1.error_code})` : ""}${w1.timedOut ? " TIMED OUT" : ""}`);
  await verifyDone(job1, M[c1], fakes);

  // ── 4. duplicates and a forged pairing ──
  sectionStart(`4. ${c9}: wrong key, then the same start delivered twice (job row with sparse options: worker defaults)`);
  const ins = JSON.parse(psql(`set role service_role; select public.sample_job_insert(${lit(callId[c9])}, 1, ${lit(JSON.stringify({ customer_channel: M[c9].customer_channel }))}::jsonb,
      ${lit(JSON.stringify({ duration_s: Math.round(M[c9].total_ms / 1000), vertical: "final_expense", channel_map: { customer: M[c9].customer_channel, agent: 1 - M[c9].customer_channel, verified: false } }))}::jsonb, ${lit(AM)}, 0.3, 100)`).split("\n").pop()!);
  const job9 = String(ins.job_id);
  {
    const wrong = await toWorker("/api/jobs", { job_id: job9, idempotency_key: `call:${callId[c1]}:v1` });
    await sleep(4000);
    const j = q1(`select status, workflow_run_id from sample_redaction_jobs where id = ${lit(job9)}`);
    check("signed start pairing this job with another call's key → job untouched", wrong.status === 202 && j.status === "queued" && !j.workflow_run_id,
      `worker ${wrong.status}; job still ${j.status}, owner ${j.workflow_run_id ?? "none"}`);
    const [a, b] = await Promise.all([
      toWorker("/api/jobs", { job_id: job9, idempotency_key: ins.idempotency_key }),
      toWorker("/api/jobs", { job_id: job9, idempotency_key: ins.idempotency_key }),
    ]);
    check("the same start delivered twice → two runs started", a.status === 202 && b.status === 202 && a.body.run_id !== b.body.run_id, `${a.body.run_id} / ${b.body.run_id}`);
    const w9 = await waitJob(job9, (s) => s === "done" || s === "failed");
    check("job reached done", w9.status === "done", `stages seen: ${w9.seen.join(" → ")}${w9.error_code ? ` (${w9.error_code})` : ""}`);
    const owner = q1(`select workflow_run_id from sample_redaction_jobs where id = ${lit(job9)}`).workflow_run_id;
    const asr = [...fakes.transcripts.values()].filter((t) => t.job === job9);
    check("exactly one run did the work (one owner, 2 transcriptions, 1 library row)",
      [a.body.run_id, b.body.run_id].includes(owner) && asr.length === 2 && q1(`select count(*)::int n from training_library_calls where job_id = ${lit(job9)}`).n === 1,
      `owner ${owner}; AssemblyAI jobs ${asr.length}`);
    await verifyDone(job9, M[c9], fakes);
  }

  // ── 5. recording gone, then retry ──
  sectionStart(`5. ${c7}: Telnyx no longer has the recording, then retry`);
  fakes.telnyx.expired.add(recId[c7]);
  const sub7 = await asStaff(AM, { action: "submit", call_id: callId[c7], options: { ...opts, extra_terms: [] } });
  const job7 = String(sub7.body.job_id);
  const w7 = await waitJob(job7, (s) => s === "done" || s === "failed");
  check("job failed with fetch_expired", w7.status === "failed" && w7.error_code === "fetch_expired", `stages seen: ${w7.seen.join(" → ")} (${w7.error_code})`);
  await sleep(1500);
  check("nothing left behind (scratch + library prefixes empty, no transcription)",
    !filesUnder("sample-src", job7).length && !filesUnder("training-library", job7).length && ![...fakes.transcripts.values()].some((t) => t.job === job7));
  fakes.telnyx.expired.delete(recId[c7]);
  const retry = await asStaff(AM, { action: "retry", job_id: job7 });
  check("AM retry accepted (same key, restarted)", retry.status === 200, `${retry.status} ${JSON.stringify(retry.body).slice(0, 120)}`);
  const w7b = await waitJob(job7, (s) => s === "done" || s === "failed");
  check("retried job reached done", w7b.status === "done", `stages seen: ${w7b.seen.join(" → ")}${w7b.error_code ? ` (${w7b.error_code})` : ""}`);
  await verifyDone(job7, M[c7], fakes);

  // ── 6. QA, approve, publish ──
  sectionStart(`6. ${c1}: AM QA → approve → publish`);
  const lib1 = q1(`select id, status from training_library_calls where job_id = ${lit(job1)}`);
  {
    const early = await asStaff(AM, { action: "review", library_call_id: lib1.id, decision: "approve", listened_full: true });
    check("approve before listening to the call and every clip → refused", early.status >= 400, `${early.status} ${early.body.error_code}`);
    const audio = await asStaff(AM, { action: "link", library_call_id: lib1.id, artifact: "audio" });
    const got = audio.body.url ? await fetch(audio.body.url) : null;
    check("link: signed URL for the redacted call plays", !!got && got.ok && Number(got.headers.get("content-length") ?? (await got.arrayBuffer()).byteLength) > 1000, `${audio.status}`);
    const clips = qa(`select id from training_library_clips where library_call_id = ${lit(lib1.id)} and audio_exported`);
    let clipOk = true;
    for (const c of clips) {
      const l = await asStaff(AM, { action: "link", library_call_id: lib1.id, artifact: `clip:${c.id}` });
      clipOk &&= !!l.body.url && (await fetch(l.body.url)).ok;
    }
    check(`link: every exported clip (${clips.length}) plays`, clipOk && clips.length > 0);
    const ok = await asStaff(AM, { action: "review", library_call_id: lib1.id, decision: "approve", listened_full: true, notes: "sim: listened" });
    check("approve after listening → accepted", ok.status === 200, `${ok.status} ${ok.body.error_code ?? ""}`);
    const pub = await asStaff(AM, { action: "publish", library_call_id: lib1.id });
    const st = q1(`select status from training_library_calls where id = ${lit(lib1.id)}`).status;
    check("publish → published", pub.status === 200 && st === "published", `${pub.status} ${pub.body.error_code ?? ""} status ${st}`);
  }

  // ── 7. takedown ──
  sectionStart(`7. ${c1}: delete every copy`);
  {
    const del = await asStaff(ADMIN, { action: "delete", call_id: callId[c1] });
    const j = q1(`select status, deleted_at, delete_requested_at from sample_redaction_jobs where id = ${lit(job1)}`);
    check("delete → 200 and the job is 'deleted' (worker confirmed)", del.status === 200 && j.status === "deleted" && !!j.deleted_at, `${del.status} ${del.body.error_code ?? ""} job ${j.status}`);
    check("TR copies gone (both buckets)", !filesUnder("sample-src", job1).length && !filesUnder("training-library", job1).length,
      `left: ${[...filesUnder("sample-src", job1), ...filesUnder("training-library", job1)].join(", ") || "none"}`);
    const l = q1(`select status, audio_path, coaching::text c from training_library_calls where job_id = ${lit(job1)}`);
    const cl = q1(`select count(*)::int n from training_library_clips where library_call_id = ${lit(lib1.id)} and (audio_path is not null or coaching::text <> '{}')`);
    check("library row withdrawn and emptied (audio paths + generated text)", l.status === "withdrawn" && !l.audio_path && l.c === "{}" && cl.n === 0, `status ${l.status}`);
    const asr = [...fakes.transcripts.values()].filter((t) => t.job === job1);
    check("AssemblyAI copies deleted", asr.length > 0 && asr.every((t) => fakes.deleted.has(t.id)), `${asr.filter((t) => fakes.deleted.has(t.id)).length}/${asr.length}`);
    const re = await asStaff(AM, { action: "submit", call_id: callId[c1], options: opts, reprocess: true });
    check("the call cannot be sampled again", re.status === 409 && re.body.error_code === "DELETED", `${re.status} ${re.body.error_code}`);
    const raw = JSON.stringify({ action: "job", job_id: job1 });
    const br = await fetch(BASE(PORT.bridge), { method: "POST", headers: { "x-tr-signature": signBody(SECRET.bridge, raw) }, body: raw });
    check("bridge refuses the worker on a deleted job", br.status === 409, `HTTP ${br.status}`);
  }

  // ── 8. privacy ──
  sectionStart("8. privacy: where personal data could end up");
  {
    const values = PLANTED_TEXTS(Object.values(M));
    const scan = (label: string, text: string) => { const hits = values.filter((v) => ` ${text} `.includes(` ${v} `)); return check(label, hits.length === 0, hits.length ? `found: ${hits.slice(0, 5).join(" | ")}` : `${values.length} planted values searched`); };
    for (const n of ["worker", "bridge", "admin"]) scan(`${n} logs hold no planted value`, norm(readFileSync(path.join(LOGS, `${n}.log`), "utf8")));
    const wfText: string[] = [];
    const walk = (d: string) => { if (!existsSync(d)) return; for (const n of readdirSync(d)) { const f = path.join(d, n); if (statSync(f).isDirectory()) walk(f); else if (f.endsWith(".json")) wfText.push(workflowText(readFileSync(f, "utf8"))); } };
    walk(WF_DATA);
    const wfAll = wfText.join(" ");
    // retention 0 (lib/config.ts RUN_OPTIONS): a finished run keeps ids, timestamps and status, but no payloads
    const runsDir = path.join(WF_DATA, "runs");
    const runs = existsSync(runsDir) ? readdirSync(runsDir).map((f) => JSON.parse(readFileSync(path.join(runsDir, f), "utf8"))) : [];
    const payloadsOf = (runId: string) => {
      let n = 0;
      const count = (d: string) => { for (const x of readdirSync(d)) { const f = path.join(d, x); if (statSync(f).isDirectory()) count(f); else if (x.includes(runId)) n += (readFileSync(f, "utf8").match(/"__type":\s*"Uint8Array"/g) ?? []).length; } };
      count(WF_DATA);
      return n;
    };
    const finished = runs.filter((r) => ["completed", "failed", "cancelled"].includes(r.status));
    const kept = finished.filter((r) => payloadsOf(r.runId) > 0);
    check(`Workflow retention 0: every run asks for it, and the ${finished.length} finished runs keep no payloads`,
      runs.length > 0 && runs.every((r) => r.attributes?.$retention === "0") && finished.length > 0 && kept.length === 0,
      `${runs.length} runs; payloads left only on ${runs.length - finished.length} still-running (sleeping purgeLater) runs`);
    // positive control: the decoder must see what IS in there (job ids), or "nothing found" proves nothing
    check(`Workflow event log decoded (${wfText.length} files; job ids visible in the still-running runs)`, wfText.length > 0 && wfAll.includes(norm(job1)) && wfAll.includes(norm(job9)));
    scan("Workflow event log holds no planted value (step inputs/outputs decoded)", wfAll);
    cpSync(WF_DATA, path.join(OUT, "workflow-data"), { recursive: true });
    const dump = execFileSync(path.join(PGBIN, "pg_dump"), ["-h", "127.0.0.1", "-p", String(PORT.pg), "-U", "postgres", "--data-only", "-T", "public.calls", "-T", "public.agents", "postgres"], { encoding: "utf8", maxBuffer: 1 << 28 });
    scan("database (every table except TR's own calls/agents rows) holds no planted value", norm(dump));
  }

  // ── report ──
  const pass = rows.filter((r) => r.ok).length, fail = rows.length - pass;
  const md = [
    `# Sample redactor — end-to-end simulation ${STAMP}`,
    "",
    `- worker ${PIPELINE_VERSION}, schema ${SCHEMA_VERSION}; ${Math.round((Date.now() - t0) / 1000)} s`,
    "- real: worker (next start + local Workflow World), training-library-admin + sample-redaction-bridge (Deno), RL-1 + worker migrations (Postgres)",
    "- faked: Supabase HTTP layer, Telnyx, AssemblyAI (verification pass listens to the redacted mp3), OpenRouter",
    "- live systems touched: none · values in the calls: fictional",
    "",
    `**${pass} passed, ${fail} failed**`,
    "",
    "| | check | detail |",
    "|---|---|---|",
    ...rows.map((r, i) => (i === 0 || rows[i - 1].section !== r.section ? `| | **${r.section}** | |\n` : "") + `| ${r.ok ? "PASS" : "**FAIL**"} | ${r.name} | ${r.detail.replace(/\|/g, "\\|")} |`),
    "",
    `Listen: \`${path.relative(ROOT, STORAGE)}/training-library/<job_id>/redacted.mp3\` and \`clips/cN.mp3\` (the deleted call's files are gone by design).`,
    `Logs: \`${path.relative(ROOT, LOGS)}/\`.`,
  ].join("\n");
  writeFileSync(path.join(OUT, "report.md"), md + "\n");
  console.log(`\n${pass} passed, ${fail} failed · report: ${path.relative(ROOT, path.join(OUT, "report.md"))}`);
  if (KEEP) { console.log("--keep: servers still running; Ctrl-C to stop"); await new Promise(() => {}); }
  process.exitCode = fail ? 1 : 0;
}

/** Everything a finished job must have, checked from TR's side (DB + storage) and by listening to the audio. */
async function verifyDone(job: string, m: Manifest, fakes: Fakes) {
  const j = q1(`select status, cost_usd, reserved_usd, pipeline_version, schema_version, qa_flag, qa_reasons, metrics->'cost_items' items from sample_redaction_jobs where id = ${lit(job)}`);
  if (j?.status !== "done") return check("(skipped: job not done)", false);
  const lib = q1(`select id, status, audio_path, coaching from training_library_calls where job_id = ${lit(job)}`);
  check("library row created, waiting for QA; job carries pipeline + schema versions",
    !!lib && lib.status === "pending_qa" && j.pipeline_version === PIPELINE_VERSION && j.schema_version === SCHEMA_VERSION,
    lib ? `status ${lib.status}, ${j.pipeline_version}, schema ${j.schema_version}` : "no row");
  const clips = qa(`select clip_key, label, sub_label, start_ms, end_ms, audio_exported, audio_path from training_library_clips where library_call_id = ${lit(lib?.id ?? randomUUID())} order by sort_order`);
  const labelsOk = clips.every((c) => (CLIP_LABELS as readonly string[]).includes(c.label));
  const noAudioOk = clips.every((c) => (NO_AUDIO_LABELS as readonly string[]).includes(c.label) ? !c.audio_exported && !c.audio_path : c.audio_exported);
  check("clips: ≤6, fixed labels, 'application' labelled but never exported", clips.length > 0 && clips.length <= 6 && labelsOk && noAudioOk,
    clips.map((c) => `${c.clip_key} ${c.label}${c.sub_label ? `/${c.sub_label}` : ""} ${Math.round(c.start_ms / 1000)}–${Math.round(c.end_ms / 1000)}s${c.audio_exported ? "" : " (no audio)"}`).join(", "));
  const coach = lib?.coaching ?? {};
  check("call coaching: summary, 3 strengths, 3 improvements, rubric fe_v1", !!coach.summary && coach.strengths?.length === 3 && coach.improvements?.length === 3 && coach.rubric === "fe_v1");
  const files = filesUnder("training-library", job);
  const want = ["redacted.mp3", "transcript.json", "pii_spans.json", "clips.json", "coaching.json"];
  check("artifacts in training-library/<job_id>/ (TR's bucket)", want.every((f) => files.includes(f)), files.join(", "));
  check("scratch copies in sample-src/<job_id>/ deleted", filesUnder("sample-src", job).length === 0, filesUnder("sample-src", job).join(", ") || "empty");
  const asr = [...fakes.transcripts.values()].filter((t) => t.job === job);
  // the job turns done one step before purgeAsr runs: give that step its moment
  for (let i = 0; i < 60 && !asr.every((t) => fakes.deleted.has(t.id)); i++) await sleep(250);
  check("AssemblyAI copies deleted when the job finished", asr.length >= 2 && asr.every((t) => fakes.deleted.has(t.id)), `${asr.filter((t) => fakes.deleted.has(t.id)).length}/${asr.length} deleted`);
  check("cost recorded once per item, under the $2 job cap", j.cost_usd > 0 && j.cost_usd <= 2 && Object.keys(j.items ?? {}).length > 0, `$${j.cost_usd} (${Object.keys(j.items ?? {}).length} items)`);

  // listen: every planted value under the bleep tone, in the full call and in every exported clip
  const red = path.join(STORAGE, "training-library", job, "redacted.mp3");
  // control: the same listener on the ORIGINAL recording must hear every planted value
  const original = audibleValues(path.join(ROOT, "fixtures", "out", `${m.name}.mp3`), m);
  check("control: the listener hears every planted value in the original recording", original.length === m.planted.length, `${original.length}/${m.planted.length}`);
  const heard = audibleValues(red, m);
  check(`audio: all ${m.planted.length} planted values bleeped in the redacted call`, heard.length === 0, heard.slice(0, 4).join("; ") || "1 kHz tone over every planted word");
  let clipLeaks: string[] = [];
  for (const c of clips.filter((x) => x.audio_exported)) {
    const f = path.join(STORAGE, "training-library", c.audio_path);
    if (!existsSync(f)) { clipLeaks.push(`${c.clip_key}: file missing`); continue; }
    clipLeaks = clipLeaks.concat(audibleValues(f, m, c.start_ms, c.end_ms).map((x) => `${c.clip_key}: ${x}`));
  }
  check("audio: no planted value audible in any exported clip", clipLeaks.length === 0, clipLeaks.slice(0, 4).join("; ") || `${clips.filter((x) => x.audio_exported).length} clips listened to`);
  // text: no planted value in any artifact TR stores
  const textLeaks = files.filter((f) => /\.(json|txt)$/.test(f)).flatMap((f) => leaksIn(textOf(readFileSync(path.join(STORAGE, "training-library", job, f), "utf8")), m).map((v) => `${f}: ${v}`));
  const dbLeaks = leaksIn(textOf(JSON.stringify([coach, clips])), m);
  check("text: no planted value in transcripts, spans, clips or coaching (files + DB)", !textLeaks.length && !dbLeaks.length, [...textLeaks, ...dbLeaks].slice(0, 4).join("; ") || "clean");
  check("worker's own second pass agrees (no leak reasons)", !(j.qa_reasons ?? []).some((r: string) => r.startsWith("second_pass")),
    `qa_flag ${j.qa_flag}; reasons: ${(j.qa_reasons ?? []).join(", ") || "none"}`);
}

main().catch((e) => {
  console.error(`\nsimulation aborted: ${e instanceof Error ? e.message : String(e)}`);
  try { writeFileSync(path.join(OUT, "report.md"), `# simulation aborted\n\n${String(e?.stack ?? e)}\n`); } catch { /* ignore */ }
  process.exitCode = 2;
}).finally(() => { if (!KEEP) { stopAll(); setTimeout(() => process.exit(process.exitCode ?? 0), 500); } });
