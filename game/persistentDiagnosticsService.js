// Stage 12A: compact, strictly read-only persistent-market diagnostics.
// This service deliberately reads persisted state only. It never resolves a
// missing world by provisioning, never reconciles, and never acquires mutation
// locks.

const db = require('../db/connection');

// Every query contributing to one diagnostics response must observe the same
// committed database snapshot. The persistent writer can commit between these
// SELECTs, so plain READ COMMITTED is insufficient for an internally coherent
// operator view.
async function withReadOnlySnapshot(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Preserve the original diagnostic failure.
    }
    throw err;
  } finally {
    client.release();
  }
}

function isoOrNull(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function numericOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

async function getPersistentDiagnostics() {
  return withReadOnlySnapshot(async (client) => {
    const { rows: worldRows } = await client.query(
      `SELECT world_id, version, seed, epoch_started_at, active
         FROM market_worlds
        WHERE active
        ORDER BY world_id
        LIMIT 2`
    );

    if (worldRows.length > 1) {
      throw new Error(`persistent diagnostics: ${worldRows.length} active worlds found`);
    }

    const worldRow = worldRows[0] || null;
    const world = worldRow
      ? {
          worldId: Number(worldRow.world_id),
          version: Number(worldRow.version),
          epochStartedAt: new Date(worldRow.epoch_started_at).toISOString(),
          active: worldRow.active === true
        }
      : null;

    const { rows: summaryRows } = await client.query(
      `SELECT
         (SELECT count(*)::int FROM coins WHERE retired = false) AS catalogue_active_coins,
         (SELECT count(*)::int FROM coins WHERE retired = true) AS retired_coins,
         (SELECT count(*)::int
            FROM market_coin_state s
            JOIN coins c ON c.coin_id = s.coin_id
           WHERE s.world_id = $1
             AND c.retired = false
             AND s.status = 'ALIVE') AS active_alive_coins,
         (SELECT count(*)::int
            FROM market_coin_state s
            JOIN coins c ON c.coin_id = s.coin_id
           WHERE s.world_id = $1
             AND c.retired = false
             AND s.status = 'DEAD') AS active_dead_coins,
         (SELECT max(ph.created_at)
            FROM price_history ph
           WHERE ph.source = 'MARKET_TICK'
             AND ph.cycle_id IS NULL
             AND ph.created_at >= COALESCE(
               (SELECT epoch_started_at FROM market_worlds WHERE world_id = $1),
               'infinity'::timestamptz
             )) AS latest_market_tick_at`,
      [worldRow ? Number(worldRow.world_id) : null]
    );
    const summary = summaryRows[0];

    if (!worldRow) {
      return {
        serverTime: new Date().toISOString(),
        world: null,
        director: null,
        market: {
          catalogueActiveCoins: Number(summary.catalogue_active_coins),
          activeAliveCoins: 0,
          activeDeadCoins: 0,
          retiredCoins: Number(summary.retired_coins),
          latestMarketTickAt: null
        },
        coins: []
      };
    }

    const worldId = Number(worldRow.world_id);
    const { rows: directorRows } = await client.query(
      `SELECT regime, intensity, regime_started_at, regime_index
         FROM market_director_state
        WHERE world_id = $1`,
      [worldId]
    );
    const directorRow = directorRows[0] || null;

    const { rows: coinRows } = await client.query(
      `SELECT c.coin_id, c.name, c.symbol, c.current_price, c.retired,
              s.status, s.archetype, s.condition, s.structural_reference,
              s.peak_reference, s.died_at, s.updated_at AS state_updated_at,
              cp.updated_at AS checkpoint_updated_at
         FROM market_coin_state s
         JOIN market_worlds w ON w.world_id = s.world_id
         JOIN coins c ON c.coin_id = s.coin_id
         LEFT JOIN market_price_checkpoints cp
           ON cp.coin_id = s.coin_id AND cp.seed = w.seed
        WHERE s.world_id = $1
        ORDER BY c.coin_id`,
      [worldId]
    );

    return {
      serverTime: new Date().toISOString(),
      world,
      director: directorRow
        ? {
            regime: directorRow.regime,
            intensity: Number(directorRow.intensity),
            regimeStartedAt: new Date(directorRow.regime_started_at).toISOString(),
            regimeIndex: Number(directorRow.regime_index)
          }
        : null,
      market: {
        catalogueActiveCoins: Number(summary.catalogue_active_coins),
        activeAliveCoins: Number(summary.active_alive_coins),
        activeDeadCoins: Number(summary.active_dead_coins),
        retiredCoins: Number(summary.retired_coins),
        latestMarketTickAt: isoOrNull(summary.latest_market_tick_at)
      },
      coins: coinRows.map((row) => ({
        coinId: Number(row.coin_id),
        name: row.name,
        symbol: row.symbol,
        currentPrice: row.status === 'DEAD' ? 0 : numericOrNull(row.current_price),
        retired: row.retired === true,
        status: row.status,
        archetype: row.archetype,
        condition: numericOrNull(row.condition),
        structuralReference: numericOrNull(row.structural_reference),
        peakReference: numericOrNull(row.peak_reference),
        diedAt: isoOrNull(row.died_at),
        stateUpdatedAt: isoOrNull(row.state_updated_at),
        checkpointUpdatedAt: isoOrNull(row.checkpoint_updated_at)
      }))
    };
  });
}

module.exports = { getPersistentDiagnostics };
