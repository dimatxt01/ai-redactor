# True Ring side: Training Recording Library, PR plan v0.2 (2026-10-12, revised after Dmitry's 6:27 PM answers)

**Ask:** a "Recording Library" tab for **internal training**. It holds smart clips of the key Final Expense sale moments (opener, discovery, objection handling, close, …), each with an AI coaching note, plus a coaching summary per call. AMs and admins pick calls manually; which agents is TBD.
Contract: `SPEC.md` v0.2 (delivery revised 2026-10-13: pull through the bridge). Status: RL-1 applied; RL-2, RL-3, the staff part of RL-4 and RL-5 built on `feat/sample-redaction`, not deployed.

**Revised 2026-10-13 (Dmitry): the service is built in-house, without n8n** — the worker is its own repo, `ai-redactor`: a plain Node background process in one container (ffmpeg, AssemblyAI, OpenRouter), deployed separately. It **polls** the bridge; TR never calls it; this branch (`feat/sample-redaction`) holds only the TR side: migration, `training-library-admin`, `sample-redaction-bridge`, the curation page.
It keeps no copies, so the **signed callback (RL-3) is replaced by a bridge**. The worker reads its inputs and writes its results
through ONE HMAC edge function, `sample-redaction-bridge`, straight into the RL-1 buckets. TR copies nothing, the service retains
nothing, and SPEC no longer has a callback, a 7-day service-side retention or `DELETE /jobs/:id` (removed 2026-10-13). `training-library-admin`'s delete removes
every copy, including AssemblyAI's. Every result and job row carries `schema_version` "1.0" (SPEC §7). Rows 2–5 below are updated to match.

## Where the tab goes (read-only check)
- **Agent portal `/agent`:** single-page, state-driven tabs: welcome, dashboard, take-calls, calls, script, billing, referrals, activity, support, settings. There is already an **`ai-training` tab** in the state union, rendering `AITrainingInProgress` (a placeholder), and **there is no nav button for it**.
- **AM View `/am`:** routed pages under `AMLayout`: dashboard, agents, agencies, calls, reporting, revenue, earnings, leads, leads/pool, credit-history, notifications.
- **Proposal: both, with different roles.**
  - **Agents:** a read-only **Recording Library** tab in `/agent`. It reuses or replaces the hidden `ai-training` slot: browse by label, play clips, read coaching notes.
  - **AMs:** curation at **`/am/recording-library`** (pick calls, submit, status, QA listen, publish/withdraw), plus the same read-only browse to coach their agents.
  - **Admins:** the same page mounted at `/admin/recording-library`, one component with two mounts (the existing `AdminNotifications portal="am"` pattern).
- **Unused tables:** keep the existing `training_recordings` / `training_highlights` untouched. Use new tables (see SPEC §4) so the redacted-only rule is enforced by the schema.

## Dropped since v0.1
- The legal approve step: internal use only. It is replaced by a **one-time** review of the caller disclosure wording and the agent release text.
- The buyer/public player and the `sample_library_publish` flag.
- Pitch-shift by default (now off).

**Kept:** PII redaction, the human QA listen (`listened_full` required) before publishing, agent consent, Final Expense only.

## Standard gates for every PR
- Critic review on the exact head.
- Dmitry's go: to merge, and separately to deploy.
- Migrations: apply go + online guard + rollback SQL + a `deploy_records` row.
- Edge functions: CLI deploy from clean main.
- Frontend: `vercel --prod` + a `deploy_records` row + a BUGLOG entry.

## PRs in order

