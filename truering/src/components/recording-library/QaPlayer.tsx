import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { fetchArtifact, fmtMs, link } from "./api";
import { useListenCoverage } from "./useListenCoverage";

type Span = { type: string; padded_start_ms: number; padded_end_ms: number };
type Line = { speaker: "customer" | "agent"; start_ms: number; end_ms: number; text: string };
type Interval = { start_ms: number; end_ms: number };
type Envelope<T> = { items: T };

/** Full redacted call: waveform with bleeps in red, the redacted transcript, second-pass flags to jump to. */
export function QaPlayer({ libraryCallId, qaReasons, onCoverage }: {
  libraryCallId: string;
  qaReasons: string[];
  onCoverage: (coverage: number) => void;
}) {
  const { toast } = useToast();
  const audioRef = useRef<HTMLAudioElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [peaks, setPeaks] = useState<number[] | null>(null);
  const [durationMs, setDurationMs] = useState(0);
  const [bleeps, setBleeps] = useState<Interval[]>([]);
  const [spans, setSpans] = useState<Span[]>([]);
  const [lines, setLines] = useState<Line[]>([]);
  const [loading, setLoading] = useState(true);
  const { heardS, onTimeUpdate, markSeek } = useListenCoverage();

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setPeaks(null);
    (async () => {
      try {
        const [url, sj, tj] = await Promise.all([
          link(libraryCallId, "audio"),
          fetchArtifact<Envelope<{ spans: Span[]; bleeps: Interval[] }>>(libraryCallId, "pii_spans_json"),
          fetchArtifact<Envelope<Line[]>>(libraryCallId, "transcript_json"),
        ]);
        if (cancelled) return;
        setAudioUrl(url);
        setSpans(sj.items?.spans ?? []);
        setBleeps(sj.items?.bleeps ?? []);
        setLines(Array.isArray(tj.items) ? tj.items : []);
        // waveform from the decoded file; decode at 4 kHz (an hour at 44.1 kHz would be ~600 MB in the tab)
        const buf = await (await fetch(url)).arrayBuffer();
        const ctx = new OfflineAudioContext(1, 4000, 4000);
        const audio = await ctx.decodeAudioData(buf);
        const data = audio.getChannelData(0);
        const n = 900, step = Math.max(1, Math.floor(data.length / n));
        const p: number[] = [];
        for (let i = 0; i < n; i++) {
          let m = 0;
          for (let k = i * step; k < (i + 1) * step; k += 8) m = Math.max(m, Math.abs(data[k] ?? 0));
          p.push(m);
        }
        if (!cancelled) { setPeaks(p); setDurationMs(audio.duration * 1000); }
      } catch (e) {
        toast({ title: "Could not load the call", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [libraryCallId, toast]);

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

  const coverage = durationMs ? Math.min(1, (heardS * 1000) / durationMs) : 0;
  useEffect(() => { onCoverage(coverage); }, [coverage, onCoverage]);

  const seek = (ms: number) => {
    const a = audioRef.current;
    if (a) { a.currentTime = ms / 1000; markSeek(a.currentTime); a.play(); }
  };

  const byType = useMemo(() => {
    const m: Record<string, number> = {};
    for (const s of spans) m[s.type] = (m[s.type] ?? 0) + 1;
    return Object.entries(m).sort((a, b) => b[1] - a[1]);
  }, [spans]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5 text-sm">
        {byType.map(([t, n]) => <Badge key={t} variant="secondary">{t} {n}</Badge>)}
      </div>

      {qaReasons.length > 0 && (
        <div className="rounded-md border border-destructive/40 p-3 text-sm">
          <div className="mb-1 font-medium">Second-pass and QA flags: listen hardest here</div>
          <div className="flex flex-wrap gap-1.5">
            {qaReasons.map((r) => {
              const at = /@(\d+)ms$/.exec(r);
              return at ? (
                <Button key={r} size="sm" variant="outline" className="h-7" onClick={() => seek(Math.max(0, Number(at[1]) - 3000))}>
                  {r.replace(/@\d+ms$/, "")} · {fmtMs(Number(at[1]))}
                </Button>
              ) : <Badge key={r} variant="outline">{r}</Badge>;
            })}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading the redacted call…</div>
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
          {audioUrl && (
            <audio ref={audioRef} src={audioUrl} controls controlsList="nodownload" className="w-full"
              onTimeUpdate={() => onTimeUpdate(audioRef.current)} />
          )}
          <div className="text-xs text-muted-foreground">
            Full call: heard {Math.round(coverage * 100)}% of {fmtMs(durationMs)} · red = bleeped ({bleeps.length})
          </div>
        </>
      )}

      <div className="max-h-72 overflow-y-auto rounded border p-3 text-sm leading-relaxed">
        {lines.map((l, i) => (
          <div key={i} className="cursor-pointer hover:bg-muted/50" onClick={() => seek(l.start_ms)}>
            <span className="mr-2 font-mono text-xs text-muted-foreground">{fmtMs(l.start_ms)}</span>
            <span className="mr-1 font-medium">{l.speaker === "agent" ? "Agent" : "Customer"}:</span>
            {l.text.split(/(\[REDACTED:[A-Z_]+\])/).map((part, k) =>
              part.startsWith("[REDACTED") ? <span key={k} className="rounded bg-destructive/15 px-1 font-mono text-xs">{part}</span> : part,
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** One exported clip: its own short-lived link (logged as listen evidence) and its own coverage. */
export function ClipPlayer({ libraryCallId, clipId, onCoverage }: { libraryCallId: string; clipId: string; onCoverage: (c: number) => void }) {
  const { toast } = useToast();
  const ref = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [dur, setDur] = useState(0);
  const { heardS, onTimeUpdate } = useListenCoverage();
  // +1: the last partial second of a short clip never reaches the next whole-second tick
  const coverage = dur ? Math.min(1, (heardS + 1) / Math.max(1, Math.ceil(dur))) : 0;
  useEffect(() => { onCoverage(coverage); }, [coverage, onCoverage]);

  if (!url) {
    return (
      <Button size="sm" variant="outline" onClick={async () => {
        try { setUrl(await link(libraryCallId, `clip:${clipId}`)); }
        catch (e) { toast({ title: "No clip link", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
      }}>Load clip</Button>
    );
  }
  return (
    <div className="space-y-1">
      <audio ref={ref} src={url} controls controlsList="nodownload" className="h-9 w-full"
        onLoadedMetadata={() => setDur(ref.current?.duration ?? 0)} onTimeUpdate={() => onTimeUpdate(ref.current)} />
      <div className="text-xs text-muted-foreground">heard {Math.round(coverage * 100)}%</div>
    </div>
  );
}
