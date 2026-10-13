import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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
import { Loader2, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/shared/PageHeader";
import { formatDuration } from "@/lib/format";
import { extractFnError } from "@/lib/edgeFunctionError";
import { QaPlayer } from "@/components/admin/sample-library/QaPlayer";
import { ACTIVE, DEFAULT_CARRIER_TERMS, type JobRow, type LibraryRow } from "@/components/admin/sample-library/types";

// /admin/sample-library — PII-redacted sales-call samples (spec v0.1, 2026-10-12).
// Reads the sample_* tables directly (admin RLS); every write goes through the
// sample-library-admin edge function. v1 scope: Final Expense Sale calls only.

type PickRow = { id: string; duration: number; created_at: string; agent_id: string; agent_name: string };

const invoke = async (body: Record<string, unknown>) => {
  const { data, error } = await supabase.functions.invoke("sample-library-admin", { body });
  if (error) throw new Error((await extractFnError(error)) ?? "The sample service failed; try again.");
  return data;
};

const statusTone = (s: string): "default" | "secondary" | "destructive" | "outline" =>
  s === "done" || s === "published" ? "default" : s === "failed" || s === "rejected" ? "destructive" : ACTIVE.has(s) ? "secondary" : "outline";

export default function SampleLibrary() {
  const { toast } = useToast();
  const [tab, setTab] = useState("pick");
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [library, setLibrary] = useState<LibraryRow[]>([]);
  const [loadingLists, setLoadingLists] = useState(true);

  const loadLists = useCallback(async () => {
    const [j, l] = await Promise.all([
      supabase.from("sample_redaction_jobs" as never).select("id, call_id, version, status, error_code, error_detail, qa_flag, qa_reasons, cost_usd, pipeline_version, created_at, completed_at, deleted_at, call_meta").order("created_at", { ascending: false }).limit(100),
      supabase.from("sample_library" as never).select("id, call_id, job_id, version, agent_ref, vertical, duration_s, highlight_audio_path, highlight_start_ms, highlight_end_ms, qa_flag, qa_reasons, title, tags, consent_ref, status, pipeline_version, created_at, deleted_at").order("created_at", { ascending: false }).limit(200),
    ]);
    if (j.error || l.error) toast({ title: "Could not load", description: (j.error ?? l.error)?.message, variant: "destructive" });
    setJobs((j.data as unknown as JobRow[]) ?? []);
    setLibrary((l.data as unknown as LibraryRow[]) ?? []);
    setLoadingLists(false);
  }, [toast]);

  useEffect(() => {
    invoke({ action: "sweep" }).catch(() => undefined).finally(loadLists);
  }, [loadLists]);

  // poll while anything is running
  useEffect(() => {
    if (!jobs.some((j) => ACTIVE.has(j.status))) return;
    const t = setInterval(loadLists, 10_000);
    return () => clearInterval(t);
  }, [jobs, loadLists]);

  const monthSpend = useMemo(() => {
    const m = new Date(); const start = Date.UTC(m.getUTCFullYear(), m.getUTCMonth(), 1);
    return jobs.filter((j) => new Date(j.created_at).getTime() >= start).reduce((s, j) => s + Number(j.cost_usd ?? 0), 0);
  }, [jobs]);

  const review = library.filter((r) => r.status === "pending_qa" || r.status === "qa_passed");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Sample Library"
        description="PII-bleeped Final Expense sales calls for internal training. Every file gets a full human listen before it is published."
        actions={<Button variant="outline" size="sm" onClick={loadLists}><RefreshCw className="mr-2 h-4 w-4" />Refresh</Button>}
      />
      <Alert>
        <AlertDescription className="text-sm">
          v1 is internal only: Final Expense <b>Sale</b> calls, no Medicare/ACA. Publishing needs QA + legal sign-off (both with a full listen) and the agent's signed release. Spend this month: <b>${monthSpend.toFixed(2)}</b> of $100.
        </AlertDescription>
      </Alert>

      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="pick">Pick calls</TabsTrigger>
          <TabsTrigger value="jobs">Jobs {jobs.some((j) => ACTIVE.has(j.status)) && <Loader2 className="ml-1 h-3 w-3 animate-spin" />}</TabsTrigger>
          <TabsTrigger value="review">Review {review.length > 0 && <Badge variant="secondary" className="ml-1">{review.length}</Badge>}</TabsTrigger>
          <TabsTrigger value="library">Library</TabsTrigger>
        </TabsList>
        <TabsContent value="pick"><Picker jobs={jobs} onSubmitted={() => { loadLists(); setTab("jobs"); }} /></TabsContent>
        <TabsContent value="jobs"><Jobs jobs={jobs} loading={loadingLists} onChanged={loadLists} /></TabsContent>
        <TabsContent value="review"><Review rows={review} onChanged={loadLists} /></TabsContent>
        <TabsContent value="library"><LibraryGrid rows={library} onChanged={loadLists} /></TabsContent>
      </Tabs>
    </div>
  );
}

