# Persistent world ops runbook

Exactly **one** active row in `market_worlds` is the persistent market identity.
Deploy, server boot, writers, and workers **never** create it. Provisioning is
an intentional first-time ops step only.

## First-ever deployment (fail-closed bootstrap)

The first production deploy that includes `verify:persistent-world` is expected
to **fail** until an ops engineer provisions the world once. That failure is
intentional fail-closed bootstrap, not a broken deployment.

1. Run the first deployment (GitHub Actions — push/merge to `main`, or re-run
   the deploy workflow so the VPS checkout receives the new code, migrations,
   and verifier).
2. Expect the job to **FAIL** at `verify:persistent-world` with **zero** active
   worlds (exit before PM2 restart and health checks).
3. Treat that failure as the fail-closed gate: production must not start without
   an explicit persistent world identity.
4. SSH to the VPS checkout that already contains the newly deployed code
   (e.g. `/home/jd/back_coins_x` after the failed job's `git reset` /
   `npm install` / migrate steps).
5. Provision the world **once** (durable non-empty seed; immutable identity):
   ```bash
   NODE_ENV=production npm run provision:persistent-world -- --seed '<your-seed>'
   ```
   Or set `PERSISTENT_WORLD_SEED` and run
   `NODE_ENV=production npm run provision:persistent-world`.
6. Confirm locally on the VPS:
   ```bash
   NODE_ENV=production npm run verify:persistent-world
   ```
7. **Prefer:** re-run the failed GitHub Actions deployment job so PM2 restart
   and both health checks (`/api/coins` and `/api/persistent/signals`) run
   through the normal deploy path.
8. **Or** (deliberate manual completion only), on the VPS:
   ```bash
   pm2 restart back_coins_x
   # then both health checks must pass:
   curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/api/coins
   curl -sf --max-time 5 http://127.0.0.1:3000/api/persistent/signals
   # signals must return HTTP success, non-null worldId, and coins.length > 0
   ```

Do **not** treat a zero-world verify failure as a reason to disable the gate
or to auto-provision from deploy/server code.

## Normal redeploy sequence

After the world exists, every subsequent deploy is smooth and must **never**
re-provision. The deploy workflow already:

1. `NODE_ENV=production npm run migrate`
2. `NODE_ENV=production npm run verify:game-schema`
3. `NODE_ENV=production npm run verify:persistent-world`  (fails closed if 0 or >1 active worlds)
4. `pm2 restart back_coins_x`
5. Localhost `/api/coins` health
6. Localhost `/api/persistent/signals` requiring HTTP success, non-null `worldId`, and `coins.length > 0`

Do **not** run `provision:persistent-world` on normal redeploy.

## Exact provision command

```bash
NODE_ENV=production npm run provision:persistent-world -- --seed '<your-seed>'
```

Also accepts `--seed=<value>` or `PERSISTENT_WORLD_SEED`. Prints `world_id` on success; exits 1 on failure.
Refuses if any active world already exists.

## Verifier behaviour

| Active worlds | Result |
|---|---|
| 0 | Fail — tells ops to run `provision:persistent-world` |
| 1 | Pass |
| >1 | Fail — single-active invariant broken; investigate `market_worlds` |

The verifier is **read-only** (no inserts/updates/deletes).

## Explicit non-goals

- No auto-create on server boot
- No auto-create in market writer / bot / replacement / economy workers
- No auto-create on redeploy / migrate / schema verify
- `provision:persistent-world` is never invoked by `.github/workflows/deploy.yml`
