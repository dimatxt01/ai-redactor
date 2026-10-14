// `npm run simulate` — the whole system on this machine, the way it will run in production:
//
//   AM (this script) ─► training-library-admin ─► Postgres ◄── sample-redaction-bridge ◄── poll ── worker A, worker B
//        REAL TR edge function (Deno)             REAL migrations   REAL TR edge function (Deno)   REAL workers (node src/worker.ts)
//
// TR never calls the worker: submit queues a job, the two workers race for it through the bridge (claim CAS).
// Faked: only what lives outside both repos — Supabase's HTTP layer (fake-supabase.ts: same queries, on a throwaway
// local Postgres with the RL-1 + worker migrations; storage on disk), Telnyx, AssemblyAI, OpenRouter (fakes.ts).
// The fake transcriber LISTENS to the redacted audio for the verification pass, so a value the worker failed
// to bleep stays audible and is caught exactly as it would be in production.
//
// Touches nothing live: no Supabase project, no vendor, no keys. Every value in the calls is fictional.
//   npm run simulate                 # run every scenario, write sim-out/<time>/report.md
//   npm run simulate -- --keep       # leave the servers running at the end (Ctrl-C to stop)
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { signBody } from "../lib/signature";
import { CLIP_LABELS, NO_AUDIO_LABELS, PIPELINE_VERSION, SCHEMA_VERSION } from "../lib/config";
import { BLEEPED, bleepShare, decodeStereo, Fakes, plantedWords, wordsOf, type Manifest } from "./fakes";

const ROOT = path.resolve(import.meta.dirname, "..");
const TR = path.join(ROOT, "truering");
const args = process.argv.slice(2);
const KEEP = args.includes("--keep");
const STAMP = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-");
const OUT = path.join(ROOT, "sim-out", STAMP);
const LOGS = path.join(OUT, "logs");
const STORAGE = path.join(OUT, "storage");
mkdirSync(LOGS, { recursive: true });
mkdirSync(STORAGE, { recursive: true });