| # | PR | Contents | Flag | Effort | Depends on | Gos beyond the standard |
|---|---|---|---|---|---|---|
| 1 | **DB: tables + bucket** | `sample_redaction_jobs`, `training_library_calls`, `training_library_clips`, append-only `training_library_reviews`, `agent_training_consents`, `training_library_ratings` (unique agent+item, upsert; agents can see only their own rows, AM/admin can read all), manifest view. **RLS:** agents can read only `published` rows and never `source_agent_id`; AMs and admins can read and write. Private buckets `sample-src`, `training-library`. Flag row `recording_library`, disabled. | `recording_library` (disabled) | 1 d | — | Migration go |
| 2 | **Edge: `training-library-admin` (submit, retry, sweep, pick, review, publish, withdraw, edit, delete)** — *built* | AM/admin JWT check. Rules: Final Expense + `Sale` + Telnyx + ≤60 min + active agent consent; flag `recording_library` gates submit. Idempotency key `call:<id>:v<n>`; the estimate is reserved against the $100/month cap in SQL; the job is queued (the worker claims it on its next poll; TR never calls the worker). Delete = takedown of every copy (done at once, or when the worker confirms the vendor copies are gone). Migration `20261013090000_sample_redaction_worker` adds the worker columns, caps and `sample_library_ingest` on top of RL-1. | flag | built | 1 | **Secrets:** none new (optional caps, `SAMPLE_WORKER_STALE_S`). Migration go, deploy go. |
| 3 | **Edge: `sample-redaction-bridge`** (replaces the callback) — *built* | `verify_jwt=false`. HMAC ±5 min, one secret (the worker is the only caller). `poll` hands out queued jobs, refreshes heartbeats (`heartbeat_at`), names jobs to stop, lists vendor cleanups, and fails runs whose worker went quiet. Claim = compare-and-swap (one run per job); every later action must come from that run. Fresh Telnyx link per attempt; the worker downloads at once. Signed upload/download URLs only under `sample-src/<job_id>/` and `training-library/<job_id>/`. `complete` checks every file is uploaded, then `sample_library_ingest` writes the job, `training_library_calls`, `_call_sources` and `_clips` in one transaction. Scratch is deleted when the job ends. | — | built | 1, 2 | **Secret** `SAMPLE_REDACTOR_BRIDGE_SECRET`. Deploy go. Critic focus: HMAC, run ownership, takedown. |
| 4 | **Links** — *staff part built* (`training-library-admin` `link`) | 10-min signed links, access logged; the log is the reviewer's listen evidence. Staff: everything. **Agents: still to build with RL-7** (published clips only, no full call, decide in Q3). | — | 0.5 d (agents) | 1, 3 | Deploy go |
| 5 | **AM/Admin curation page** (`/am/recording-library` + `/admin/recording-library`) — *built* | **Pick:** sales filtered by agent, 10–40 min, consent on file. **Submit.** **Jobs list** with retry. **QA view:** full-call player with bleep markers, clip list with labels and coaching, second-pass flags, edit clip titles, drop a clip, the "listened to full call + all clips" box (required). **Publish/withdraw.** **Manifest export.** **Ratings view:** per item, up count, down count, net score and comments (AM/admin only). | flag + AM/admin role | 3.5 d | 1–4 | Frontend deploy go |
| 6 | **Agent consent** | A one-time training-use release card in `/agent` (text version, time) with revoke; revoking withdraws that agent's items. The AM page shows consent status and can record a consent obtained offline. | flag | 1 d | 1 | Release text (Dmitry/Mo). Frontend deploy go. |
| 7 | **Agent "Recording Library" tab** | Read-only in `/agent` (reuse the `ai-training` slot). Filter by label (opener / discovery / objection: price… / close). Clip cards: player, AI coaching note, scores, the per-call summary. Pseudonymized agents, no downloads. **Vote each clip/call up (+1, green arrow) or down (-1, red arrow) + optional comment** (upsert, own rating only, never shows others' ratings). Optional: also mount read-only browsing in AM View. | flag | 2.5 d | 1, 4, 5 (published content) | Frontend deploy go |
| 8 | **Ops** | Retention job (`sample-src` cleanup, yearly review), BUGLOG runbook. *Built:* the 2 h sweep (on page load), ops-alert key `sample_cost_cap` (month cap blocking jobs). | — | 0.5 d | 3 | Deploy go |

**Total:** about **11–11.5 dev-days**, plus critic and go loops. Ratings add about 1 d: the table in PR1, the AM read view in PR5, the agent UI in PR7.

**Pilot of 5:** PRs 1→2→3→4→5, plus consent recorded offline. AMs QA the first 5 before PR 7 lets agents see anything.

## Open questions (for Dmitry / Mo)
1. **Which agents** are featured (TBD), and how many calls per agent?
2. **Who curates:** all AMs, or a named set? Can an AM submit calls from agents outside their book?
3. **What agents see:** clips only, or also the full redacted call? Should featured agents see their own coaching and scores?
4. **Clip taxonomy and rubric:** confirm the labels and the `fe_v1` scoring dimensions, or supply your own script stages.
5. **Visibility:** all agents, or only Final Expense agents or specific tiers? New agents first (onboarding)?
6. **Replace the hidden `ai-training` slot,** or add a separate tab?
