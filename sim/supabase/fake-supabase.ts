// SIMULATION ONLY. Stands in for `https://esm.sh/@supabase/supabase-js@2` inside the REAL TrueRing edge
// functions (truering/supabase/functions/*), via sim/supabase/import_map.json. It implements the subset of
// supabase-js those functions call, on a throwaway local Postgres (the real RL-1 + worker migrations):
//   from(table).select/insert/update/delete + eq/neq/is/in/not/or/gt/gte/lt/lte/filter/order/limit
//   + maybeSingle/single, one-level embeds `alias:fk_col(cols)`, rpc(name, args), auth.getClaims(token),
//   storage.from(bucket).list/remove/createSignedUploadUrl/createSignedUrl (files on local disk; the URLs are
//   served by the simulation harness, sim/run.ts, and carry an HMAC token it checks).
// Every query runs as the `service_role` Postgres role, like PostgREST with the service key, so grants and
// RLS behave as in production. Errors come back as { data: null, error }, never thrown.
import pg from "npm:pg@8.13.1";
import { createHmac } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, dirname } from "node:path";

const DB_URL = Deno.env.get("SIM_DATABASE_URL")!;
const STORAGE_DIR = Deno.env.get("SIM_STORAGE_DIR")!;
const STORAGE_BASE = Deno.env.get("SIM_STORAGE_BASE")!;   // harness origin serving signed URLs
const SIGN_KEY = Deno.env.get("SIM_SIGN_KEY")!;

// PostgREST-shaped values: numbers for numeric/int8, ISO strings for timestamps.
const iso = (s: string) => new Date(s.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00")).toISOString().replace("Z", "+00:00");
pg.types.setTypeParser(1700, (v: string) => Number(v));
pg.types.setTypeParser(20, (v: string) => Number(v));
pg.types.setTypeParser(1184, iso);
pg.types.setTypeParser(1114, (v: string) => iso(v + "+00"));
pg.types.setTypeParser(1082, (v: string) => v);

const pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
pool.on("connect", (c: pg.PoolClient) => { c.query("set role service_role; set timezone = 'UTC'"); });

type Err = { message: string; code?: string; details?: string };
type Res<T = any> = { data: T; error: Err | null; count?: number | null };
const fail = (e: unknown): Res<null> => ({ data: null, error: { message: e instanceof Error ? e.message : String(e), code: (e as any)?.code } });

const ident = (s: string) => {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) throw new Error(`sim: unsupported identifier ${s}`);
  return `"${s}"`;
};

// column types per table, so JS arrays become jsonb or postgres arrays as the column wants
const colTypes = new Map<string, Promise<Record<string, string>>>();
function typesOf(table: string) {
  if (!colTypes.has(table)) {
    colTypes.set(table, pool.query(
      `select a.attname, format_type(a.atttypid, a.atttypmod) as t from pg_attribute a join pg_class c on c.oid = a.attrelid
        where c.relnamespace = 'public'::regnamespace and c.relname = $1 and a.attnum > 0 and not a.attisdropped`, [table],
    ).then((r: any) => Object.fromEntries(r.rows.map((x: any) => [x.attname, x.t]))));
  }
  return colTypes.get(table)!;
}
const fkTarget = new Map<string, Promise<string>>();
function targetOf(table: string, col: string) {
  const k = `${table}.${col}`;
  if (!fkTarget.has(k)) {
    // pg_catalog, not information_schema: the latter hides constraints of tables service_role does not own
    fkTarget.set(k, pool.query(
      `select ft.relname as table_name from pg_constraint c
         join pg_class t on t.oid = c.conrelid join pg_class ft on ft.oid = c.confrelid
         join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
        where c.contype = 'f' and t.relnamespace = 'public'::regnamespace and t.relname = $1 and a.attname = $2 limit 1`, [table, col],
    ).then((r: any) => { if (!r.rows[0]) throw new Error(`sim: no foreign key ${k}`); return r.rows[0].table_name as string; }));
  }
  return fkTarget.get(k)!;
}

