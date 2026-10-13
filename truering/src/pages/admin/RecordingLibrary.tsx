// /admin/recording-library and /am/recording-library (portal="am"): Recording Library curation (TR_PLAN v0.2 RL-5).
// Reads the RL-1 tables directly (staff RLS); every write goes through the training-library-admin edge function.
// Scope (Dmitry 2026-10-13 12:44 PM): ended Sale calls of every vertical, internal training only, a full human listen before publish.
import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Ban, Download, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { formatDuration } from "@/lib/format";
import { recordingLibraryEnabled } from "@/lib/recordingLibraryFlag";
import { invoke, table } from "@/components/recording-library/api";
import { QaPanel } from "@/components/recording-library/QaPanel";
import {
  ACTIVE, DEFAULT_CARRIER_TERMS, type CallSource, type Clip, type JobRow, type LibraryCall, type Rating,
} from "@/components/recording-library/types";

type PickRow = { id: string; duration: number; created_at: string; agent_id: string; agent_name: string; vertical: string | null };

const statusTone = (s: string): "default" | "secondary" | "destructive" | "outline" =>
  s === "done" || s === "published" ? "default" : s === "failed" || s === "rejected" ? "destructive" : ACTIVE.has(s) ? "secondary" : "outline";

const JOB_COLS = "id, call_id, version, idempotency_key, status, error_code, error_detail, qa_flag, qa_reasons, metrics, engine, cost_usd, reserved_usd, pipeline_version, schema_version, call_meta, created_at, completed_at";
const CALL_COLS = "id, job_id, version, vertical, agent_ref, duration_s, audio_path, coaching, title, tags, status, published_at, created_at";

