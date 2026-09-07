# Persistent world ops runbook

Exactly **one** active row in `market_worlds` is the persistent market identity.
Deploy, server boot, writers, and workers **never** create it. Provisioning is
an intentional first-time ops step only.

## First persistent deployment

1. Deploy code that includes migrations + `verify:persistent-world`.
2. On the VPS checkout, apply migrations if needed: `NODE_ENV=production npm run migrate`
3. Provision the world **once** (durable non-empty seed; immutable identity):
   `NODE_ENV=production npm run provision:persistent-world -- --seed '<your-seed>'`
   Or set `PERSISTENT_WORLD_SEED` and run `NODE_ENV=production npm run provision:persistent-world`.
4. Confirm: `NODE_ENV=production npm run verify:persistent-world`
5. Restart / let normal deploy finish (PM2 + `/api/coins` + `/api/persistent/signals`).

## Normal redeploy sequence

Deploy workflow already:

1. `NODE_ENV=production npm run migrate`
2. `NODE_ENV=production npm run verify:game-schema`
3. `NODE_ENV=production npm run verify:persistent-world`  (fails closed if 0 or >1 active worlds)
4. `pm2 restart back_coins_x`
5. Localhost `/api/coins` health
6. Localhost `/api/persistent/signals` requiring HTTP success, non-null `worldId`, and `coins.length > 0`

Do **not** run `provision:persistent-world` on redeploy.

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
