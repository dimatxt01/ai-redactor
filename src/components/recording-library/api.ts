// Calls into training-library-admin (every write; signed links). Reads go straight to the RL-1 tables under RLS.
import { supabase } from "@/integrations/supabase/client";
import { extractFnError } from "@/lib/edgeFunctionError";

export async function invoke<T = Record<string, unknown>>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("training-library-admin", { body });
  if (error) throw new Error((await extractFnError(error)) ?? "The Recording Library service failed; try again.");
  return data as T;
}

/** 10-minute signed link. Every call is logged server-side: it is the reviewer's listen evidence. */
export async function link(libraryCallId: string, artifact: string): Promise<string> {
  const r = await invoke<{ url?: string }>({ action: "link", library_call_id: libraryCallId, artifact });
  if (!r?.url) throw new Error("no link");
  return r.url;
}

export async function fetchArtifact<T>(libraryCallId: string, artifact: string): Promise<T> {
  const res = await fetch(await link(libraryCallId, artifact));
  if (!res.ok) throw new Error(`${artifact} ${res.status}`);
  return (await res.json()) as T;
}

/** Narrow reads of tables the generated types do not know yet. */
export function table(name: string) {
  return supabase.from(name as never);
}

export const fmtMs = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
