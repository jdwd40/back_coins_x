# ROLLBACK_RUNBOOK — Coins Supabase migration

## A. Before the first Supabase trade (simple rollback)

1. Revert frontend to the previous build (points at `https://jdwd40.com/api-2/api`).
2. Stop the Supabase market worker (`pm2 stop coins-market-worker`).
3. Re-enable the legacy simulator/writes after confirming the legacy DB is
   unchanged and healthy.
4. Leave the `coins` schema in place for investigation — do NOT destructively
   remove it during incident response.

## B. After Supabase trades exist (reverse-delta rollback)

A plain frontend revert would strand post-cutover financial activity.

1. **Freeze**: `SELECT coins.set_market_running(false, 'rollback-freeze');`
   (service_role) and disable trade RPC grants if needed:
   `REVOKE EXECUTE ON FUNCTION coins.buy_coin(bigint,numeric,uuid),
    coins.sell_coin(bigint,numeric,uuid) FROM authenticated;`
2. **Watermark**: trades/wallets/holdings/prices/history AFTER the cutover
   watermark recorded in CUTOVER_RUNBOOK step 2.
3. **Export delta** (script: `scripts/migration/export-supabase-delta.mjs` —
   dry-run only until approved).
4. **Rehearse**: apply the delta to a restored legacy staging DB with
   `scripts/migration/restore-legacy-delta.mjs`; reconcile exact post-state
   and transaction IDs; obtain explicit approval.
5. **Apply** in one controlled transaction during a maintenance window;
   verify; switch frontend back.
6. **Supabase-only registrations** are outside this path — registration stays
   disabled during the rollback window precisely to keep this simple. If they
   must be enabled earlier, quarantine those accounts and communicate manual
   recovery (plan §14).

## Rollback triggers (any one → execute rollback)

- Failed RLS isolation (any cross-user read/write observed)
- Any negative or inconsistent cash/holding
- Duplicate or missing trades
- Scheduler double-tick or stall (heartbeat stale beyond 2 intervals)
- Unrecoverable Auth failures
- Missing chart coverage for any UI range
- Unacceptable error/latency rates

## Invariant alert queries (run periodically post-cutover)

```sql
SELECT count(*) AS negative_cash FROM coins.wallets WHERE cash_balance < 0;
SELECT count(*) AS negative_qty  FROM coins.holdings WHERE quantity < 0;
SELECT extract(epoch FROM now() - worker_heartbeat_at) AS heartbeat_age_s
  FROM coins.market_state;
SELECT max(tick_sequence) AS latest_tick FROM coins.market_snapshots;
```

## Retention / artifacts to keep for the rollback period

- Source `pg_dump` + export manifests + checksums
- Old frontend build artifact and old Express commit/PM2 config
- Cutover watermark and identity map (encrypted; contains emails)
- Never delete source data as part of cutover or rollback.
