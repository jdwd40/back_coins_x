# Crypto Chaos Core 1 — Production Release & Rollback Runbook

Scope: the `apocalypse_cycles` game-cycle schema (migration 007), the
`/api/game/state` endpoint, and the game-cycle worker lifecycle. The backend
is Node/Express/PostgreSQL. No Supabase component is involved.

## Safety properties

- `db/migrate.js` is the ONLY production schema path for this feature. It
  never invokes `db/seed.js`, never drops or recreates existing tables, and
  records each applied migration in `schema_migrations` so reruns are safe
  no-ops.
- `db/seed.js` is destructive and is for development/test only. It now refuses
  to run with `NODE_ENV=production`.
- Every managed migration runs in its own transaction: a failed migration is
  rolled back completely and is NOT recorded, so the database is left exactly
  as before the failed attempt.
- Migration 007 explicitly verifies any pre-existing `apocalypse_cycles`
  table/index and aborts with a clear `INCOMPATIBLE` error rather than
  silently accepting a wrong shape.

## Production release sequence

Run from the deployed backend checkout (e.g. `/home/jd/back_coins_x` on the
app VPS) with production environment loaded:

1. Deploy the new code (normal git-based deploy).
2. Apply migrations:
   `NODE_ENV=production npm run migrate`
   Expected output: `applied 007_create_apocalypse_cycles.sql` on first
   release, `0 applied, N already applied` on later releases.
3. Verify the schema explicitly:
   `NODE_ENV=production npm run verify:game-schema`
   Must print `apocalypse_cycles schema verification PASSED`. Do not continue
   if it fails — the application assumptions are not met.
4. Restart the application (PM2): `pm2 restart back_coins_x` (or the
   environment's equivalent). On boot `server.js` checks the database, starts
   the HTTP listener, then starts the game-cycle worker.
5. Verify the endpoint:
   `curl -fsS https://jdwd40.com/api-2/api/game/state | jq .`
   Expect HTTP 200 with `apocalypseId`, `status: "ACTIVE"`, ISO `startTime`/
   `endTime`/`serverTime`, `durationMs`, `remainingMs`, `apocalypsePercent`.
   The cycle `seed` is internal-only (Milestone 1): it deterministically
   drives the collapse schedule and bot randomness and must NOT appear in the
   response. Repeat the call: `apocalypseId` must be identical (persistence,
   not regeneration).
6. Watch logs for one full cycle boundary: `pm2 logs back_coins_x`. At
   `endTime` the worker must roll into exactly one successor
   (`APOC-0002`, ...); the endpoint must never return overlapping active
   windows.

If step 2 fails with an INCOMPATIBLE error, stop the release: some
pre-existing object conflicts with the Core 1 schema. Resolve manually (see
below) before rerunning.

## Rollback / recovery (data-preserving)

Migration 007 is additive (one new table and one new index); a safe application
rollback does **not** delete either. Preserve the completed-cycle history and
leave its `schema_migrations` record intact.

- Failed migration: nothing to do — the transaction rolled back. Fix the
  reported incompatibility and rerun `npm run migrate`.
- Back out the application feature after a successful migration: deploy the
  previous application build and restart it. Leave `apocalypse_cycles`, its
  index, and the migration record in place. Older application code ignores the
  additive objects; this is the reversible, data-preserving rollback path.
- Recover from a pre-existing incompatible/legacy table: stop before running
  a migration that would alter data. Take a verified backup of the existing
  table (for example `pg_dump -t apocalypse_cycles <db> > apocalypse_cycles_backup.sql`),
  assess and repair the conflicting object under an explicitly approved
  database-change procedure, then rerun `npm run migrate` and
  `npm run verify:game-schema`. Do not use this release runbook to drop data.

Never use `db/seed.js` for any production migration, verification, rollback,
or recovery step.