function splitTop(s: string): string[] {
  const out: string[] = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

async function selectList(table: string, cols: string, alias = "t"): Promise<string> {
  const parts = splitTop(cols || "*");
  const out: string[] = [];
  for (const p of parts) {
    const m = /^([a-z_][a-z0-9_]*)(?::([a-z_][a-z0-9_]*))?(?:!inner)?\((.*)\)$/i.exec(p);
    if (m) {
      // alias:fk_col(cols)  or  table(cols) — one level, to-one only (what these functions use)
      const [, a, fk, inner] = m;
      const col = fk ?? `${a}_id`;
      const target = await targetOf(table, col);
      const innerSel = await selectList(target, inner, "e");
      out.push(`(select row_to_json(x) from (select ${innerSel} from public.${ident(target)} e where e.id = ${alias}.${ident(col)}) x) as ${ident(a)}`);
    } else if (p === "*") out.push(`${alias}.*`);
    else out.push(`${alias}.${ident(p)}`);
  }
  return out.join(", ");
}

type Filter = (p: (v: unknown) => string) => string;

function parseList(v: string): string[] {
  return v.replace(/^\(|\)$/g, "").split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

/** a column, or a PostgREST JSON path on one: `metadata->>library_call_id`, `options->clips->>enabled` */
function colRef(col: string, alias: string): string {
  const m = /^([a-z_][a-z0-9_]*)((?:->>?[a-z0-9_]+)*)$/i.exec(col);
  if (!m) throw new Error(`sim: unsupported column ${col}`);
  const path = [...m[2].matchAll(/(->>?)([a-z0-9_]+)/gi)].map(([, op, k]) => `${op}'${k}'`).join("");
  return `${alias}.${ident(m[1])}${path}`;
}

function opSql(col: string, op: string, val: unknown, p: (v: unknown) => string, alias = "t"): string {
  const c = colRef(col, alias);
  switch (op) {
    case "eq": return `${c} = ${p(val)}`;
    case "neq": return `${c} <> ${p(val)}`;
    case "gt": return `${c} > ${p(val)}`;
    case "gte": return `${c} >= ${p(val)}`;
    case "lt": return `${c} < ${p(val)}`;
    case "lte": return `${c} <= ${p(val)}`;
    case "is": {
      const s = String(val);
      if (val === null || s === "null") return `${c} is null`;
      if (s === "true" || s === "false") return `${c} is ${s}`;
      throw new Error(`sim: is ${s}`);
    }
    case "in": {
      const list = Array.isArray(val) ? val : parseList(String(val));
      return `${c}::text = any(${p(list.map(String))}::text[])`;
    }
    case "cs": return `${c} @> ${p(typeof val === "string" ? val : JSON.stringify(val))}`;
    default: throw new Error(`sim: unsupported filter op ${op}`);
  }
}

class Query implements PromiseLike<Res> {
  private kind: "select" | "insert" | "update" | "delete" = "select";
  private cols = "*";
  private returning: string | null = null;
  private values: Record<string, unknown> | Record<string, unknown>[] | null = null;
  private filters: Filter[] = [];
  private orders: string[] = [];
  private lim: number | null = null;
  private singleMode: "maybe" | "one" | null = null;
  private countMode: string | null = null;
  private headOnly = false;

  constructor(private table: string) {}

  select(cols = "*", opts?: { count?: string; head?: boolean }) {
    if (this.kind === "select") this.cols = cols; else this.returning = cols;
    if (opts?.count) this.countMode = opts.count;
    if (opts?.head) this.headOnly = true;
    return this;
  }
  insert(v: Record<string, unknown> | Record<string, unknown>[]) { this.kind = "insert"; this.values = v; return this; }
  update(v: Record<string, unknown>) { this.kind = "update"; this.values = v; return this; }
  delete() { this.kind = "delete"; return this; }

  private add(col: string, op: string, val: unknown) { this.filters.push((p) => opSql(col, op, val, p)); return this; }
  eq(c: string, v: unknown) { return this.add(c, "eq", v); }
  neq(c: string, v: unknown) { return this.add(c, "neq", v); }
  gt(c: string, v: unknown) { return this.add(c, "gt", v); }
  gte(c: string, v: unknown) { return this.add(c, "gte", v); }
  lt(c: string, v: unknown) { return this.add(c, "lt", v); }
  lte(c: string, v: unknown) { return this.add(c, "lte", v); }
  is(c: string, v: unknown) { return this.add(c, "is", v); }
  in(c: string, v: unknown[]) { return this.add(c, "in", v); }
  filter(c: string, op: string, v: unknown) { return this.add(c, op, v); }
  not(c: string, op: string, v: unknown) { this.filters.push((p) => `not (${opSql(c, op, v, p)})`); return this; }
  or(expr: string) {
    // PostgREST: "a.is.null,a.eq.X" (flat, no nesting — what these functions use)
    this.filters.push((p) => "(" + splitTop(expr).map((term) => {
      const [col, op, ...rest] = term.split(".");
      return opSql(col, op, rest.join("."), p);
    }).join(" or ") + ")");
    return this;
  }
  order(c: string, o?: { ascending?: boolean }) { this.orders.push(`t.${ident(c)} ${o?.ascending === false ? "desc" : "asc"}`); return this; }
  limit(n: number) { this.lim = n; return this; }
  maybeSingle() { this.singleMode = "maybe"; return this; }
  single() { this.singleMode = "one"; return this; }

  private async run(): Promise<Res> {
    try { return await this.exec(); } catch (e) { return fail(e); }
  }

  private async exec(): Promise<Res> {
    const params: unknown[] = [];
    const types = await typesOf(this.table);
    const p = (v: unknown) => { params.push(v); return `$${params.length}`; };
    const pv = (col: string, v: unknown) => {
      const t = types[col];
      if (t === "jsonb" || t === "json") return `${p(v === null ? null : JSON.stringify(v))}::jsonb`;
      return p(v);
    };
    const where = this.filters.length ? " where " + this.filters.map((f) => f(p)).join(" and ") : "";
    const T = `public.${ident(this.table)}`;
    let sql: string;
    if (this.kind === "select") {
      sql = `select ${await selectList(this.table, this.cols)} from ${T} t${where}`
        + (this.orders.length ? ` order by ${this.orders.join(", ")}` : "") + (this.lim !== null ? ` limit ${Number(this.lim)}` : "");
    } else if (this.kind === "insert") {
      const rows = Array.isArray(this.values) ? this.values : [this.values!];
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => r[k] !== undefined)))];
      const vals = rows.map((r) => `(${cols.map((c) => (r[c] === undefined ? "default" : pv(c, r[c]))).join(", ")})`).join(", ");
      sql = `insert into ${T} as t (${cols.map(ident).join(", ")}) values ${vals}`
        + (this.returning !== null ? ` returning ${await selectList(this.table, this.returning)}` : "");
    } else if (this.kind === "update") {
      const v = this.values as Record<string, unknown>;
      const sets = Object.keys(v).filter((k) => v[k] !== undefined).map((k) => `${ident(k)} = ${pv(k, v[k])}`);
      sql = `update ${T} t set ${sets.join(", ")}${where}`
        + (this.returning !== null ? ` returning ${await selectList(this.table, this.returning)}` : "");
    } else {
      sql = `delete from ${T} t${where}` + (this.returning !== null ? ` returning ${await selectList(this.table, this.returning)}` : "");
    }
    try {
      const r = await pool.query(sql, params);
      const rows = r.rows;
      const count = this.countMode ? (this.kind === "select" ? rows.length : r.rowCount) : null;
      if (this.headOnly) return { data: null, error: null, count };
      if (this.kind !== "select" && this.returning === null) return { data: null, error: null, count };
      if (this.singleMode) {
        if (rows.length > 1 || (this.singleMode === "one" && rows.length === 0)) {
          return { data: null, error: { message: `JSON object requested, multiple (or no) rows returned (${rows.length})`, code: "PGRST116" } };
        }
        return { data: rows[0] ?? null, error: null, count };
      }
      return { data: rows, error: null, count };
    } catch (e) {
      return fail(e);
    }
  }

  then<A = Res, B = never>(ok?: ((v: Res) => A | PromiseLike<A>) | null, ko?: ((e: unknown) => B | PromiseLike<B>) | null): PromiseLike<A | B> {
    return this.run().then(ok, ko);
  }
}
// ── storage on local disk ────────────────────────────────────────────────────
export function storageToken(bucket: string, path: string, mode: "upload" | "download", ttlS: number): string {
  const body = btoa(JSON.stringify({ b: bucket, p: path, m: mode, e: Math.floor(Date.now() / 1000) + ttlS })).replace(/=+$/, "");
  const mac = createHmac("sha256", SIGN_KEY).update(body).digest("hex");
  return `${body}.${mac}`;
}