const PORT = { pg: 5491, bridge: 3231, admin: 3232, fakes: 3233 };
const STALE_S = 6;   // the bridge's "worker stopped responding" window (production: 300 s), short so the crash scenario is quick
const BASE = (p: number) => `http://127.0.0.1:${p}`;
const SECRET = { bridge: `sim-bridge-${randomBytes(16).toString("hex")}`, sign: randomBytes(32).toString("hex") };
const AM = "22222222-0000-0000-0000-0000000000a3";      // account_manager in the RL-1 fixture
const ADMIN = "22222222-0000-0000-0000-0000000000ad";   // admin in the RL-1 fixture
const CALLS = ["01-classic-sale", "07-bank-and-card", "09-objections"] as const;
// extra TR calls reusing a test call's recording (and its agent's name, which the audio says): a cancel mid-run,
// and a worker crash mid-run on a MEDICARE agent's call (every vertical is in scope; the coaching prompt follows it)
const EXTRA = [
  { key: "cancel", fixture: "09-objections", verticals: "{final_expense}" },
  { key: "crash", fixture: "01-classic-sale", verticals: "{medicare}" },
] as const;

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
    try { const r = await fetch(url, { method: "POST", body: "{}" }); if (r.status < 500) return; } catch { /* not up */ }
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
const logOf = (name: string) => { try { return readFileSync(path.join(LOGS, `${name}.log`), "utf8"); } catch { return ""; } };
async function waitLog(name: string, needle: string, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (logOf(name).includes(needle)) return true; await sleep(250); }
  return false;
}
/** which worker process owns this job: the one whose run won the bridge's claim (both may try) */
const ownerOf = (job: string) => ["worker-a", "worker-b"].find((w) => logOf(w).includes(`"event":"job_claimed","job_id":"${job}"`));
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
    const heard = ws.filter((w) => bleepShare(chans[w.ch], w.start - fromMs, w.end - fromMs) < BLEEPED);
    if (heard.length) out.push(`${p.kind} "${heard.map((w) => w.text).join(" ")}" @${heard[0].start}ms`);
  }
  return out;
}
// TERM (the carrier name) is configuration the AM types in on submit; it is stored on the job by design
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
  check("Postgres: RL-1 + worker migration applied", q1(`select count(*)::int n from pg_proc where proname in ('sample_call_hard_delete','sample_call_delete_blockers','sample_library_ingest')`).n === 3,
    "real migrations from truering/supabase/migrations on a throwaway cluster");

  // TR rows: one agent per test call, the ended Sale call with a Telnyx-style recording URL
  const fakes = new Fakes({ storageDir: STORAGE, signKey: SECRET.sign, fixturesDir: fixtures, base: () => BASE(PORT.fakes) });
  const callId: Record<string, string> = {}, recId: Record<string, string> = {}, agentId: Record<string, string> = {};
  for (const c of CALLS) {
    callId[c] = randomUUID(); recId[c] = randomUUID(); agentId[c] = randomUUID();
    const dur = Math.max(60, Math.round(M[c].total_ms / 1000));
    psql(`insert into agents (id, full_name) values (${lit(agentId[c])}, ${lit(M[c].agent)});
      insert into calls (id, agent_id, duration, disposition_id, status, ended_at, recording_url, caller_name, caller_number)
        values (${lit(callId[c])}, ${lit(agentId[c])}, ${dur}, (select id from call_dispositions where name = 'Sale'), 'completed', now(),
                ${lit(`https://s3.amazonaws.com/telephony-recorder-prod/${recId[c]}-1700000000.mp3`)}, ${lit(M[c].caller)}, '+15125550100');`);
    fakes.addRecording(recId[c], path.join(fixtures, `${c}.mp3`), M[c]);
  }
  for (const x of EXTRA) {
    callId[x.key] = randomUUID(); recId[x.key] = randomUUID(); agentId[x.key] = randomUUID();
    psql(`insert into agents (id, full_name, verticals) values (${lit(agentId[x.key])}, ${lit(M[x.fixture].agent)}, ${lit(x.verticals)});
      insert into calls (id, agent_id, duration, disposition_id, status, ended_at, recording_url, caller_name, caller_number)
        values (${lit(callId[x.key])}, ${lit(agentId[x.key])}, ${Math.max(60, Math.round(M[x.fixture].total_ms / 1000))}, (select id from call_dispositions where name = 'Sale'), 'completed', now(),
                ${lit(`https://s3.amazonaws.com/telephony-recorder-prod/${recId[x.key]}-1700000001.mp3`)}, ${lit(M[x.fixture].caller)}, '+15125550100');`);
    fakes.addRecording(recId[x.key], path.join(fixtures, `${x.fixture}.mp3`), M[x.fixture]);
  }
  // out-of-scope rows: a Twilio-era call, a call still in progress, agents with two verticals / none
  const twilioCall = randomUUID(), liveCall = randomUUID(), twoVertCall = randomUUID(), noVertCall = randomUUID();
  const twoVertAgent = randomUUID(), noVertAgent = randomUUID();
  const sale = `(select id from call_dispositions where name = 'Sale')`;
  const telnyx = () => lit(`https://s3.amazonaws.com/telephony-recorder-prod/${randomUUID()}-1.mp3`);
  psql(`insert into agents (id, full_name, verticals) values (${lit(twoVertAgent)}, 'Pat Twofold', '{final_expense,medicare}'), (${lit(noVertAgent)}, 'Sam Nowhere', '{}');
    insert into calls (id, agent_id, duration, disposition_id, status, ended_at, recording_url) values
      (${lit(twilioCall)}, ${lit(agentId[CALLS[0]])}, 300, ${sale}, 'completed', now(), 'https://api.twilio.com/2010-04-01/Accounts/AC0/Recordings/RE0.mp3'),
      (${lit(liveCall)}, ${lit(agentId[CALLS[0]])}, 300, ${sale}, 'in_progress', null, ${telnyx()}),
      (${lit(twoVertCall)}, ${lit(twoVertAgent)}, 300, ${sale}, 'completed', now(), ${telnyx()}),
      (${lit(noVertCall)}, ${lit(noVertAgent)}, 300, ${sale}, 'completed', now(), ${telnyx()});`);

  const fakeServer = await fakes.listen(PORT.fakes);
  process.on("exit", () => fakeServer.close());

  const deno = ["-y", "deno@2.9.6", "run", "-A", "--no-lock", "--node-modules-dir=none", `--import-map=${path.join(ROOT, "sim/supabase/import_map.json")}`, path.join(ROOT, "sim/supabase/serve.ts")];
  const fnEnv = {
    SUPABASE_URL: "http://sim.invalid", SUPABASE_SERVICE_ROLE_KEY: "sim-service-role",
    SIM_DATABASE_URL: DB_URL, SIM_STORAGE_DIR: STORAGE, SIM_STORAGE_BASE: BASE(PORT.fakes), SIM_SIGN_KEY: SECRET.sign,
    SIM_TELNYX_BASE: `${BASE(PORT.fakes)}/telnyx`, TELNYX_API_KEY: "sim-telnyx",
    SAMPLE_JOB_CAP_USD: "2", SAMPLE_MONTH_CAP_USD: "100", SAMPLE_ASR_USD_PER_HOUR: "0.45",
  };
  startProc("bridge", "npx", [...deno, "sample-redaction-bridge", String(PORT.bridge)], { ...fnEnv, SAMPLE_REDACTOR_BRIDGE_SECRET: SECRET.bridge, SAMPLE_WORKER_STALE_S: String(STALE_S) });
  startProc("admin", "npx", [...deno, "training-library-admin", String(PORT.admin)], { ...fnEnv, SAMPLE_WORKER_STALE_S: String(STALE_S) });
  await waitFor("bridge (Deno)", BASE(PORT.bridge));
  await waitFor("training-library-admin (Deno)", BASE(PORT.admin));
  // two worker processes, as during a deploy rollover: they race for every job
  const workerEnv = (name: string, secret = SECRET.bridge) => {
    const tmp = path.join(OUT, `tmp-${name}`);
    mkdirSync(tmp, { recursive: true });
    return {
      NODE_OPTIONS: `--import ${path.join(ROOT, "sim/vendor-redirect.mjs")}`, SIM_VENDOR_BASE: BASE(PORT.fakes),
      TR_BRIDGE_URL: BASE(PORT.bridge), SAMPLE_REDACTOR_BRIDGE_SECRET: secret,
      ASSEMBLYAI_API_KEY: "sim-assemblyai", OPENROUTER_API_KEY: "sim-openrouter",
      POLL_S: "2", ASR_POLL_S: "1", WORKER_CONCURRENCY: "2", TMPDIR: tmp, ALIVE_FILE: path.join(OUT, `alive-${name}`),
      // orphan sweep: production 2 h 15 m; here 40 s, still longer than any simulated job lives
      ORPHAN_AGE_S: "40", ORPHAN_SWEEP_S: "5",
    };
  };
  const startWorker = (name: string, secret?: string) => startProc(name, process.execPath, ["--import", "tsx", path.join(ROOT, "src/worker.ts")], workerEnv(name, secret));
  const workers: Record<string, ChildProcess> = { "worker-a": startWorker("worker-a"), "worker-b": startWorker("worker-b") };
  const up = (await waitLog("worker-a", '"event":"worker_up"')) && (await waitLog("worker-b", '"event":"worker_up"'));
  check("services up: bridge + training-library-admin (real code, Deno) · 2 workers (node src/worker.ts)", up,
    up ? `${/"ffmpeg":"([^"]*)"/.exec(logOf("worker-a"))?.[1] ?? "?"} · ${/"pipeline":"([^"]*)"/.exec(logOf("worker-a"))?.[1] ?? "?"} · no port opened` : "a worker did not start; see logs");

  // ── 1. connection + auth ──  // ── 1. connection + auth ──
  sectionStart("1. connection and auth (worker → bridge is the only connection)");
  {
    const wrong = startWorker("worker-wrong-secret", "not-the-bridge-secret");
    const exit = await new Promise<number | null>((r) => { wrong.on("exit", (c) => r(c)); setTimeout(() => r(-1), 30_000); });
    check("a worker with the wrong bridge secret refuses to start", exit === 1 && logOf("worker-wrong-secret").includes('"event":"worker_refused_to_start"'), `exit ${exit}`);
    const raw = JSON.stringify({ action: "job", job_id: randomUUID() });
    const r = await fetch(BASE(PORT.bridge), { method: "POST", headers: { "x-tr-signature": signBody("wrong", raw) }, body: raw });
    check("bridge refuses a worker call signed with the wrong secret", r.status === 401, `HTTP ${r.status}`);
    const r2 = await fetch(BASE(PORT.bridge), { method: "POST", headers: { "x-tr-signature": signBody(SECRET.bridge, raw) }, body: raw });
    check("bridge accepts the worker's signature (unknown job → 404, not 401)", r2.status === 404, `HTTP ${r2.status}`);
    const noStaff = await asStaff("11111111-0000-0000-0000-0000000000a1", { action: "pick" });
    check("training-library-admin refuses a non-staff user", noStaff.status === 403, `${noStaff.status} ${noStaff.body.error_code}`);
  }

  // ── 2. AM curation rules ──
  sectionStart("2. what an AM can submit (flag, scope, vertical; no consent gate)");
  const c1 = CALLS[0], c7 = CALLS[1], c9 = CALLS[2];
  const opts = { extra_terms: ["Mutual of Omaha"], customer_channel: M[c1].customer_channel };
  {
    const off = await asStaff(AM, { action: "submit", call_id: callId[c1], options: opts });
    check("flag recording_library OFF → submit refused", off.status === 403 && off.body.error_code === "FLAG_OFF", `${off.status} ${off.body.error_code}`);
    psql(`update feature_flags set enabled = true where key = 'recording_library'`);
    const pick = await asStaff(AM, { action: "pick", min_s: 60, max_s: 3600 });
    const ours = (pick.body.rows ?? []).filter((r: any) => Object.values(callId).includes(r.id));
    check("pick lists the ended Sale calls with a Telnyx recording, agent name and vertical", ours.length === Object.keys(callId).length && ours.every((r: any) => r.agent_name && r.vertical),
      `${pick.body.rows?.length ?? 0} rows (verticals: ${[...new Set(ours.map((r: any) => r.vertical))].join(", ")}); Twilio call listed: ${(pick.body.rows ?? []).some((r: any) => r.id === twilioCall)}; live call listed: ${(pick.body.rows ?? []).some((r: any) => r.id === liveCall)}`);
    const tw = await asStaff(AM, { action: "submit", call_id: twilioCall, options: opts });
    check("Twilio-era recording → refused", tw.status === 422 && tw.body.error_code === "OUT_OF_SCOPE", `${tw.status} ${tw.body.error_code}`);
    const lv = await asStaff(AM, { action: "submit", call_id: liveCall, options: opts });
    check("a call that has not ended → refused", lv.status === 422 && lv.body.error_code === "NOT_ENDED", `${lv.status} ${lv.body.error_code}`);
    const tv = await asStaff(AM, { action: "submit", call_id: twoVertCall, options: opts });
    const nv = await asStaff(AM, { action: "submit", call_id: noVertCall, options: opts });
    check("agent with two verticals, or none → refused, never defaulted", tv.body.error_code === "VERTICAL_UNKNOWN" && nv.body.error_code === "VERTICAL_UNKNOWN", `${tv.status} ${tv.body.error_code} / ${nv.status} ${nv.body.error_code}`);
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
  check("submit accepted and queued (TR does not call the worker)", sub.status === 200 && sub.body.status === "queued", `${sub.status} job ${sub.body.job_id ?? "-"} key ${sub.body.idempotency_key ?? "-"} reserved $${sub.body.reserved_usd ?? "-"}`);
  const job1 = String(sub.body.job_id);
  const again = await asStaff(AM, { action: "submit", call_id: callId[c1], options: opts });
  check("submitting the same call again does nothing twice", again.status === 200 && again.body.existing === true && again.body.job_id === job1, `${again.status} existing=${again.body.existing}`);
  const w1 = await waitJob(job1, (s) => s === "done" || s === "failed");
  check("a worker picked it up from its poll; job reached done", w1.status === "done", `by ${ownerOf(job1) ?? "?"}; stages seen: ${w1.seen.join(" → ")}${w1.error_code ? ` (${w1.error_code})` : ""}${w1.timedOut ? " TIMED OUT" : ""}`);
  await verifyDone(job1, M[c1], fakes);

  // ── 4. duplicates and a forged pairing ──
  sectionStart(`4. ${c9}: both workers race for one job (job row with sparse options: worker defaults)`);
  const ins = JSON.parse(psql(`set role service_role; select public.sample_job_insert(${lit(callId[c9])}, 1, 'final_expense', ${lit(JSON.stringify({ customer_channel: M[c9].customer_channel }))}::jsonb,
      ${lit(JSON.stringify({ duration_s: Math.round(M[c9].total_ms / 1000), vertical: "final_expense", channel_map: { customer: M[c9].customer_channel, agent: 1 - M[c9].customer_channel, verified: false } }))}::jsonb, ${lit(AM)}, 0.3, 100)`).split("\n").pop()!);
  const job9 = String(ins.job_id);
  {
    const w9 = await waitJob(job9, (s) => s === "done" || s === "failed");
    check("job reached done", w9.status === "done", `stages seen: ${w9.seen.join(" → ")}${w9.error_code ? ` (${w9.error_code})` : ""}`);
    const asr = [...fakes.transcripts.values()].filter((t) => t.job === job9);
    const starts = ["worker-a", "worker-b"].filter((w) => logOf(w).includes(`"event":"job_started","job_id":"${job9}"`));
    const lostClaim = ["worker-a", "worker-b"].filter((w) => logOf(w).includes(`"event":"job_ended","job_id":"${job9}"`) && /"status":"duplicate"/.test(logOf(w).split("\n").find((l) => l.includes(`"job_ended","job_id":"${job9}"`)) ?? ""));
    check("exactly one run did the work (2 transcriptions, 1 library row)",
      asr.length === 2 && q1(`select count(*)::int n from training_library_calls where job_id = ${lit(job9)}`).n === 1,
      `started by ${starts.join(" + ") || "?"}${lostClaim.length ? `; ${lostClaim.join(" + ")} lost the claim and stopped` : ""}; AssemblyAI jobs ${asr.length}`);
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
  check("AM retry accepted (same key, queued again)", retry.status === 200 && retry.body.status === "queued", `${retry.status} ${JSON.stringify(retry.body).slice(0, 120)}`);
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

  // ── 7. hard delete of a finished, published call ──
  sectionStart(`7. ${c1}: hard delete (admin only; TR side only)`);
  {
    const am = await asStaff(AM, { action: "delete", call_id: callId[c1] });
    check("an AM cannot delete (admin / superadmin only)", am.status === 403, `${am.status} ${am.body.error_code}`);
    const del = await asStaff(ADMIN, { action: "delete", call_id: callId[c1] });
    const rows = q1(`select (select count(*) from sample_redaction_jobs where call_id = ${lit(callId[c1])})::int jobs,
                            (select count(*) from training_library_calls where id = ${lit(lib1.id)})::int libs,
                            (select count(*) from training_library_clips where library_call_id = ${lit(lib1.id)})::int clips`);
    check("delete → 200; job, library call and clips rows are gone", del.status === 200 && rows.jobs === 0 && rows.libs === 0 && rows.clips === 0, `${del.status} ${del.body.error_code ?? ""} ${JSON.stringify(rows)}`);
    check("TR copies gone (both buckets)", !filesUnder("sample-src", job1).length && !filesUnder("training-library", job1).length,
      `left: ${[...filesUnder("sample-src", job1), ...filesUnder("training-library", job1)].join(", ") || "none"}`);
    const spend = q1(`select coalesce(sum(usd), 0)::float usd from sample_spend_ledger`).usd;
    check("its spend stays in the month cap (moved to the spend ledger)", spend > 0, `$${spend}`);
    const asr = [...fakes.transcripts.values()].filter((t) => t.job === job1);
    check("AssemblyAI copies were already deleted (the worker did it when the job finished)", asr.length > 0 && asr.every((t) => fakes.deleted.has(t.id)), `${asr.filter((t) => fakes.deleted.has(t.id)).length}/${asr.length}`);
    const raw = JSON.stringify({ action: "job", job_id: job1 });
    const br = await fetch(BASE(PORT.bridge), { method: "POST", headers: { "x-tr-signature": signBody(SECRET.bridge, raw) }, body: raw });
    check("the bridge answers 404 NO_JOB for the deleted job (the worker treats it as stopped)", br.status === 404 && ((await br.json()) as { error_code?: string }).error_code === "NO_JOB", `HTTP ${br.status}`);
  }

  // ── 8. cancel while a worker is running the job, then delete ──
  sectionStart("8. cancel mid-run → the worker stops → vendor_purged → delete");
  {
    fakes.holdAsr = true;
    const s8 = await asStaff(AM, { action: "submit", call_id: callId.cancel, options: { ...opts, customer_channel: M[c9].customer_channel } });
    const job = String(s8.body.job_id);
    const mid = await waitJob(job, (st) => st === "transcribing", 60_000);
    const vendor = () => [...fakes.transcripts.values()].filter((t) => t.job === job);
    // the status turns 'transcribing' just before the upload reaches the vendor
    for (let i = 0; i < 30 && vendor().length === 0; i++) await sleep(500);
    check("job is mid-run (transcribing; AssemblyAI has a copy)", mid.status === "transcribing" && vendor().length === 1, `${mid.seen.join(" → ")}; vendor copies ${vendor().length}`);
    const early = await asStaff(ADMIN, { action: "delete", call_id: callId.cancel });
    check("delete while in flight → 409 IN_FLIGHT (cancel first)", early.status === 409 && early.body.error_code === "IN_FLIGHT", `${early.status} ${early.body.error_code} ${early.body.error ?? ""}`);
    const amc = await asStaff(AM, { action: "cancel", call_id: callId.cancel });
    check("an AM cannot cancel (admin / superadmin only)", amc.status === 403, `${amc.status} ${amc.body.error_code}`);
    const c = await asStaff(ADMIN, { action: "cancel", call_id: callId.cancel });
    const row = q1(`select status, error_code from sample_redaction_jobs where id = ${lit(job)}`);
    check("admin cancel → failed:cancelled, with one live run", c.status === 200 && c.body.cancelled === 1 && c.body.live_runs === 1 && row.status === "failed" && row.error_code === "cancelled", `${c.status} ${JSON.stringify(c.body)}`);
    const owner = ownerOf(job);
    const stopped = !!owner && (await waitLog(owner, `"event":"job_ended","job_id":"${job}"`, 30_000));
    const after = q1(`select heartbeat_at, coalesce(array_length(asr_transcript_ids, 1), 0) ids from sample_redaction_jobs where id = ${lit(job)}`);
    check("the worker stopped it on its next poll, deleted its AssemblyAI copy and reported vendor_purged (heartbeat cleared)",
      stopped && logOf(owner!).includes(`"event":"job_stop_requested","job_id":"${job}"`) && vendor().every((t) => fakes.deleted.has(t.id)) && !after.heartbeat_at && after.ids === 0,
      `${owner ?? "?"}; heartbeat ${after.heartbeat_at ?? "null"}; ids left ${after.ids}; vendor ${vendor().filter((t) => fakes.deleted.has(t.id)).length}/${vendor().length}`);
    check("the worker did not fail it again (stays failed:cancelled)", q1(`select error_code from sample_redaction_jobs where id = ${lit(job)}`).error_code === "cancelled");
    const del = await asStaff(ADMIN, { action: "delete", call_id: callId.cancel });
    const left = q1(`select count(*)::int n from sample_redaction_jobs where call_id = ${lit(callId.cancel)}`).n;
    check("then delete → 200: rows and TR storage gone", del.status === 200 && left === 0 && !filesUnder("sample-src", job).length && !filesUnder("training-library", job).length, `${del.status} ${del.body.error_code ?? ""}; job rows ${left}`);
    fakes.holdAsr = false;
  }

  // ── 8b. the kill switch (TR d7671d64: no claims while recording_library is OFF) ──
  sectionStart("8b. kill switch: flag recording_library OFF → no new work; a job offered just before it ends as cancelled");
  {
    const asBridge = async (body: Record<string, unknown>) => {
      const raw = JSON.stringify(body);
      const r = await fetch(BASE(PORT.bridge), { method: "POST", headers: { "x-tr-signature": signBody(SECRET.bridge, raw) }, body: raw });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    psql(`update feature_flags set enabled = false where key = 'recording_library'`);
    const v = q1<{ v: number }>(`select coalesce(max(version), 0) + 1 v from sample_redaction_jobs where call_id = ${lit(callId[c9])}`).v;
    const k = JSON.parse(psql(`set role service_role; select public.sample_job_insert(${lit(callId[c9])}, ${v}, 'final_expense', ${lit(JSON.stringify({ customer_channel: M[c9].customer_channel }))}::jsonb,
      ${lit(JSON.stringify({ duration_s: Math.round(M[c9].total_ms / 1000), vertical: "final_expense", channel_map: { customer: M[c9].customer_channel, agent: 1 - M[c9].customer_channel, verified: false } }))}::jsonb, ${lit(AM)}, 0.3, 100)`).split("\n").pop()!);
    const jobK = String(k.job_id);
    await sleep(8_000);   // 4 poll cycles of both workers
    const rowK = q1(`select status, idempotency_key from sample_redaction_jobs where id = ${lit(jobK)}`);
    check("flag OFF: a queued job is not handed to the workers", rowK.status === "queued" && !ownerOf(jobK), `status ${rowK.status}; claimed by ${ownerOf(jobK) ?? "nobody"} after 4 poll cycles`);
    const p = await asBridge({ action: "poll", worker: "sim-probe", running: [], capacity: 2 });
    check("flag OFF: poll offers no jobs (stop and cleanup still answer)", p.status === 200 && Array.isArray(p.body.jobs) && p.body.jobs.length === 0 && Array.isArray(p.body.stop),
      `${p.status} jobs ${p.body.jobs?.length ?? "-"}`);
    const cl = await asBridge({ action: "claim", job_id: jobK, run_id: "run_simprobe", idempotency_key: rowK.idempotency_key });
    const endK = q1(`select status, error_code from sample_redaction_jobs where id = ${lit(jobK)}`);
    check("a claim that raced the switch-off → 409 JOB_TERMINAL (the code the worker stops on, never fails) and the job ends failed:cancelled",
      cl.status === 409 && cl.body.error_code === "JOB_TERMINAL" && endK.status === "failed" && endK.error_code === "cancelled", `${cl.status} ${cl.body.error_code}; job ${endK.status}:${endK.error_code}`);
    psql(`update feature_flags set enabled = true where key = 'recording_library'`);
  }

  // ── 9. a worker dies mid-job ──
  sectionStart("9. a worker is killed mid-job (no goodbye): the bridge fails it, the other worker cleans up, retry works");
  {
    fakes.holdAsr = true;
    const s9 = await asStaff(AM, { action: "submit", call_id: callId.crash, options: opts });
    const job = String(s9.body.job_id);
    const mid = await waitJob(job, (st) => st === "transcribing", 60_000);
    for (let i = 0; i < 40 && !ownerOf(job); i++) await sleep(250);
    const owner = ownerOf(job)!;
    const other = owner === "worker-a" ? "worker-b" : "worker-a";
    workers[owner].kill("SIGKILL");
    check("job mid-run, then its worker is killed (SIGKILL)", mid.status === "transcribing" && !!owner, `${owner} killed during ${mid.status}`);
    fakes.holdAsr = false;
    const failed = await waitJob(job, (st) => st === "failed", 60_000);
    const row = q1(`select error_code, error_detail from sample_redaction_jobs where id = ${lit(job)}`);
    check(`after ${STALE_S} s without a heartbeat the bridge fails it ("worker stopped responding")`, failed.status === "failed" && /worker stopped responding/.test(row.error_detail ?? ""), `${row.error_code}: ${row.error_detail}`);
    const vendor = () => [...fakes.transcripts.values()].filter((t) => t.job === job);
    // two ways a dead run's copy goes: its id was recorded → the cleanup list; killed between AssemblyAI's submit and
    // the bridge `asr` record → nobody knows the id, and the orphan sweep (age > the job deadline) deletes it
    for (let i = 0; i < 280 && !vendor().every((t) => fakes.deleted.has(t.id)); i++) await sleep(250);
    const left = q1(`select coalesce(array_length(asr_transcript_ids, 1), 0) n from sample_redaction_jobs where id = ${lit(job)}`).n;
    const via = logOf(other).includes(`"event":"cleanup_done","job_id":"${job}"`) ? "the cleanup list" : /"event":"orphan_sweep","listed":\d+,"deleted":[1-9]/.test(logOf(other)) ? "the orphan sweep (id was never recorded)" : "?";
    check(`${other} deletes the dead run's AssemblyAI copy`, vendor().length > 0 && vendor().every((t) => fakes.deleted.has(t.id)) && left === 0,
      `${vendor().filter((t) => fakes.deleted.has(t.id)).length}/${vendor().length} deleted via ${via}; ids left on the row ${left}`);
    check("TR storage left by the dead run is purged", !filesUnder("sample-src", job).length && !filesUnder("training-library", job).length);
    const rt = await asStaff(AM, { action: "retry", job_id: job });
    const done = await waitJob(job, (st) => st === "done" || st === "failed");
    check("AM retry → the surviving worker finishes it", rt.status === 200 && done.status === "done" && ownerOf(job) !== undefined, `${done.seen.join(" → ")}`);
    await verifyDone(job, M[c1], fakes);
    check("Medicare call: the coaching prompt names the job's vertical (not final expense)", fakes.llm.systems.some((x) => x.startsWith("You coach Medicare insurance agents")),
      `${fakes.llm.systems.filter((x) => x.startsWith("You coach Medicare")).length} Medicare prompts of ${fakes.llm.systems.length}`);

    // the orphan sweep, deterministically: one transcript older than the age limit that no job knows, one young one
    fakes.plantOrphan("orphan_old", 60_000);
    fakes.plantOrphan("orphan_young", 0);
    for (let i = 0; i < 80 && !fakes.deleted.has("orphan_old"); i++) await sleep(250);
    check("orphan sweep: a transcript no job recorded, older than the job deadline, is deleted; a young one is left alone",
      fakes.deleted.has("orphan_old") && !fakes.deleted.has("orphan_young"), `old ${fakes.deleted.has("orphan_old") ? "deleted" : "LEFT"}; young ${fakes.deleted.has("orphan_young") ? "DELETED" : "kept"}`);

    // graceful stop: SIGTERM ends the process cleanly
    const t0s = Date.now();
    workers[other].kill("SIGTERM");
    const code = await new Promise<number | null>((r) => { workers[other].on("exit", (c) => r(c)); setTimeout(() => r(-1), 40_000); });
    check("SIGTERM: the worker stops polling and exits 0", code === 0 && logOf(other).includes('"event":"worker_stopped"'), `exit ${code} in ${Math.round((Date.now() - t0s) / 1000)} s`);
  }

  // ── 10. privacy ──
  sectionStart("10. privacy: where personal data could end up");
  {
    const values = PLANTED_TEXTS(Object.values(M));
    const scan = (label: string, text: string) => { const hits = values.filter((v) => ` ${text} `.includes(` ${v} `)); return check(label, hits.length === 0, hits.length ? `found: ${hits.slice(0, 5).join(" | ")}` : `${values.length} planted values searched`); };
    for (const n of ["worker-a", "worker-b", "bridge", "admin"]) scan(`${n} logs hold no planted value`, norm(logOf(n)));
    // the worker keeps nothing: every step's temp dir (sr-<job>-…) is gone
    const leftovers = ["worker-a", "worker-b"].flatMap((w) => readdirSync(path.join(OUT, `tmp-${w}`)).filter((n) => n.startsWith("sr-")).map((n) => `${w}/${n}`));
    check("worker temp dirs are empty after every job (it keeps no copy)", leftovers.length === 0, leftovers.slice(0, 3).join(", ") || "no sr-* left");
    const dump = execFileSync(path.join(PGBIN, "pg_dump"), ["-h", "127.0.0.1", "-p", String(PORT.pg), "-U", "postgres", "--data-only", "-T", "public.calls", "-T", "public.agents", "postgres"], { encoding: "utf8", maxBuffer: 1 << 28 });
    scan("database (every table except TR's own calls/agents rows) holds no planted value", norm(dump));
  }

  // ── report ──
  const pass = rows.filter((r) => r.ok).length, fail = rows.length - pass;
  const md = [
    `# Sample redactor — end-to-end simulation ${STAMP}`,
    "",
    `- worker ${PIPELINE_VERSION}, schema ${SCHEMA_VERSION}; ${Math.round((Date.now() - t0) / 1000)} s`,
    "- real: 2 worker processes (node src/worker.ts, pull model), training-library-admin + sample-redaction-bridge (Deno), RL-1 + worker migrations (Postgres)",
    "- faked: Supabase HTTP layer, Telnyx, AssemblyAI (verification pass listens to the redacted mp3), OpenRouter",
    "- live systems touched: none · values in the calls: fictional",
    "",
    `**${pass} passed, ${fail} failed**`,
    "",
    "| | check | detail |",
    "|---|---|---|",
    ...rows.map((r, i) => (i === 0 || rows[i - 1].section !== r.section ? `| | **${r.section}** | |\n` : "") + `| ${r.ok ? "PASS" : "**FAIL**"} | ${r.name} | ${r.detail.replace(/\|/g, "\\|")} |`),
    "",
    `Listen: \`${path.relative(ROOT, STORAGE)}/training-library/<job_id>/redacted.mp3\` and \`clips/cN.mp3\` (deleted calls' files are gone by design).`,
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

  // listen: every planted value under the bleep noise, in the full call and in every exported clip
  const red = path.join(STORAGE, "training-library", job, "redacted.mp3");
  // control: the same listener on the ORIGINAL recording must hear every planted value
  const original = audibleValues(path.join(ROOT, "fixtures", "out", `${m.name}.mp3`), m);
  check("control: the listener hears every planted value in the original recording", original.length === m.planted.length, `${original.length}/${m.planted.length}`);
  const heard = audibleValues(red, m);
  check(`audio: all ${m.planted.length} planted values bleeped in the redacted call`, heard.length === 0, heard.slice(0, 4).join("; ") || "bleep noise over every planted word");
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
