// Rows of the sample-library tables (migration 20261012230000_sample_library;
// not in the generated types until they are regenerated after apply).

export type JobRow = {
  id: string;
  call_id: string;
  version: number;
  status: "queued" | "fetching" | "transcribing" | "redacting" | "verifying" | "done" | "failed";
  error_code: string | null;
  error_detail: string | null;
  qa_flag: boolean | null;
  qa_reasons: string[];
  cost_usd: number;
  pipeline_version: string | null;
  created_at: string;
  completed_at: string | null;
  deleted_at: string | null;
  call_meta: { duration_s?: number; agent_ref?: string; caller_state?: string | null };
};

export type LibraryRow = {
  id: string;
  call_id: string;
  job_id: string;
  version: number;
  agent_ref: string;
  vertical: string;
  duration_s: number | null;
  highlight_audio_path: string | null;
  highlight_start_ms: number | null;
  highlight_end_ms: number | null;
  qa_flag: boolean;
  qa_reasons: string[];
  title: string | null;
  tags: string[];
  consent_ref: string | null;
  status: "pending_qa" | "qa_passed" | "legal_approved" | "published" | "rejected" | "withdrawn";
  pipeline_version: string;
  created_at: string;
  deleted_at: string | null;
};

export const ACTIVE = new Set(["queued", "fetching", "transcribing", "redacting", "verifying"]);

// Default carrier names to bleep (admin can edit per submit).
export const DEFAULT_CARRIER_TERMS = [
  "Mutual of Omaha", "Aetna", "Americo", "Royal Neighbors", "Transamerica", "Foresters", "Corebridge", "AIG",
  "Gerber", "Lincoln Heritage", "Liberty Bankers", "SBLI", "American Amicable", "Occidental", "Baltimore Life",
  "Great Western", "Fidelity Life", "Colonial Penn", "Globe Life", "Ethos", "John Hancock", "Sentinel Security",
  "Cincinnati Equitable", "Senior Life", "Prosperity", "TruStage", "Security National", "Elco",
];
