# Persistent-world operations

Current production runbook, reviewed 12 September 2026.

Exactly one active row in `market_worlds` is the persistent market identity. Production is already provisioned. Normal deploys, server boot, writers, and workers must never create or replace that identity.

## Normal deployment

A push to backend `main` runs the VPS workflow in this order:

1. Fetch and reset the VPS checkout to `origin/main`.
2. `npm install`.
3. `NODE_ENV=production npm run migrate`.
4. `NODE_ENV=production npm run verify:game-schema`.
5. `NODE_ENV=production npm run verify:persistent-world`.
6. `pm2 restart back_coins_x`.
7. Verify `GET http://127.0.0.1:3000/api/coins`.
8. Verify `/api/persistent/signals` returns a non-null `worldId` and a non-empty `coins` array.

Do not run `provision:persistent-world` during a normal redeploy.

## World verifier

```bash
NODE_ENV=production npm run verify:persistent-world
```

| Active worlds | Result |
|---|---|
| `0` | Fail — the environment has not been provisioned or the world was deactivated |
| `1` | Pass |
| `>1` | Fail — the single-active-world invariant is broken |

The verifier is read-only. A failed gate stops deployment before pm2 restart.

## Provisioning a genuinely new environment

Provision only when creating a new environment with zero worlds. Use a durable, non-empty seed and retain it as part of the environment identity.

```bash
NODE_ENV=production npm run provision:persistent-world -- --seed '<durable-seed>'
NODE_ENV=production npm run verify:persistent-world
```

`--seed=<value>` and `PERSISTENT_WORLD_SEED` are also supported. Provisioning refuses to run when an active world already exists.

After successful one-time provisioning, rerun the normal deployment workflow so restart and health checks use the standard path.

## Failure handling

### Migration or schema verification fails

- Do not restart pm2.
- Read the failing migration/verifier output.
- Repair through a new data-preserving migration or an explicitly reviewed operational correction.
- Never use `db/seed.js`; it is destructive and production-blocked.

### Zero active worlds in existing production

- Treat this as an incident, not an invitation to create a new world immediately.
- Inspect `market_worlds`, recent deployment/database actions, and backups.
- Determine whether the established world should be reactivated or restored.
- Provisioning a replacement world changes the game identity and requires an explicit product/operations decision.

### More than one active world

- Keep the application restart blocked.
- Inspect the conflicting rows and migration/index state.
- Do not guess which world is authoritative or deactivate rows without a recovery decision.

### API health check fails after restart

- Inspect pm2 logs and backend environment configuration.
- Confirm PostgreSQL connectivity and the required non-empty `JWT_SECRET`.
- Re-run the two localhost health checks before declaring the deployment healthy.

## Invariants

- No automatic world creation on boot, deploy, migration, verification, market writes, bot ticks, replacement ticks, or trades.
- The active world seed is never exposed by public APIs or logs.
- Writers and workers fail or skip safely when the world cannot be resolved; they never fabricate identity.
- Production schema changes use tracked migrations only.
