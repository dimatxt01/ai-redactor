// Node twin of supabase/functions/_shared/sampleSignature.ts — keep them identical.
//   X-TR-Signature: t=<unix>,v1=<hex(hmac_sha256(secret, t + "." + raw_body))>, ±300s.
import { createHmac, timingSafeEqual } from "node:crypto";

const WINDOW_S = 300;

export function signBody(secret: string, rawBody: string, nowS = Math.floor(Date.now() / 1000)): string {
  const mac = createHmac("sha256", secret).update(`${nowS}.${rawBody}`).digest("hex");
  return `t=${nowS},v1=${mac}`;
}

export function verifySignature(
  secret: string | undefined,
  header: string | null,
  rawBody: string,
  nowS = Math.floor(Date.now() / 1000),
): { ok: true } | { ok: false; reason: "unconfigured" | "missing" | "malformed" | "stale" | "mismatch" } {
  if (!secret) return { ok: false, reason: "unconfigured" };
  if (!header) return { ok: false, reason: "missing" };
  const parts = Object.fromEntries(
    header.split(",").map((p) => {
      const i = p.indexOf("=");
      return i < 0 ? [p.trim(), ""] : [p.slice(0, i).trim(), p.slice(i + 1).trim()];
    }),
  );
  const t = Number(parts.t);
  const v1 = String(parts.v1 ?? "");
  if (!Number.isInteger(t) || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: "malformed" };
  if (Math.abs(nowS - t) > WINDOW_S) return { ok: false, reason: "stale" };
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest();
  return timingSafeEqual(expected, Buffer.from(v1, "hex")) ? { ok: true } : { ok: false, reason: "mismatch" };
}
