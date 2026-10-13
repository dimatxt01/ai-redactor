# Deployment list: prb/rl-worker (Recording Library, TR side: worker integration + docs)

Nothing is live until Dmitry's shipment go. Critic reviews every PR into this branch and the ship PR into main.
Folded in: prb/rl-pull-docs (#345, docs) and the pull model from #348 (closed).

0. **Docs** (from prb/rl-pull-docs): `docs/recording-library/SPEC.md`, `TR_PLAN.md`. Docs only, no deploy.
1. **Migration `20261013090000_sample_redaction_worker`**: online-agent guard, apply only at :08–:40 after 8 PM CT, critic's yes under the shipment go. Then redeploy `integrity-audit` (manifest 2026-10-12.3). Rollback: `psql -1 -f scripts/rollbacks/rollback_20261013090000_sample_redaction_worker.sql`. deploy_records row.
2. **Secret**: Supabase function secret `SAMPLE_REDACTOR_BRIDGE_SECRET` (set in the UI, never printed). Optional: `SAMPLE_JOB_CAP_USD`, `SAMPLE_MONTH_CAP_USD`, `SAMPLE_ASR_USD_PER_HOUR`, `SAMPLE_WORKER_STALE_S` (default 300). No `SAMPLE_REDACTOR_URL` / `SAMPLE_REDACTOR_START_SECRET`: TR never calls the worker.
3. **Edge `sample-redaction-bridge`**: `verify_jwt=false` (HMAC in body). CLI deploy from clean main.
4. **Edge `training-library-admin`**: `verify_jwt=false` (staff JWT checked in body). CLI deploy from clean main.
5. **Edge `ops-alert`** (key `sample_cost_cap`). CLI deploy from clean main.
6. **Frontend**: `/admin/recording-library` + `/am/recording-library`. `vercel --prod`, critic's live screenshots, deploy_records row, BUGLOG entry.
7. **Worker container** (ai-redactor `Dockerfile`, separate repo, plain Node, no open port; polls the bridge every ~20 s, about 130k function calls/month): env `TR_BRIDGE_URL`, `SAMPLE_REDACTOR_BRIDGE_SECRET`, `ASSEMBLYAI_API_KEY`, `OPENROUTER_API_KEY`. Check before it counts as up: `node --import tsx src/check.ts --bridge` prints `"ok": true`.
8. **Flag `recording_library` stays OFF.** Turning it on is a separate Dmitry go.

Rollback order: flag off → stop the worker → undeploy the two functions → rollback SQL (`psql -1`). RL-1 stays.

**Later follow-up (not in this batch):** harden service_role's rights on `sample_redaction_jobs` / `training_library_reviews` (RL-1 `GRANT ALL`: a direct DELETE/TRUNCATE bypasses the ledger and append-only). Critic 5508438349 nit 6.
