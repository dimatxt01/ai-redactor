// src/lib/recordingLibraryFlag.ts
// Flag `recording_library` (RL-1, created OFF): enabled → the Recording Library nav item and page render.
// Absent / disabled / unreadable → OFF (fail-safe). Same client-read pattern as src/lib/notificationFlag.ts.
import { supabase } from "@/integrations/supabase/client";

const CACHE_MS = 60_000;
let cache: { on: boolean; at: number } | null = null;

export async function recordingLibraryEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.on;
  try {
    const { data, error } = await supabase.from("feature_flags").select("enabled").eq("key", "recording_library").maybeSingle();
    if (error) return false;   // a blip is not remembered for a minute
    cache = { on: data?.enabled === true, at: now };
    return cache.on;
  } catch {
    return false;
  }
}