// ── Pick ────────────────────────────────────────────────────────────────────
function Picker({ jobs, onSubmitted }: { jobs: JobRow[]; onSubmitted: () => void }) {
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
      const { data: disp } = await supabase.from("call_dispositions").select("id").eq("name", "Sale").maybeSingle();
      if (!disp) { setRows([]); setLoading(false); return; }
      const { data, error } = await supabase
        .from("calls")
        .select("id, duration, created_at, agent_id, recording_url, agents:agent_id(full_name)")
        .eq("disposition_id", disp.id)
        .not("recording_url", "is", null)
        .gte("duration", minMin * 60)
        .lte("duration", maxMin * 60)
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) toast({ title: "Could not load calls", description: error.message, variant: "destructive" });
      type CallPick = { id: string; duration: number; created_at: string; agent_id: string; recording_url: string; agents: { full_name: string } | null };
      setRows(((data as unknown as CallPick[]) ?? [])
        .filter((c) => /telephony-recorder|telnyx|X-Amz-/.test(String(c.recording_url)))   // v1: Telnyx recordings only
        .map((c) => ({ id: c.id, duration: c.duration, created_at: c.created_at, agent_id: c.agent_id, agent_name: c.agents?.full_name ?? "—" })));
      setLoading(false);
    })();
  }, [minMin, maxMin, toast]);

  const agents = useMemo(() => {
    const m = new Map<string, { name: string; n: number }>();
    for (const r of rows) m.set(r.agent_id, { name: r.agent_name, n: (m.get(r.agent_id)?.n ?? 0) + 1 });
    return [...m.entries()].sort((a, b) => b[1].n - a[1].n);
  }, [rows]);
  const jobByCall = useMemo(() => new Map(jobs.map((j) => [j.call_id, j])), [jobs]);
  const shown = rows.filter((r) => agent === "all" || r.agent_id === agent);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recorded sales</CardTitle>
        <CardDescription>Final Expense Sale calls with a Telnyx recording. Pick one to redact.</CardDescription>
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
            <TableHeader><TableRow><TableHead>Date</TableHead><TableHead>Agent</TableHead><TableHead>Length</TableHead><TableHead>Sample</TableHead><TableHead /></TableRow></TableHeader>
            <TableBody>
              {shown.slice(0, 100).map((r) => {
                const j = jobByCall.get(r.id);
                return (
                  <TableRow key={r.id}>
                    <TableCell>{new Date(r.created_at).toLocaleDateString()}</TableCell>
                    <TableCell>{r.agent_name}</TableCell>
                    <TableCell>{formatDuration(r.duration)}</TableCell>
                    <TableCell>{j ? <Badge variant={statusTone(j.status)}>v{j.version} {j.status}</Badge> : "—"}</TableCell>
                    <TableCell className="text-right"><Button size="sm" onClick={() => setTarget(r)}>{j ? "Reprocess" : "Redact"}</Button></TableCell>
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
  const [pitch, setPitch] = useState(true);
  const [health, setHealth] = useState(true);
  const [highlight, setHighlight] = useState(true);
  const [targetMin, setTargetMin] = useState(5);
  const [customerChannel, setCustomerChannel] = useState<"0" | "1">("0");
  const [terms, setTerms] = useState(DEFAULT_CARRIER_TERMS.join("\n"));
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const r = await invoke({
        action: "submit",
        call_id: call.id,
        reprocess,
        options: {
          pitch_shift_customer: pitch,
          redact_health: health,
          highlight: { enabled: highlight, target_s: targetMin * 60 },
          customer_channel: Number(customerChannel),
          extra_terms: terms.split("\n").map((t) => t.trim()).filter(Boolean),
        },
      });
      toast({ title: r.existing ? "Already submitted" : "Submitted", description: r.idempotency_key });
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
        <DialogHeader><DialogTitle>{reprocess ? "Reprocess" : "Redact"} call · {call.agent_name} · {formatDuration(call.duration)}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between"><Label>Pitch-shift the customer</Label><Switch checked={pitch} onCheckedChange={setPitch} /></div>
          <div className="flex items-center justify-between"><Label>Bleep health conditions and medications</Label><Switch checked={health} onCheckedChange={setHealth} /></div>
          <div className="flex items-center justify-between"><Label>Highlight clip</Label><Switch checked={highlight} onCheckedChange={setHighlight} /></div>
          {highlight && <div className="flex items-center justify-between"><Label>Target length (3–8 min)</Label><Input className="w-20" type="number" min={3} max={8} value={targetMin} onChange={(e) => setTargetMin(Math.min(8, Math.max(3, Number(e.target.value) || 5)))} /></div>}
          <div className="flex items-center justify-between">
            <Label>Customer is on channel</Label>
            <Select value={customerChannel} onValueChange={(v) => setCustomerChannel(v as "0" | "1")}>
              <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="0">0 (left)</SelectItem><SelectItem value="1">1 (right)</SelectItem></SelectContent>
            </Select>
          </div>
          <p className="text-xs text-muted-foreground">Unverified until the pilot confirms Telnyx's channel order; every result is QA-flagged until then.</p>
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
function Jobs({ jobs, loading, onChanged }: { jobs: JobRow[]; loading: boolean; onChanged: () => void }) {
  const { toast } = useToast();
  const act = async (body: Record<string, unknown>, ok: string) => {
    try { await invoke(body); toast({ title: ok }); } catch (e) { toast({ title: "Failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
    onChanged();
  };
  if (loading) return <Loader2 className="h-5 w-5 animate-spin" />;
  return (
    <Card>
      <CardContent className="pt-6">
        <Table>
          <TableHeader><TableRow><TableHead>Started</TableHead><TableHead>Call</TableHead><TableHead>Agent</TableHead><TableHead>Status</TableHead><TableHead>QA</TableHead><TableHead>Cost</TableHead><TableHead /></TableRow></TableHeader>
          <TableBody>
            {jobs.map((j) => (
              <TableRow key={j.id} className={j.deleted_at ? "opacity-50" : ""}>
                <TableCell>{new Date(j.created_at).toLocaleString()}</TableCell>
                <TableCell className="font-mono text-xs">{j.call_id.slice(0, 8)} v{j.version}</TableCell>
                <TableCell>{j.call_meta?.agent_ref ?? "—"}</TableCell>
                <TableCell>
                  <Badge variant={statusTone(j.status)}>{j.status}</Badge>
                  {j.error_code && <div className="mt-1 text-xs text-destructive">{j.error_code}{j.error_detail ? `: ${j.error_detail}` : ""}</div>}
                  {j.deleted_at && <div className="mt-1 text-xs">deleted</div>}
                </TableCell>
                <TableCell>{j.qa_flag === null ? "—" : j.qa_flag ? <Badge variant="destructive">{j.qa_reasons.length} flags</Badge> : <Badge variant="secondary">clean</Badge>}</TableCell>
                <TableCell>${Number(j.cost_usd ?? 0).toFixed(2)}</TableCell>
                <TableCell className="space-x-1 text-right">
                  {j.status === "failed" && !j.deleted_at && (
                    <Button size="sm" variant="outline" onClick={() => act({ action: "retry", job_id: j.id }, "Restarted")}><RotateCcw className="h-3 w-3" /></Button>
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

// ── Review ──────────────────────────────────────────────────────────────────
function Review({ rows, onChanged }: { rows: LibraryRow[]; onChanged: () => void }) {
  const [sel, setSel] = useState<string | null>(null);
  const row = rows.find((r) => r.id === sel) ?? rows[0];
  if (!rows.length) return <Card><CardContent className="pt-6 text-sm text-muted-foreground">Nothing waiting for review.</CardContent></Card>;
  return (
    <div className="grid gap-4 lg:grid-cols-[260px_1fr]">
      <Card>
        <CardContent className="space-y-1 pt-6">
          {rows.map((r) => (
            <button key={r.id} onClick={() => setSel(r.id)} className={`w-full rounded px-2 py-1.5 text-left text-sm ${row?.id === r.id ? "bg-muted" : "hover:bg-muted/50"}`}>
              <div className="font-medium">{r.title || `${r.agent_ref} · ${formatDuration(r.duration_s)}`}</div>
              <div className="text-xs text-muted-foreground">{r.status === "pending_qa" ? "needs QA" : "needs legal"} · {r.qa_flag ? `${r.qa_reasons.length} flags` : "no flags"}</div>
            </button>
          ))}
        </CardContent>
      </Card>
      <Card><CardContent className="pt-6">{row && <QaPlayer key={row.id} row={row} onDecided={onChanged} />}</CardContent></Card>
    </div>
  );
}

// ── Library ─────────────────────────────────────────────────────────────────
function LibraryGrid({ rows, onChanged }: { rows: LibraryRow[]; onChanged: () => void }) {
  const { toast } = useToast();
  const [edit, setEdit] = useState<LibraryRow | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LibraryRow | null>(null);

  const act = async (body: Record<string, unknown>, ok: string) => {
    try {
      const r = await invoke(body);
      toast({ title: r?.vendor_purged === false ? "Deleted from TR; vendor copy pending" : ok, description: r?.vendor_detail ?? undefined, variant: r?.vendor_purged === false ? "destructive" : undefined });
    } catch (e) {
      toast({ title: "Failed", description: e instanceof Error ? e.message : String(e), variant: "destructive" });
    }
    onChanged();
  };
  const play = async (r: LibraryRow, artifact: string) => {
    try { window.open((await invoke({ action: "play_url", library_id: r.id, artifact })).url, "_blank", "noopener"); }
    catch (e) { toast({ title: "No link", description: e instanceof Error ? e.message : String(e), variant: "destructive" }); }
  };

  return (
    <>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((r) => (
          <Card key={r.id} className={r.deleted_at ? "opacity-50" : ""}>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">{r.title || `${r.agent_ref} · ${formatDuration(r.duration_s)}`}</CardTitle>
              <CardDescription className="flex flex-wrap gap-1">
                <Badge variant={statusTone(r.status)}>{r.status}</Badge>
                <Badge variant="outline">v{r.version}</Badge>
                {r.consent_ref ? <Badge variant="outline">release ✓</Badge> : <Badge variant="outline">no release</Badge>}
                {r.tags.map((t) => <Badge key={t} variant="secondary">{t}</Badge>)}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {!r.deleted_at && <>
                <Button size="sm" variant="outline" onClick={() => play(r, "redacted_audio")}>Full</Button>
                {r.highlight_audio_path && <Button size="sm" variant="outline" onClick={() => play(r, "highlight_audio")}>Highlight</Button>}
                <Button size="sm" variant="outline" onClick={() => play(r, "transcript_txt")}>Transcript</Button>
                <Button size="sm" variant="outline" onClick={() => play(r, "coaching_json")}>Coaching</Button>
                <Button size="sm" variant="outline" onClick={() => setEdit(r)}>Edit</Button>
                {r.status === "legal_approved" && <Button size="sm" disabled={!r.consent_ref} onClick={() => act({ action: "update", library_id: r.id, status: "published" }, "Published (internal)")}>Publish</Button>}
                {r.status !== "withdrawn" && <Button size="sm" variant="outline" onClick={() => act({ action: "update", library_id: r.id, status: "withdrawn" }, "Withdrawn")}>Withdraw</Button>}
              </>}
              <Button size="sm" variant="destructive" onClick={() => setConfirmDelete(r)}><Trash2 className="mr-1 h-3 w-3" />{r.deleted_at ? "Re-run delete" : "Delete all copies"}</Button>
            </CardContent>
          </Card>
        ))}
      </div>

      {edit && <EditDialog row={edit} onClose={() => setEdit(null)} onSave={async (patch) => { await act({ action: "update", library_id: edit.id, ...patch }, "Saved"); setEdit(null); }} />}
      {confirmDelete && (
        <Dialog open onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent>
            <DialogHeader><DialogTitle>Delete every copy of this call's samples?</DialogTitle></DialogHeader>
            <p className="text-sm">Removes all versions' audio, transcripts and spans from TR storage, cancels any running job, and deletes the transcription vendor's copies. The row stays as a withdrawn take-down record. This cannot be undone.</p>
            <DialogFooter>
              <Button variant="outline" onClick={() => setConfirmDelete(null)}>Cancel</Button>
              <Button variant="destructive" onClick={async () => { const r = confirmDelete; setConfirmDelete(null); await act({ action: "delete", call_id: r.call_id }, "Deleted everywhere"); }}>Delete</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}

function EditDialog({ row, onClose, onSave }: { row: LibraryRow; onClose: () => void; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const [title, setTitle] = useState(row.title ?? "");
  const [tags, setTags] = useState(row.tags.join(", "));
  const [consent, setConsent] = useState(row.consent_ref ?? "");
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Edit sample</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div><Label>Title</Label><Input value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          <div><Label>Tags (comma separated)</Label><Input value={tags} onChange={(e) => setTags(e.target.value)} /></div>
          <div><Label>Agent release reference</Label><Input placeholder="e.g. signed release doc id" value={consent} onChange={(e) => setConsent(e.target.value)} /></div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={() => onSave({ title, tags: tags.split(",").map((t) => t.trim()).filter(Boolean), consent_ref: consent })}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
