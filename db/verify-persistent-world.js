// Production-safe read-only gate: exactly one active persistent market world.
// Deploy refuses to restart PM2 unless this passes. Never provisions.
const db = require('./connection');

async function countActiveWorlds(queryable) {
  const result = await queryable.query(
    'SELECT count(*)::int AS n FROM market_worlds WHERE active'
  );
  return result.rows[0].n;
}

async function listActiveWorldSummaries(queryable) {
  const result = await queryable.query(
    `SELECT world_id, version, epoch_started_at, active
     FROM market_worlds
     WHERE active
     ORDER BY world_id`
  );
  return result.rows.map((row) => ({
    worldId: Number(row.world_id),
    version: Number(row.version),
    epochStartedAt: row.epoch_started_at,
    active: row.active === true
  }));
}

async function verifyPersistentWorld({ queryable } = {}) {
  const q = queryable || db;
  const worlds = await listActiveWorldSummaries(q);
  const activeCount = worlds.length;

  if (activeCount === 1) {
    return {
      ok: true,
      activeCount,
      worlds,
      message: `persistent world verification PASSED (exactly one active world: world_id=${worlds[0].worldId})`
    };
  }

  if (activeCount === 0) {
    return {
      ok: false,
      activeCount,
      worlds,
      message: 'persistent world verification FAILED: no active market world. ' +
        'Run provision:persistent-world once with --seed (or PERSISTENT_WORLD_SEED); see docs/persistent-world-ops.md. ' +
        'Deploy will not invent a world.'
    };
  }

  return {
    ok: false,
    activeCount,
    worlds,
    message:
      `persistent world verification FAILED: ${activeCount} active market worlds found ` +
      `(world_ids=${worlds.map((w) => w.worldId).join(',')}). ` +
      'The single-active-world invariant is broken; investigate market_worlds before deploying.'
  };
}

if (require.main === module) {
  verifyPersistentWorld()
    .then(async ({ ok, message }) => {
      if (ok) {
        console.log(message);
        await db.end();
        return;
      }
      console.error(message);
      await db.end();
      process.exit(1);
    })
    .catch(async (err) => {
      console.error(`persistent world verification error: ${err.message}`);
      await db.end();
      process.exit(1);
    });
}

module.exports = {
  countActiveWorlds,
  listActiveWorldSummaries,
  verifyPersistentWorld
};
