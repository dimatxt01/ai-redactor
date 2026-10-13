// Rows of the Recording Library tables: RL-1 (20261012180000_training_library) plus the worker columns of
// 20261013090000_sample_redaction_worker. Not in the generated types.ts until it is regenerated after apply.

export type JobStatus = "queued" | "fetching" | "transcribing" | "redacting" | "verifying" | "done" | "failed" | "deleted";

export type JobRow = {
  id: string;
  call_id: string;
  version: number;
  idempotency_key: string;
  status: JobStatus;
  error_code: string | null;
  error_detail: string | null;
  qa_flag: boolean;
  qa_reasons: string[];
  metrics: Record<string, unknown>;
  engine: Record<string, unknown>;
  cost_usd: number;
  reserved_usd: number;
  pipeline_version: string | null;
  schema_version: string | null;
  call_meta: { duration_s?: number; caller_state?: string | null; channel_map?: { customer: number; verified: boolean } };
  created_at: string;
  completed_at: string | null;
  delete_requested_at: string | null;
  deleted_at: string | null;
};

export type Scores = Partial<Record<"rapport" | "discovery" | "objections" | "close" | "compliance", number | null>>;

export type CallCoaching = {
  outcome?: string;
  summary?: string;
  strengths?: string[];
  improvements?: string[];
  scores?: Scores;
  turning_point_clip_id?: string | null;
  rubric?: string;
  model?: string;
};

export type ClipCoaching = { did?: string; worked?: string; improve?: string; key_lines?: string[]; scores?: Scores };

export type LibraryStatus = "pending_qa" | "published" | "rejected" | "withdrawn";

export type LibraryCall = {
  id: string;
  job_id: string | null;
  version: number;
  agent_ref: string;
  duration_s: number | null;
  audio_path: string | null;
  coaching: CallCoaching;
  title: string | null;
  tags: string[];
  status: LibraryStatus;
  published_at: string | null;
  created_at: string;
};

export type CallSource = { library_call_id: string; call_id: string; source_agent_id: string; consent_id: string | null };

export type Clip = {
  id: string;
  library_call_id: string;
  clip_key: string;
  label: string;
  sub_label: string | null;
  start_ms: number;
  end_ms: number;
  audio_exported: boolean;
  title: string | null;
  coaching: ClipCoaching;
  confidence: number | null;
  sort_order: number;
};

export type Review = {
  seq: number;
  library_call_id: string;
  reviewer: string;
  decision: "approve" | "reject" | "withdraw";
  listened_full: boolean;
  notes: string | null;
  created_at: string;
};

export type Rating = { item_type: "call" | "clip"; item_id: string; vote: -1 | 1; comment: string | null; updated_at: string };

export const ACTIVE = new Set(["queued", "fetching", "transcribing", "redacting", "verifying"]);

export const SCORE_KEYS = ["rapport", "discovery", "objections", "close", "compliance"] as const;

// Default carrier names to bleep (staff can edit per submit).
export const DEFAULT_CARRIER_TERMS = [
  "Mutual of Omaha", "Aetna", "Americo", "Royal Neighbors", "Transamerica", "Foresters", "Corebridge", "AIG",
  "Gerber", "Lincoln Heritage", "Liberty Bankers", "SBLI", "American Amicable", "Occidental", "Baltimore Life",
  "Great Western", "Fidelity Life", "Colonial Penn", "Globe Life", "Ethos", "John Hancock", "Sentinel Security",
  "Cincinnati Equitable", "Senior Life", "Prosperity", "TruStage", "Security National", "Elco",
];