function bucketApi(bucket: string) {
  const root = join(STORAGE_DIR, bucket);
  const safe = (p: string) => {
    if (p.split("/").some((s) => s === ".." || s === "")) throw new Error(`sim: bad storage path ${p}`);
    return join(root, p);
  };
  return {
    async list(prefix: string, _o?: { limit?: number }) {
      try {
        const dir = safe(prefix);
        const names = await readdir(dir).catch(() => [] as string[]);
        const out = [];
        for (const n of names.sort()) {
          const s = await stat(join(dir, n));
          // like Supabase: folders come back without an id
          out.push({ name: n, id: s.isFile() ? `${bucket}/${prefix}/${n}` : null, metadata: s.isFile() ? { size: s.size } : null });
        }
        return { data: out, error: null };
      } catch (e) { return fail(e); }
    },
    async remove(paths: string[]) {
      try {
        for (const p of paths) await rm(safe(p), { force: true });
        return { data: paths.map((name) => ({ name })), error: null };
      } catch (e) { return fail(e); }
    },
    async createSignedUploadUrl(path: string, _o?: { upsert?: boolean }) {
      try {
        safe(path);
        await mkdir(dirname(safe(path)), { recursive: true });
        const token = storageToken(bucket, path, "upload", 7200);
        return { data: { signedUrl: `${STORAGE_BASE}/storage/v1/object/upload/sign/${bucket}/${path}?token=${token}`, path, token }, error: null };
      } catch (e) { return fail(e); }
    },
    async createSignedUrl(path: string, expiresIn: number) {
      try {
        safe(path);
        const token = storageToken(bucket, path, "download", expiresIn);
        return { data: { signedUrl: `${STORAGE_BASE}/storage/v1/object/sign/${bucket}/${path}?token=${token}` }, error: null };
      } catch (e) { return fail(e); }
    },
  };
}

