# Coins market worker

Minimal Node service that wakes every 30 s and calls
`coins.run_market_tick(worker_id, expected_sequence)` (plan §9). All
simulation state and financial writes live in PostgreSQL; this process holds
no authoritative state, so restart/crash is safe.

## Environment (never committed)

| name | purpose |
|---|---|
| `COINS_WORKER_DATABASE_URL` | direct PG URL authenticating as the restricted `coins_worker` role (required TLS on staging/prod) |
| `MARKET_WORKER_ID` | instance identifier for heartbeat/logs |
| `TICK_INTERVAL_MS` | default 30000; minimum 1000 |

The worker **refuses to start** if the URL does not authenticate as
`coins_worker`. It never holds the Supabase service-role key.

## Behaviour

- Calls `coins.ensure_active_cycle()` on every wake-up (even while the market
  is halted) so the global apocalypse cycle (Crypto Chaos Core 1) advances
  with no humans online. Idempotent; logs `apocalypse cycle advanced` only
  when a new round is created.
- Non-overlapping ticks; next tick scheduled only after the previous settles.
- Passes the last confirmed `tick_sequence`; the DB no-ops stale retries and
  rejects skew (`SEQUENCE_MISMATCH`), so duplicate workers cannot double-apply.
- The DB function additionally takes a transaction-scoped advisory lock.
- Exponential backoff with jitter; circuit breaker opens after 5 consecutive
  failures for 60 s.
- Structured JSON logs to stdout (PM2 captures). No secrets are logged.
- Heartbeat + last tick persist in `coins.market_state` even when the market
  is halted; staleness beyond 2 intervals should page ops (see runbook).

## Run (staging)

```bash
cd worker
npm ci
COINS_WORKER_DATABASE_URL='postgresql://coins_worker:...@host:5432/postgres' \
  pm2 start ecosystem.config.cjs
pm2 logs coins-market-worker
```

## Scheduling fallback (plan §9.3)

If `pg_cron` is unavailable on the Supabase host, a second (optional) worker
mode or cron entries call the same idempotent SQL functions on schedule:
`coins.refresh_price_candles`, `coins.refresh_market_candles`, and (only
after the archive marker is set) `coins.apply_history_retention`. Exactly one
scheduler owns destructive retention; record which in the runbook.
