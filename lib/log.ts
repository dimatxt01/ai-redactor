// The worker's only logger. Logs carry no PII: values are numbers, booleans or
// short identifier-shaped strings (ids, codes, stage names). Anything that
// could be free text (transcript words, names, vendor error bodies) is
// replaced with "[omitted]" before it reaches stdout.

type Field = string | number | boolean | null | undefined;

const SAFE = /^[A-Za-z0-9_:.@/-]{0,80}$/;

export function safeValue(v: Field): string | number | boolean | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "number" || typeof v === "boolean") return v;
  return SAFE.test(v) ? v : "[omitted]";
}

export function log(event: string, fields: Record<string, Field> = {}): void {
  const out: Record<string, unknown> = { svc: "sample-redactor", event: safeValue(event) };
  for (const [k, v] of Object.entries(fields)) out[k] = safeValue(v);
  console.log(JSON.stringify(out));
}

/** An error's class + a code, never its message (vendor messages can echo content). */
export function errorCode(e: unknown): string {
  if (e && typeof e === "object" && "code" in e && typeof (e as { code: unknown }).code === "string") {
    return String((e as { code: string }).code);
  }
  return e instanceof Error ? e.name : "unknown";
}