export function createClient(_url: string, _key: string) {
  return {
    from: (table: string) => new Query(table),
    async rpc(name: string, args: Record<string, unknown> = {}) {
      try {
        // argument types from the catalog, so jsonb args get JSON and the rest stay as given
        const sig = await pool.query(
          `select p.proargnames, array(select format_type(t, null) from unnest(p.proargtypes) t) as types
             from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = $1 limit 1`, [name]);
        if (!sig.rows[0]) return { data: null, error: { message: `function public.${name} does not exist`, code: "PGRST202" } };
        const names: string[] = sig.rows[0].proargnames ?? [];
        const types: string[] = sig.rows[0].types ?? [];
        const params: unknown[] = [];
        const list = Object.entries(args).map(([k, v]) => {
          const t = types[names.indexOf(k)];
          params.push(t === "jsonb" || t === "json" ? JSON.stringify(v) : v);
          return `${ident(k)} => $${params.length}${t ? `::${t}` : ""}`;
        });
        const r = await pool.query(`select public.${ident(name)}(${list.join(", ")}) as r`, params);
        return { data: r.rows[0]?.r ?? null, error: null };
      } catch (e) { return fail(e); }
    },
    auth: {
      // sim tokens are "sim:<user uuid>"; the harness plays the signed-in AM / admin
      async getClaims(token: string) {
        const m = /^sim:([0-9a-f-]{36})$/i.exec(token);
        return m ? { data: { claims: { sub: m[1] } }, error: null } : { data: null, error: { message: "invalid token" } };
      },
    },
    storage: { from: bucketApi },
  };
}
