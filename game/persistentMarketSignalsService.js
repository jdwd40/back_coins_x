// Persistent-market Stage 11-02: public read-only persistent market signals.
// GET /api/persistent/signals — additive, uses existing persistent router conventions.
//
// Public envelope always { status: 'success', data: { serverTime, worldId, director, coins } }
// No auth. Read-only. Never provisions, never ticks writer, never reconciles,
// never mutates state/Director/history/prices.
//
// Soft world resolve: no active world -> 200 + {worldId:null, director:null, coins:[]}
//   (never throws, never creates world).
//
// Active coins: non-retired (retired=false) catalogue rows that have a
//   market_coin_state row for the world. Use market_coin_state.status for
//   death authority (DEAD even while retired=false until reconcile soft-retires).
//   Soft-retired (retired=true) predecessors are excluded; replacements appear
//   with their persisted archetype.
//
// currentPrice: EXACTLY coins.current_price (the value persistent trades lock
//   and execute against). Never recompute, never use legacy/cycle pricing,
//   never call compute*Signal for price authority.
//
// recentChangePct: from committed price_history only (current = coins.current_price,
//   historical = price_history). Small bounded lookback (PUBLIC_SIGNAL_LOOKBACK_MS ~60s).
//   No committed sample before cutoff => null. DEAD => null. One query, no N+1.
//
// momentum: derived ONLY from recentChangePct using PUBLIC_MOMENTUM_THRESHOLD_PCT.
//   UP / DOWN / FLAT. FLAT for null or DEAD. Not an authority.
//
// director: from market_director_state (public fields only): { regime, intensity } or null.
//   Intensity rounded to 3dp to match publicRegimeAt contract. No seed, index,
//   rolls, timings, future, thresholds, internals.
//
// Consistent snapshot: when acquiring from pool, wrap the multi-table reads
//   (director + catalogue + history) in an explicit transaction so a concurrent
//   death/replace cannot yield a partial response (pre or post, never mix).
//
// Exact keys only (MVP): top {serverTime, worldId, director, coins},
//   director {regime, intensity} or null, coin {coinId, name, symbol, currentPrice,
//   dead, status, archetype, recentChangePct, momentum}.
//   Forbidden keys (cycle, apocalypse, phase, collapseRisk, seed, regimeIndex,
//   condition, future, etc.) are never present.
//
// pg numerics parsed explicitly. No circular imports. Reads avoid mutation paths
//   (no FOR UPDATE on director/coin-state for this path).
//
const db = require('../db/connection');
const persistentWorld = require('./persistentWorld');
const marketDomain = require('./marketDomain');

async function resolveActiveWorldOrNull(queryable) {
  try {
    return await persistentWorld.resolveActiveWorld(queryable);
  } catch (err) {
    if (err && /no active market world/.test(err.message)) {
      return null;
    }
    throw err;
  }
}

function parseNum(v) {
  if (v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

async function getPersistentMarketSignals({ queryable = db, now = new Date() } = {}) {
  const nowDate = (now instanceof Date && Number.isFinite(now.getTime())) ? now : new Date();
  const serverTime = nowDate.toISOString();

  // Snapshot-consistent: for normal db-pool path, acquire client and BEGIN
  // REPEATABLE READ *before* resolving active world on that client; all reads
  // under the same snapshot. Commit the no-world case too. Caller client
  // passed through without nesting tx.
  const ownsConnection = queryable === db;
  let client = queryable;
  if (ownsConnection) {
    client = await db.getClient();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
  }

  let world;
  try {
    world = await resolveActiveWorldOrNull(client);
    if (!world) {
      if (ownsConnection) {
        await client.query('COMMIT');
      }
      return { serverTime, worldId: null, director: null, coins: [] };
    }

    const worldId = world.worldId;

    // Director: direct read, no FOR UPDATE (do not acquire mutation/lock path)
    const { rows: dirRows } = await client.query(
      'SELECT regime, intensity FROM market_director_state WHERE world_id = $1',
      [worldId]
    );
    let director = null;
    if (dirRows.length > 0) {
      const intensity = parseNum(dirRows[0].intensity);
      director = {
        regime: dirRows[0].regime,
        intensity: intensity == null ? 0 : (Math.round(intensity * 1000) / 1000)
      };
    }

    // Active non-retired catalogue belonging to this world (via state row).
    // retired=false rows with DEAD status still appear (pre-reconcile).
    const { rows: coinRows } = await client.query(
      `SELECT c.coin_id, c.name, c.symbol, c.current_price,
              s.archetype, s.status
         FROM coins c
         JOIN market_coin_state s ON s.coin_id = c.coin_id AND s.world_id = $1
        WHERE c.retired = false
        ORDER BY c.coin_id ASC`,
      [worldId]
    );

    // Recent change from committed history only. Windowed query (no N+1).
    const coinIdList = coinRows.map((r) => Number(r.coin_id));
    const pastPrices = new Map();
    if (coinIdList.length > 0) {
      const lookbackMs = marketDomain.PUBLIC_SIGNAL_LOOKBACK_MS || 60000;
      const cutoff = new Date(nowDate.getTime() - lookbackMs).toISOString();
      const placeholders = coinIdList.map((_, i) => `$${i + 2}`).join(', ');
      const histSql = `
        SELECT coin_id, price
        FROM (
          SELECT coin_id, price,
                 ROW_NUMBER() OVER (PARTITION BY coin_id ORDER BY created_at DESC) AS rn
            FROM price_history
           WHERE coin_id IN (${placeholders})
             AND created_at <= $1
        ) ranked
        WHERE rn = 1
      `;
      const { rows: histRows } = await client.query(histSql, [cutoff, ...coinIdList]);
      for (const h of histRows) {
        const p = parseNum(h.price);
        if (p != null) pastPrices.set(Number(h.coin_id), p);
      }
    }

    const THRESH = marketDomain.PUBLIC_MOMENTUM_THRESHOLD_PCT;
    const coins = coinRows.map((row) => {
      const coinId = Number(row.coin_id);
      const currentPriceRaw = parseNum(row.current_price);
      const status = row.status;
      const isDead = status === 'DEAD';
      const archetype = row.archetype;

      // currentPrice always the direct DB value (authoritative for trades)
      const currentPrice = currentPriceRaw != null ? currentPriceRaw : 0;

      let recentChangePct = null;
      if (!isDead && pastPrices.has(coinId) && currentPriceRaw != null) {
        const past = pastPrices.get(coinId);
        if (past > 0) {
          const pct = ((currentPriceRaw - past) / past) * 100;
          recentChangePct = Math.round(pct * 100) / 100;
        }
      }

      let momentum = 'FLAT';
      if (recentChangePct !== null) {
        if (recentChangePct > THRESH) momentum = 'UP';
        else if (recentChangePct < -THRESH) momentum = 'DOWN';
      }

      return {
        coinId,
        name: row.name,
        symbol: row.symbol,
        currentPrice,
        dead: isDead,
        status,
        archetype,
        recentChangePct,
        momentum
      };
    });

    if (ownsConnection) {
      await client.query('COMMIT');
    }

    return {
      serverTime,
      worldId,
      director,
      coins
    };
  } catch (err) {
    if (ownsConnection && client && typeof client.query === 'function') {
      try { await client.query('ROLLBACK'); } catch (_) {}
    }
    throw err;
  } finally {
    if (ownsConnection && client && typeof client.release === 'function') {
      client.release();
    }
  }
}

module.exports = {
  getPersistentMarketSignals
};
