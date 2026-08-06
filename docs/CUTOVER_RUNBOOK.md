# CUTOVER_RUNBOOK — production cutover (REQUIRES JOHN'S EXPLICIT APPROVAL)

This runbook is prepared in advance (plan §13 Stage C). Nothing here executes
without approval. Current status: PREPARED, NOT APPROVED, NOT EXECUTED.

## Preconditions (all must be green)

- [ ] Staging verification complete (Task 15): RLS, trading, tick, history,
      migration replay, frontend gates — evidence in reports.
- [ ] Verified final source backup: `pg_dump -Fc` restored and count-checked.
- [ ] `github-actions-key` release blocker resolved by John (removal from
      history + rotation) — required before any production frontend deploy
      from the migrated branch.
- [ ] Maintenance window announced; support path ready.

## Cutover sequence

1. **Freeze legacy writes**: deploy/read-only switch for the legacy Express
   trade endpoints (reads stay up). Confirm no in-flight tick; stop the
   legacy simulator (PM2) and prove `price_history` stopped growing.
2. **Final export**: run export-legacy against production; record manifest
   checksums and watermark timestamp (cutover watermark for rollback).
3. **Apply migrations** to production Supabase (same files as staging, same
   order). Confirm additive shared config diff matches staging-reviewed diff.
4. **Identities**: create-auth-users (real emails), then send password
   recovery links through existing Brevo SMTP at the approved time. Record
   `reset_sent` status in `legacy_identity_map` (no tokens stored).
5. **Import + rollups + verify**: import-coins, build-rollups.sql,
   verify-migration — every gate must pass. Any discrepancy: STOP, revert to
   legacy (pre-trade rollback is trivial), adjudicate.
6. **Worker**: start one production worker (`instances: 1`); confirm tick
   sequence continues from imported max, heartbeat fresh, prices moving.
7. **Frontend switch**: deploy frontend build with production
   `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`. Smoke: auth (recovery-set
   password), reads, one designated-account buy + sell, all chart ranges.
8. **Registration stays disabled** during the rollback window (24–48 h
   recommended, plan §13). Imported users may trade once gates pass.
9. **Legacy retained read-only** through the rollback window. Never delete
   source data as part of cutover.

## Post-cutover monitoring (first 48 h)

- RLS denials, RPC error rates/latency, balance invariants
  (no negative cash/holdings — alert query in ROLLBACK_RUNBOOK),
  tick cadence (heartbeat < 2 intervals stale), candle coverage,
  retention dry-runs only until archive confirmed.
