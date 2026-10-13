import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import type { LibraryRow } from "./types";

type Span = { type: string; padded_start_ms: number; padded_end_ms: number };
type Line = { speaker: "customer" | "agent"; start_ms: number; end_ms: number; text: string };

async function signed(libraryId: string, artifact: string): Promise<string> {
  const { data, error } = await supabase.functions.invoke("sample-library-admin", {
    body: { action: "play_url", library_id: libraryId, artifact },
  });
  if (error || !data?.url) throw new Error(error?.message ?? "no url");
  return data.url as string;
}

async function fetchJson<T>(libraryId: string, artifact: string): Promise<T> {
  const res = await fetch(await signed(libraryId, artifact));
  if (!res.ok) throw new Error(`${artifact} ${res.status}`);
  return (await res.json()) as T;
}

const fmt = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Full-listen QA: the "listened to the full file" box only unlocks once playback
 * has actually covered ≥98% of the file (seeking ahead does not count).
 */
export function QaPlayer({ row, onDecided }: { row: LibraryRow; onDecided: () => void }) {
  const { toast } = useToast();
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [bleeps, setBleeps] = useState<{ start_ms: number; end_ms: number }[]>([]);
  const [spans, setSpans] = useState<Span[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const [heardMs, setHeardMs] = useState(0);
  const [listened, setListened] = useState(false);
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const played = useRef<Set<number>>(new Set());   // seconds actually played
  const lastT = useRef(0);

  const step: "qa" | "legal" | null = row.status === "pending_qa" ? "qa" : row.status === "qa_passed" ? "legal" : null;

  useEffect(() => {
    let cancelled = false;
    played.current = new Set();
    setHeardMs(0); setListened(false); setLoading(true); setPeaks(null);
    (async () => {
      try {
        const [url, sj, tj] = await Promise.all([
          signed(row.id, "redacted_audio"),
          fetchJson<{ items: { spans: Span[]; bleeps: { start_ms: number; end_ms: number }[] } }>(row.id, "pii_spans_json"),
          fetchJson<{ items: Line[] }>(row.id, "transcript_json"),
        ]);
        if (cancelled) return;
        setAudioUrl(url);
        setSpans(sj.items.spans);
        setBleeps(sj.items.bleeps);
        setLines(tj.items);
        // waveform from the decoded file (the signed URL is short-lived, so decode once now)
        const buf = await (await fetch(url)).arrayBuffer();
        // decode at 4 kHz: an hour of 44.1 kHz float audio would be ~600 MB in the tab
        const ctx = new OfflineAudioContext(1, 4000, 4000);
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const n = 900, step = Math.floor(data.length / n);
        const p: number[] = [];
        for (let i = 0; i < n; i++) {
          let m = 0;
          for (let k = i * step; k < (i + 1) * step; k += 8) m = Math.max(m, Math.abs(data[k] ?? 0));
          p.push(m);
        }
        if (!cancelled) { setPeaks(p); setDurationMs(audio.duration * 1000); }
      } catch (e) {
        toast({ title: "Could not load sample", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [row.id, toast]);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c || !peaks || !durationMs) return;
    const g = c.getContext("2d")!;
    const w = c.width, h = c.height;
    g.clearRect(0, 0, w, h);
    g.fillStyle = "rgba(239,68,68,0.28)";
    for (const b of bleeps) g.fillRect((b.start_ms / durationMs) * w, 0, Math.max(1, ((b.end_ms - b.start_ms) / durationMs) * w), h);
    g.fillStyle = getComputedStyle(c).color;
    peaks.forEach((p, i) => {
      const x = (i / peaks.length) * w, ph = Math.max(1, p * h);
      g.fillRect(x, (h - ph) / 2, Math.max(1, w / peaks.length - 0.5), ph);
    });
  }, [peaks, bleeps, durationMs]);

  const onTime = () => {
    const a = audioRef.current;
    if (!a) return;
    // only count continuous playback, not seeks
    if (!a.paused && a.currentTime - lastT.current < 1.5 && a.currentTime >= lastT.current) {
      played.current.add(Math.floor(a.currentTime));
      setHeardMs(played.current.size * 1000);
    }
    lastT.current = a.currentTime;
  };
  const coverage = durationMs ? Math.min(1, heardMs / durationMs) : 0;
  const canTick = coverage >= 0.98;

  const seek = (ms: number) => {
    const a = audioRef.current;
    if (a) { a.currentTime = ms / 1000; lastT.current = a.currentTime; a.play(); }
  };

  const byType = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of spans) m[s.type] = (m[s.type] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [spans]);

  const decide = async (decision: "approve" | "reject") => {
    if (!step) return;
    setBusy(true);
    const { data, error } = await supabase.functions.invoke("sample-library-admin", {
      body: { action: "approve", library_id: row.id, step, decision, listened_full: listened, notes: notes || null },
    });
    setBusy(false);
    if (error || data?.error) {
      toast({ title: "Not saved", description: data?.error ?? error?.message, variant: "destructive" });
      return;
    }
    toast({ title: decision === "approve" ? `${step.toUpperCase()} approved` : "Rejected", description: `Now ${data.status}` });
    setNotes("");
    onDecided();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{row.agent_ref}</Badge>
        <Badge variant="outline">v{row.version} · {row.pipeline_version}</Badge>
        <Badge variant={row.qa_flag ? "destructive" : "secondary"}>{row.qa_flag ? "QA flagged" : "no QA flags"}</Badge>
        {byType.map(([t, n]) => <Badge key={t} variant="secondary">{t} {n}</Badge>)}
      </div>

      {row.qa_reasons.length > 0 && (
        <div className="rounded-md border border-destructive/40 p-3 text-sm">
          <div className="mb-1 font-medium">Listen hardest here</div>
          <div className="flex flex-wrap gap-1.5">
            {row.qa_reasons.map((r) => {
              const at = /@(\d+)ms$/.exec(r);
              return at ? (
                <Button key={r} size="sm" variant="outline" className="h-7" onClick={() => seek(Math.max(0, Number(at[1]) - 3000))}>
                  {r.replace(/@\d+ms$/, "")} · {fmt(Number(at[1]))}
                </Button>
              ) : <Badge key={r} variant="outline">{r}</Badge>;
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading audio…</div>
      ) : (
        <>
          <canvas
            ref={canvasRef}
            width={1800}
            height={120}
            className="h-24 w-full cursor-pointer rounded border text-foreground/70"
            onClick={(e) => {
              const r = (e.target as HTMLCanvasElement).getBoundingClientRect();
              seek(((e.clientX - r.left) / r.width) * durationMs);
            }}
          />
          {audioUrl && <audio ref={audioRef} src={audioUrl} controls className="w-full" onTimeUpdate={onTime} />}
          <div className="text-xs text-muted-foreground">
            Heard {Math.round(coverage * 100)}% of {fmt(durationMs)} · red = bleeped ({bleeps.length})
          </div>
        </>
      )}

      <div className="max-h-80 overflow-y-auto rounded border p-3 text-sm leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="cursor-pointer hover:bg-muted/50" onClick={() => seek(l.start_ms)}>
            <span className="mr-2 font-mono text-xs text-muted-foreground">{fmt(l.start_ms)}</span>
            <span className="mr-1 font-medium">{l.speaker === "agent" ? "Agent" : "Customer"}:</span>
            {l.text.split(/(\[REDACTED:[A-Z_]+\])/).map((part, k) =>
              part.startsWith("[REDACTED") ? <span key={k} className="rounded bg-destructive/15 px-1 font-mono text-xs">{part}</span> : part,
            )}
          </div>
        ))}
      </div>

      {step ? (
        <div className="space-y-3 rounded-md border p-3">
          <div className="text-sm font-medium">{step === "qa" ? "QA review" : "Legal review"}</div>
          <div className="flex items-center gap-2">
            <Checkbox id="listened" checked={listened} disabled={!canTick} onCheckedChange={(v) => setListened(v === true)} />
            <Label htmlFor="listened" className={canTick ? "" : "text-muted-foreground"}>
              I listened to the full file{!canTick && " (unlocks after playing it through)"}
            </Label>
          </div>
          <Textarea placeholder="Notes (no personal details)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="flex gap-2">
            <Button disabled={!listened || busy} onClick={() => decide("approve")}>Approve</Button>
            <Button variant="destructive" disabled={busy} onClick={() => decide("reject")}>Reject</Button>
          </div>
        </div>
      ) : (
        <div className="text-sm text-muted-foreground">Status: {row.status}. No review step pending.</div>
      )}
    </div>
  );
}