export default function RecordingLibrary({ portal = "admin" }: { portal?: "admin" | "am" }) {
  const { toast } = useToast();
  const [flagOn, setFlagOn] = useState<boolean | null>(null);
  const [tab, setTab] = useState("pick");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [calls, setCalls] = useState<LibraryCall[]>([]);
  const [sources, setSources] = useState<CallSource[]>([]);
  const [loadingLists, setLoadingLists] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => { recordingLibraryEnabled().then(setFlagOn); }, []);

  const loadLists = useCallback(async () => {
    const [j, c, s] = await Promise.all([
      table("sample_redaction_jobs").select(JOB_COLS).order("created_at", { ascending: false }).limit(200),
      table("training_library_calls").select(CALL_COLS).order("created_at", { ascending: false }).limit(300),
      table("training_library_call_sources").select("library_call_id, call_id, source_agent_id, consent_id").limit(1000),
    ]);
    const err = j.error ?? c.error ?? s.error;
    if (err) toast({ title: "Could not load the library", description: err.message, variant: "destructive" });
    setJobs((j.data as unknown as JobRow[]) ?? []);
    setCalls((c.data as unknown as LibraryCall[]) ?? []);
    setSources((s.data as unknown as CallSource[]) ?? []);
    setLoadingLists(false);
  }, [toast]);

  useEffect(() => {
    if (!flagOn) return;
    invoke({ action: "sweep" }).catch(() => undefined).finally(loadLists);
  }, [flagOn, loadLists]);

  // poll while anything is running
  useEffect(() => {
    if (!jobs.some((j) => ACTIVE.has(j.status))) return;
    const t = setInterval(loadLists, 10_000);
    return () => clearInterval(t);
  }, [jobs, loadLists]);

  const monthSpend = useMemo(() => {
    const m = new Date(); const start = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1);
    return jobs.filter((j) => new Date(j.created_at).getTime() >= start)
      .reduce((s, j) => s + (ACTIVE.has(j.status) ? Math.max(Number(j.cost_usd), Number(j.reserved_usd)) : Number(j.cost_usd ?? 0)), 0);
  }, [jobs]);

  const jobById = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs]);
  const sourceByCall = useMemo(() => new Map(sources.map((s) => [s.library_call_id, s])), [sources]);
  const pending = calls.filter((c) => c.status === "pending_qa");

  const exportManifest = async () => {
    const { data, error } = await table("training_library_manifest").select("*").limit(5000);
    if (error) { toast({ title: "Export failed", description: error.message, variant: "destructive" }); return; }
    const rows = (data as unknown as Record<string, unknown>[]) ?? [];
    const cols = rows.length ? Object.keys(rows[0]) : ["library_call_id"];
    const cell = (v: unknown) => {
      const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const csv = [cols.join(","), ...rows.map((r) => cols.map((k) => cell(r[k])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `training-library-manifest-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const runDelete = async (callId: string) => {
    try {
      const r = await invoke<{ ok?: boolean; second_purge_ok?: boolean; detail?: string }>({ action: "delete", call_id: callId });
      if (r?.second_purge_ok === false) {
        toast({ title: "Deleted; a late file could not be removed yet — run delete again", description: r.detail ?? undefined, variant: "destructive" });
      } else toast({ title: "Deleted from the library" });
    } catch (e) {
      toast({ title: "Delete failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
    loadLists();
  };

  if (flagOn === null) return <Loader2 className="h-5 w-5 animate-spin" />;
  if (!flagOn) {
    return (
      <div className="space-y-6">
        <PageHeader title="Recording Library" description="Internal training library of redacted sales calls, filed by vertical." />
        <Alert><AlertDescription>The Recording Library is switched off (flag <code>recording_library</code>).</AlertDescription></Alert>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recording Library"
        description="Smart clips and coaching from PII-bleeped sales calls, for internal training. Every call and clip gets a full human listen before it is published."
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={exportManifest}><Download className="mr-2 h-4 w-4" />Manifest CSV</Button>
            <Button variant="outline" size="sm" onClick={loadLists}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>
          </div>
        }
      />
      <Alert>
        <AlertDescription className="text-sm">
          Internal training only: ended <b>Sale</b> calls, filed under the call's vertical. Publishing needs a QA approval after listening to the full call and every clip.
          Spend this month: <b>${monthSpend.toFixed(2)}</b> of $100.
        </AlertDescription>
      </Alert>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pick">Pick calls</TabsTrigger>
          <TabsTrigger value="jobs">Jobs {jobs.some((j) => ACTIVE.has(j.status)) && <Loader2 className="ml-1 h-3 w-3 animate-spin" />}</TabsTrigger>
          <TabsTrigger value="review">QA {pending.length > 0 && <Badge variant="secondary" className="ml-1">{pending.length}</Badge>}</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
          <TabsTrigger value="ratings">Ratings</TabsTrigger>
        </TabsList>
        <TabsContent value="pick"><Picker portal={portal} jobs={jobs} onSubmitted={() => { loadLists(); setTab("jobs"); }} /></TabsContent>
        <TabsContent value="jobs"><Jobs jobs={jobs} loading={loadingLists} onChanged={loadLists} canCancel={portal === "admin"} /></TabsContent>
        <TabsContent value="review">
          <Review rows={pending} jobById={jobById} sourceByCall={sourceByCall} onChanged={loadLists} onDelete={portal === "admin" ? setConfirmDelete : undefined} />
        </TabsContent>
        <TabsContent value="library">
          <Review rows={calls.filter((c) => c.status !== "pending_qa")} jobById={jobById} sourceByCall={sourceByCall} onChanged={loadLists} onDelete={portal === "admin" ? setConfirmDelete : undefined} empty="Nothing reviewed yet." />
        </TabsContent>
        <TabsContent value="ratings"><Ratings calls={calls} /></TabsContent>
      </Tabs>

      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Delete this call from the library?</DialogTitle></DialogHeader>
            <p className="text-sm">
              Removes every version's audio, clips, transcripts and coaching from TR storage and deletes the library, clip, review,
              rating and job rows. No record of the call is kept (only each job's spend, for the month cap). Refused while a job for this call is still running: cancel it in Jobs first. This cannot be undone.
            </p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="destructive" onClick={() => { const id = confirmDelete; setConfirmDelete(null); runDelete(id); }}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ── Pick ────────────────────────────────────────────────────────────────────
function Picker({ portal, jobs, onSubmitted }: { portal: "admin" | "am"; jobs: JobRow[]; onSubmitted: () => void }) {
  const { toast } = useToast();
  const [rows, setRows] = useState<PickRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [agent, setAgent] = useState("all");
  const [minMin, setMinMin] = useState(10);
  const [maxMin, setMaxMin] = useState(40);
  const [target, setTarget] = useState<PickRow | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      // server-side list: calls RLS limits an AM to their own book, and AM curation is global
      type PickApi = { id: string; duration: number; created_at: string; agent_id: string; agent_name: string | null; vertical: string | null };
      try {
        const r = await invoke<{ rows: PickApi[] }>({ action: "pick", min_s: minMin * 60, max_s: maxMin * 60 });
        setRows(r.rows.map((c) => ({ id: c.id, duration: c.duration, created_at: c.created_at, agent_id: c.agent_id, agent_name: c.agent_name ?? "—", vertical: c.vertical })));
      } catch (e) {
        toast({ title: "Could not load calls", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
        setRows([]);
      }
      setLoading(false);
    })();
  }, [minMin, maxMin, toast]);

  const agents = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const r of rows) m.set(r.agent_id, { name: r.agent_name, n: (m.get(r.agent_id)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [rows]);
  const jobByCall = useMemo(() => {
    const m = new Map<string, JobRow>();
    for (const j of jobs) if (!m.has(j.call_id) || m.get(j.call_id)!.version < j.version) m.set(j.call_id, j);
    return m;
  }, [jobs]);
  const shown = rows.filter((r) => agent === "all" || r.agent_id === agent);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recorded sales</CardTitle>
        <CardDescription>
          Ended Sale calls with a Telnyx recording, every vertical. A call whose vertical cannot be resolved cannot be submitted.
          {portal === "am" && " AM curation is global: every agent's calls are listed, not only your book."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="w-64">
            <Label>Agent</Label>
            <Select value={agent} onValueChange={setAgent}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All agents ({rows.length})</SelectItem>
                {agents.map(([id, a]) => <SelectItem key={id} value={id}>{a.name} ({a.n})</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="w-28"><Label>Min minutes</Label><Input type="number" value={minMin} onChange={(e) => setMinMin(Number(e.target.value) || 0)} /></div>
          <div className="w-28"><Label>Max minutes</Label><Input type="number" max={60} value={maxMin} onChange={(e) => setMaxMin(Math.min(60, Number(e.target.value) || 60))} /></div>
        </div>
        {loading ? <Loader2 className="h-5 w-5 animate-spin" /> : (
          <Table>
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Agent</TableHead><TableHead>Vertical</TableHead><TableHead>Length</TableHead><TableHead>Job</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {shown.slice(0, 100).map((r) => {
                const j = jobByCall.get(r.id);
                const ok = !!r.vertical;
                return (
                  <TableRow key={r.id}>
                    <TableCell>{new Date(r.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>{r.agent_name}</TableCell>
                    <TableCell>{r.vertical ? <Badge variant="outline">{r.vertical}</Badge> : <Badge variant="secondary">unknown</Badge>}</TableCell>
                    <TableCell>{formatDuration(r.duration)}</TableCell>
                    <TableCell>{j ? <Badge variant={statusTone(j.status)}>v{j.version} {j.status}</Badge> : "—"}</TableCell>
                    <TableCell className="text-right">
                      <Button size="sm" disabled={!ok} onClick={() => setTarget(r)}>{j ? "Reprocess" : "Submit"}</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </CardContent>
      {target && <SubmitDialog call={target} reprocess={jobByCall.has(target.id)} onClose={() => setTarget(null)} onDone={() => { setTarget(null); onSubmitted(); }} />}
    </Card>
  );
}

function SubmitDialog({ call, reprocess, onClose, onDone }: { call: PickRow; reprocess: boolean; onClose: () => void; onDone: () => void }) {
  const { toast } = useToast();
  const [pitch, setPitch] = useState(false);     // SPEC v0.2: off for internal training
  const [health, setHealth] = useState(true);
  const [clips, setClips] = useState(true);
  const [coaching, setCoaching] = useState(true);
  const [customerChannel, setCustomerChannel] = useState<"0" | "1">("0");
  const [terms, setTerms] = useState(DEFAULT_CARRIER_TERMS.join("\n"));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await invoke<{ existing?: boolean; idempotency_key?: string }>({
        action: "submit",
        call_id: call.id,
        reprocess,
        options: {
          pitch_shift_customer: pitch,
          redact_health: health,
          clips: { enabled: clips },
          coaching: { enabled: coaching },
          customer_channel: Number(customerChannel),
          extra_terms: terms.split("\n").map((t) => t.trim()).filter(Boolean),
        },
      });
      toast({ title: r.existing ? "Already submitted" : "Queued: the worker picks it up within about 20 s", description: r.idempotency_key });
      onDone();
    } catch (e) {
      toast({ title: "Not submitted", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{reprocess ? "Reprocess" : "Submit"} call · {call.agent_name} · {formatDuration(call.duration)}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <Label>Customer is on channel</Label>
            <Select value={customerChannel} onValueChange={(v) => setCustomerChannel(v as "0" | "1")}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="0">0 (left)</SelectItem><SelectItem value="1">1 (right)</SelectItem></SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">Unverified until the pilot confirms Telnyx's channel order; every result is QA-flagged until then.</p>
          <div className="flex items-center justify-between"><Label>Pitch-shift the customer</Label><Switch checked={pitch} onCheckedChange={setPitch} /></div>
          <div className="flex items-center justify-between"><Label>Bleep health conditions and medications</Label><Switch checked={health} onCheckedChange={setHealth} /></div>
          <div className="flex items-center justify-between"><Label>Smart clips (up to 6, 20–240 s)</Label><Switch checked={clips} onCheckedChange={setClips} /></div>
          <div className="flex items-center justify-between"><Label>AI coaching (rubric fe_v1)</Label><Switch checked={coaching} onCheckedChange={setCoaching} /></div>
          <div>
            <Label>Extra terms to bleep (one per line)</Label>
            <Textarea rows={6} value={terms} onChange={(e) => setTerms(e.target.value)} />
            <p className="mt-1 text-xs text-muted-foreground">The agent's and caller's names from TR are added automatically and never stored on the job.</p>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button disabled={busy} onClick={submit}>{busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}Start</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Jobs ────────────────────────────────────────────────────────────────────
function Jobs({ jobs, loading, onChanged, canCancel }: { jobs: JobRow[]; loading: boolean; onChanged: () => void; canCancel: boolean }) {
  const { toast } = useToast();
  // Dmitry 1:41 PM: cancel stops the worker's run (next poll, ~20 s) and deletes nothing on its side; delete is allowed after
  const cancel = async (callId: string) => {
    try {
      const r = await invoke<{ cancelled?: number; live_runs?: number }>({ action: "cancel", call_id: callId });
      toast({ title: r?.cancelled ? "Cancelled" : "Nothing running", description: r?.live_runs ? "The worker stops it on its next poll (about 20 s); delete works after that." : undefined });
    } catch (e) { toast({ title: "Not cancelled", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
    onChanged();
  };
  const retry = async (id: string) => {
    try { await invoke({ action: "retry", job_id: id }); toast({ title: "Restarted" }); }
    catch (e) { toast({ title: "Not restarted", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
    onChanged();
  };
  if (loading) return <Loader2 className="h-5 w-5 animate-spin" />;
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Call</TableHead><TableHead>Status</TableHead><TableHead>QA</TableHead><TableHead>Cost</TableHead><TableHead>Pipeline</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id} className={j.status === "deleted" ? "opacity-50" : ""}>
                <TableCell>{new Date(j.created_at).toLocaleString()}</TableCell>
                <TableCell className="font-mono text-xs">{j.call_id.slice(0, 8)} v{j.version}</TableCell>
                <TableCell>
                  <Badge variant={statusTone(j.status)}>{j.status}</Badge>
                  {j.error_code && <div className="mt-1 text-xs text-destructive">{j.error_code}{j.error_detail ? `: ${j.error_detail}` : ""}</div>}
                </TableCell>
                <TableCell>{j.status !== "done" ? "—" : j.qa_flag ? <Badge variant="destructive">{j.qa_reasons.length} flags</Badge> : <Badge variant="secondary">clean</Badge>}</TableCell>
                <TableCell>
                  ${Number(j.cost_usd ?? 0).toFixed(2)}
                  {ACTIVE.has(j.status) && <div className="text-xs text-muted-foreground">reserved ${Number(j.reserved_usd ?? 0).toFixed(2)}</div>}
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{j.pipeline_version ?? "—"}{j.schema_version ? ` · ${j.schema_version}` : ""}</TableCell>
                <TableCell className="text-right">
                  {j.status === "failed" && (
                    <Button size="sm" variant="outline" onClick={() => retry(j.id)}><RotateCcw className="mr-1 h-3 w-3" />Retry</Button>
                  )}
                  {canCancel && ACTIVE.has(j.status) && (
                    <Button size="sm" variant="outline" onClick={() => cancel(j.call_id)}><Ban className="mr-1 h-3 w-3" />Cancel</Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ── QA / Library ────────────────────────────────────────────────────────────
function Review({ rows, jobById, sourceByCall, onChanged, onDelete, empty = "Nothing waiting for QA." }: {
  rows: LibraryCall[];
  jobById: Map<string, JobRow>;
  sourceByCall: Map<string, CallSource>;
  onChanged: () => void;
  onDelete?: (callId: string) => void;
  empty?: string;
}) {
  const [sel, setSel] = useState<string | null>(null);
  const row = rows.find((r) => r.id === sel) ?? rows[0];
  if (!rows.length) return <Card><CardContent className="pt-6 text-sm text-muted-foreground">{empty}</CardContent></Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
      <Card>
        <CardContent className="max-h-[70vh] space-y-1 overflow-y-auto pt-6">
          {rows.map((r) => {
            const j = r.job_id ? jobById.get(r.job_id) : undefined;
            return (
              <button key={r.id} onClick={() => setSel(r.id)} className={`w-full rounded px-2 py-1.5 text-left text-sm ${row?.id === r.id ? "bg-muted" : "hover:bg-muted/50"}`}>
                <div className="font-medium">{r.title || `${r.agent_ref} · ${formatDuration(r.duration_s)}`}</div>
                <div className="text-xs text-muted-foreground">{r.status} · {j?.qa_flag ? `${j.qa_reasons.length} flags` : "no flags"}</div>
              </button>
            );
          })}
        </CardContent>
      </Card>
      <Card>
        <CardContent className="pt-6">
          {row && (
            <QaPanel key={row.id} call={row} job={row.job_id ? jobById.get(row.job_id) : undefined} source={sourceByCall.get(row.id)}
              onChanged={onChanged} onDelete={onDelete} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Ratings (staff only; never shown to agents) ─────────────────────────────
function Ratings({ calls }: { calls: LibraryCall[] }) {
  const { toast } = useToast();
  const [ratings, setRatings] = useState<Rating[]>([]);
  const [clips, setClips] = useState<Map<string, Pick<Clip, "id" | "library_call_id" | "clip_key" | "label" | "title">>>(new Map());
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const [r, c] = await Promise.all([
        table("training_library_ratings").select("item_type, item_id, vote, comment, updated_at").order("updated_at", { ascending: false }).limit(5000),
        table("training_library_clips").select("id, library_call_id, clip_key, label, title").limit(5000),
      ]);
      if (r.error || c.error) toast({ title: "Could not load ratings", description: (r.error ?? c.error)?.message, variant: "destructive" });
      setRatings((r.data as unknown as Rating[]) ?? []);
      setClips(new Map((((c.data as unknown) as Clip[]) ?? []).map((x) => [x.id, x])));
      setLoading(false);
    })();
  }, [toast]);

  const callById = useMemo(() => new Map(calls.map((c) => [c.id, c])), [calls]);
  const items = useMemo(() => {
    const m = new Map<string, { type: "call" | "clip"; id: string; up: number; down: number; comments: string[] }>();
    for (const r of ratings) {
      const k = `${r.item_type}:${r.item_id}`;
      const e = m.get(k) ?? { type: r.item_type, id: r.item_id, up: 0, down: 0, comments: [] };
      if (r.vote === 1) e.up++; else e.down++;
      if (r.comment) e.comments.push(r.comment);
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => (b.up - b.down) - (a.up - a.down));
  }, [ratings]);

  const name = (t: "call" | "clip", id: string) => {
    if (t === "call") { const c = callById.get(id); return c ? c.title || `${c.agent_ref} · ${formatDuration(c.duration_s)}` : id.slice(0, 8); }
    const k = clips.get(id);
    if (!k) return id.slice(0, 8);
    const c = callById.get(k.library_call_id);
    return `${k.title || `${k.clip_key} ${k.label}`} (${c?.agent_ref ?? "?"})`;
  };

  if (loading) return <Loader2 className="h-5 w-5 animate-spin" />;
  if (!items.length) return <Card><CardContent className="pt-6 text-sm text-muted-foreground">No agent ratings yet.</CardContent></Card>;
  return (
    <Card>
      <CardHeader><CardDescription>Agent votes are an internal record: never shown to other agents.</CardDescription></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow><TableHead>Item</TableHead><TableHead>Up</TableHead><TableHead>Down</TableHead><TableHead>Net</TableHead><TableHead>Comments</TableHead></TableRow></TableHeader>
          <TableBody>
            {items.map((i) => (
              <TableRow key={`${i.type}:${i.id}`}>
                <TableCell><Badge variant="outline" className="mr-2">{i.type}</Badge>{name(i.type, i.id)}</TableCell>
                <TableCell className="text-green-600">{i.up}</TableCell>
                <TableCell className="text-destructive">{i.down}</TableCell>
                <TableCell className="font-medium">{i.up - i.down}</TableCell>
                <TableCell className="max-w-md text-xs">{i.comments.slice(0, 5).map((c, k) => <div key={k}>“{c}”</div>)}{i.comments.length > 5 && <div>+{i.comments.length - 5} more</div>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
