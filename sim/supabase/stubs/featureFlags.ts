// SIMULATION ONLY: TrueRing's _shared/featureFlags.ts reads public.feature_flags (with a short cache);
// this stand-in reads the same row, uncached, so the harness can flip the flag between steps.
// deno-lint-ignore no-explicit-any
export async function flagEnabled(supabase: any, key: string): Promise<boolean> {
  const { data } = await supabase.from("feature_flags").select("enabled").eq("key", key).maybeSingle();
  return data?.enabled === true;
}
