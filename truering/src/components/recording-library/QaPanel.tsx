import { useCallback, useEffect, useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Trash2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { formatDuration } from "@/lib/format";
import { fmtMs, invoke, table } from "./api";
import { ClipPlayer, QaPlayer } from "./QaPlayer";
import { SCORE_KEYS, type CallSource, type Clip, type JobRow, type LibraryCall, type Review, type Scores } from "./types";

const FULL = 0.98;

function ScoreRow({ scores }: { scores?: Scores }) {
  if (!scores) return null;
  const shown = SCORE_KEYS.filter((k) => scores[k] != null);
  if (!shown.length) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((k) => <Badge key={k} variant="outline">{k} {scores[k]}/5</Badge>)}
    </div>
  );
}

/** QA view of one library call: full call + every clip, coaching, flags, edits, the review and publish actions. */
export function QaPanel({ call, job, source, onChanged, onDelete }: {
  call: LibraryCall;
  job: JobRow | undefined;
  source: CallSource | undefined;
  onChanged: () => void;
  onDelete?: (callId: string) => void;   // admin | superadmin only; absent on the AM portal
}) {
  const { toast } = useToast();
  const [clips, setClips] = useState<Clip[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [fullCoverage, setFullCoverage] = useState(0);
  const [clipCoverage, setClipCoverage] = useState<Record<string, number>>({});
  const [listened, setListened] = useState(false);
  const [notes, setNotes] = useState("");
  const [titles, setTitles] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    const [c, r] = await Promise.all([
      table("training_library_clips").select("id, library_call_id, clip_key, label, sub_label, start_ms, end_ms, audio_exported, title, coaching, confidence, sort_order")
        .eq("library_call_id", call.id).order("sort_order"),
      table("training_library_reviews").select("seq, library_call_id, reviewer, decision, listened_full, notes, created_at")
        .eq("library_call_id", call.id).order("seq", { ascending: false }),
    ]);
    if (c.error || r.error) toast({ title: "Could not load clips/reviews", description: (c.error ?? r.error)?.message, variant: "destructive" });
    const cl = (c.data as unknown as Clip[]) ?? [];
    setClips(cl);
    setTitles(Object.fromEntries(cl.map((x) => [x.id, x.title ?? ""])));
    setReviews((r.data as unknown as Review[]) ?? []);
    setLoading(false);
  }, [call.id, toast]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setListened(false); setFullCoverage(0); setClipCoverage({}); }, [call.id]);

  const exported = clips.filter((c) => c.audio_exported);
  const allClipsHeard = exported.every((c) => (clipCoverage[c.id] ?? 0) >= FULL);
  const canTick = fullCoverage >= FULL && allClipsHeard;
  const latest = reviews[0];
  const editable = call.status !== "published";
  const onFullCoverage = useCallback((v: number) => setFullCoverage(v), []);
  const clipCoverageSetters = useMemo(
    () => Object.fromEntries(clips.map((c) => [c.id, (v: number) => setClipCoverage((m) => (m[c.id] === v ? m : { ...m, [c.id]: v }))])),
    [clips],
  );

  const act = async (body: Record<string, unknown>, ok: string) => {
    setBusy(true);
    try {
      await invoke(body);
      toast({ title: ok });
      await load();
      onChanged();
    } catch (e) {
      toast({ title: "Not saved", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const saveTitles = () => {
    const changed = Object.fromEntries(clips.filter((c) => (titles[c.id] ?? "") !== (c.title ?? "")).map((c) => [c.id, titles[c.id]]));
    if (!Object.keys(changed).length) return;
    act({ action: "edit", library_call_id: call.id, clip_titles: changed }, "Clip titles saved");
  };

  const co = call.coaching ?? {};
  const turning = clips.find((c) => c.clip_key === co.turning_point_clip_id || c.id === co.turning_point_clip_id);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge variant="outline">{call.agent_ref}</Badge>
        <Badge variant="outline">v{call.version} · {job?.pipeline_version ?? "?"} · schema {job?.schema_version ?? "?"}</Badge>
        <Badge variant="outline">{formatDuration(call.duration_s)}</Badge>
        <Badge variant={call.status === "published" ? "default" : call.status === "rejected" ? "destructive" : "secondary"}>{call.status}</Badge>
        <Badge variant={job?.qa_flag ? "destructive" : "secondary"}>{job?.qa_flag ? `${job.qa_reasons.length} QA flags` : "no QA flags"}</Badge>
        <Badge variant="outline">{call.vertical}</Badge>
      </div>

      {call.audio_path ? (
        <QaPlayer libraryCallId={call.id} qaReasons={job?.qa_reasons ?? []} onCoverage={onFullCoverage} />
      ) : (
        <div className="text-sm text-muted-foreground">Audio removed (taken down).</div>
      )}

      {(co.summary || co.strengths?.length) && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-base">Call coaching {co.outcome && <span className="text-sm font-normal text-muted-foreground">· {co.outcome}</span>}</CardTitle></CardHeader>
          <CardContent className="space-y-2 text-sm">
            {co.summary && <p>{co.summary}</p>}
            <div className="grid gap-3 md:grid-cols-2">
              <div><div className="font-medium">Strengths</div><ul className="list-disc pl-5">{(co.strengths ?? []).map((s, i) => <li key={i}>{s}</li>)}</ul></div>
              <div><div className="font-medium">Improvements</div><ul className="list-disc pl-5">{(co.improvements ?? []).map((s, i) => <li key={i}>{s}</li>)}</ul></div>
            </div>
            <ScoreRow scores={co.scores} />
            {turning && <div className="text-xs text-muted-foreground">Turning point: {turning.clip_key} · {turning.label} at {fmtMs(turning.start_ms)}</div>}
            <div className="text-xs text-muted-foreground">rubric {co.rubric ?? "fe_v1"} · {co.model ?? ""}</div>
          </CardContent>
        </Card>
      )}

      <div className="space-y-2">
        <div className="text-sm font-medium">Clips ({clips.length})</div>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : clips.map((c) => (
          <div key={c.id} className="space-y-2 rounded-md border p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{c.label}{c.sub_label ? `: ${c.sub_label}` : ""}</Badge>
              <span className="font-mono text-xs text-muted-foreground">{c.clip_key} · {fmtMs(c.start_ms)}–{fmtMs(c.end_ms)}</span>
              {c.confidence != null && <span className="text-xs text-muted-foreground">conf {Number(c.confidence).toFixed(2)}</span>}
              {editable && (
                <Button size="sm" variant="ghost" className="ml-auto h-7 text-destructive" disabled={busy}
                  onClick={() => act({ action: "edit", library_call_id: call.id, drop_clip_ids: [c.id] }, `Clip ${c.clip_key} dropped`)}>
                  <Trash2 className="mr-1 h-3 w-3" />Drop
                </Button>
              )}
            </div>
            {editable ? (
              <Input value={titles[c.id] ?? ""} placeholder="Clip title" onChange={(e) => setTitles((t) => ({ ...t, [c.id]: e.target.value }))} />
            ) : <div className="font-medium">{c.title}</div>}
            {c.audio_exported
              ? <ClipPlayer libraryCallId={call.id} clipId={c.id} onCoverage={clipCoverageSetters[c.id]} />
              : <div className="text-xs text-muted-foreground">Audio not exported (application segment: coaching text only)</div>}
            <div className="grid gap-1 text-xs md:grid-cols-3">
              {c.coaching?.did && <div><b>Did:</b> {c.coaching.did}</div>}
              {c.coaching?.worked && <div><b>Worked:</b> {c.coaching.worked}</div>}
              {c.coaching?.improve && <div><b>Improve:</b> {c.coaching.improve}</div>}
            </div>
            {(c.coaching?.key_lines ?? []).map((k, i) => <blockquote key={i} className="border-l-2 pl-2 text-xs italic">{k}</blockquote>)}
            <ScoreRow scores={c.coaching?.scores} />
          </div>
        ))}
        {editable && clips.length > 0 && <Button size="sm" variant="outline" disabled={busy} onClick={saveTitles}>Save clip titles</Button>}
      </div>

      <div className="space-y-3 rounded-md border p-3">
        <div className="text-sm font-medium">QA review</div>
        {latest && (
          <div className="text-xs text-muted-foreground">
            Latest: {latest.decision}{latest.listened_full ? " (listened in full)" : ""} · {new Date(latest.created_at).toLocaleString()}{latest.notes ? ` · ${latest.notes}` : ""}
          </div>
        )}
        {editable && call.audio_path ? (
          <>
            <div className="flex items-center gap-2">
              <Checkbox id="listened" checked={listened} disabled={!canTick} onCheckedChange={(v) => setListened(v === true)} />
              <Label htmlFor="listened" className={canTick ? "" : "text-muted-foreground"}>
                I listened to the full call and every clip
                {!canTick && ` (unlocks after playing them through: call ${Math.round(fullCoverage * 100)}%, clips ${exported.filter((c) => (clipCoverage[c.id] ?? 0) >= FULL).length}/${exported.length})`}
              </Label>
            </div>
            <Textarea placeholder="Notes (no personal details)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <div className="flex flex-wrap gap-2">
              <Button disabled={!listened || busy} onClick={() => act({ action: "review", library_call_id: call.id, decision: "approve", listened_full: true, notes: notes || null }, "Approved")}>Approve</Button>
              <Button variant="destructive" disabled={busy} onClick={() => act({ action: "review", library_call_id: call.id, decision: "reject", listened_full: listened, notes: notes || null }, "Rejected")}>Reject</Button>
              <Button variant="secondary" disabled={busy || latest?.decision !== "approve" || !latest?.listened_full}
                onClick={() => act({ action: "publish", library_call_id: call.id }, "Published to the training library")}>Publish</Button>
            </div>
          </>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {call.status !== "withdrawn" && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => act({ action: "withdraw", library_call_id: call.id, notes: notes || null }, "Withdrawn")}>Withdraw</Button>
          )}
          {source && onDelete && (
            <Button size="sm" variant="destructive" disabled={busy} onClick={() => onDelete(source.call_id)}>
              <Trash2 className="mr-1 h-3 w-3" />Delete
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
