// Persistent-market Stage 9 S9-03: authoritative death -> delayed replacement runtime.
//
// This module consumes the reviewed S9-01 permanent-death contract and the
// reviewed S9-02 authored replacement-pool contract. It deliberately owns
// only runtime reconciliation:
//   * DEAD catalogue rows are soft-retired (history is never deleted);
//   * a death becomes replacement-eligible only after the configured delay;
//   * exactly one authored identity is consumed for each eligible death;
//   * the active market is refilled only up to targetActiveCount;
//   * every replacement gets an explicit authored archetype, persistent
//     market state, an initial world-scoped history tick and a pricing
//     checkpoint before the transaction commits.
//
// Idempotency / concurrency:
//   * all historical coin ids come from the durable coins table and are
//     passed to the S9-02 validator as ADDITIONAL reserved identities;
//   * inserted authored identities and DEAD rows are monotonic durable
//     counters, so restart/replay derives the same outstanding work;
//   * an EXCLUSIVE coins table lock serializes this short reconciliation
//     with the market writer/trades (which take row/table write locks), and
//     market_coin_state rows are then locked in the same coins -> state
//     order as the market writer. Multiple processes therefore converge
//     without duplicate replacements.
//
// No wall-clock read occurs in the domain logic when nowMs is supplied;
// production's worker supplies Date.now(), while tests/simulations inject it.

const db = require('../db/connection');
const persistentWorld = require('./persistentWorld');
const replacementPool = require('./replacementPool');
const persistentPricing = require('./persistentPricing');
const { NEUTRAL_ENVIRONMENT } = require('./marketEnvironment');
const coinStateModel = require('../models/marketCoinState.model');
const checkpointModel = require('../models/pricingCheckpoint.model');

class PersistentReplacementRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersistentReplacementRuntimeError';
  }
}

function requireFiniteNow(nowMs) {
  const value = Number(nowMs);
  if (!Number.isFinite(value)) {
    throw new PersistentReplacementRuntimeError(
      `replacement runtime nowMs must be finite; received ${String(nowMs)}`
    );
  }
  return value;
}

function authoredIdSet(config) {
  return new Set(replacementPool.loadReplacementRoster(config).map((entry) => entry.coinId));
}

function parseDeathMs(row) {
  const value = row.died_at == null ? NaN : new Date(row.died_at).getTime();
  if (!Number.isFinite(value)) {
    throw new PersistentReplacementRuntimeError(
      `DEAD coin ${String(row.coin_id)} has invalid died_at ${String(row.died_at)}`
    );
  }
  return value;
}

async function reconcilePersistentReplacements({
  nowMs = Date.now(),
  replacementConfig = replacementPool.resolveReplacementConfig()
} = {}) {
  const effectiveNowMs = requireFiniteNow(nowMs);
  const effectiveConfig = replacementConfig === replacementPool.DEFAULT_REPLACEMENT_CONFIG
    ? replacementConfig
    : replacementPool.resolveReplacementConfig(replacementConfig);
  const targetActiveCount = replacementPool.getTargetActiveCount(effectiveConfig);
  const replacementDelayMs = replacementPool.getReplacementDelayMs(effectiveConfig);
  const nowIso = new Date(effectiveNowMs).toISOString();
  const eligibilityCutoffMs = effectiveNowMs - replacementDelayMs;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Short global catalogue gate. The market writer's SELECT ... FOR UPDATE
    // and trade writes cannot cross this lock, so runtime insertion is atomic
    // with respect to every reader/writer that can create a conflicting row.
    // Once acquired, lock state rows second: same coins -> state order as the
    // market writer, avoiding lock-order inversion.
    await client.query('LOCK TABLE coins IN EXCLUSIVE MODE');
    const world = await persistentWorld.resolveActiveWorld(client);

    const { rows: coinRows } = await client.query(
      'SELECT coin_id, retired FROM coins ORDER BY coin_id FOR UPDATE'
    );
    const { rows: stateRows } = await client.query(
      `SELECT coin_id, status, died_at
         FROM market_coin_state
        WHERE world_id = $1
        ORDER BY coin_id
        FOR UPDATE`,
      [world.worldId]
    );

    // A provisioned world can briefly exist before the market writer's first
    // atomic state-initialisation batch. Do not interpret that as ten missing
    // coins and never fabricate replacement work without a recorded death.
    if (stateRows.length === 0) {
      await client.query('COMMIT');
      return {
        worldId: world.worldId,
        stateReady: false,
        retiredCoinIds: [],
        inserted: [],
        eligibleDeaths: 0,
        pendingEligibleDeaths: 0,
        activeBefore: 0,
        activeAfter: 0
      };
    }

    const stateById = new Map(stateRows.map((row) => [Number(row.coin_id), row]));
    const coinById = new Map(coinRows.map((row) => [Number(row.coin_id), {
      coinId: Number(row.coin_id),
      retired: row.retired === true
    }]));

    // DEAD is authoritative in market_coin_state. Soft-retirement only hides
    // the dead catalogue identity from active lists; it never deletes the
    // coin, holdings, transactions or price history.
    const deadRows = stateRows.filter((row) => row.status === 'DEAD');
    const deadCoinIds = deadRows.map((row) => Number(row.coin_id));
    const needsRetirement = deadCoinIds.filter((coinId) => {
      const coin = coinById.get(coinId);
      if (!coin) {
        throw new PersistentReplacementRuntimeError(
          `persistent state references missing coin ${coinId}; history identity is corrupt`
        );
      }
      return coin.retired === false;
    });
    if (needsRetirement.length > 0) {
      await client.query(
        'UPDATE coins SET retired = TRUE WHERE coin_id = ANY($1::int[]) AND retired = FALSE',
        [needsRetirement]
      );
      for (const coinId of needsRetirement) {
        coinById.get(coinId).retired = true;
      }
    }

    // S9-02 contract: the hardcoded historical baseline is only a floor.
    // Runtime supplies EVERY identity already present in durable storage as
    // additional reserved ids, so no dead/live/replacement coin_id can ever
    // be recycled even after restarts.
    const historicalIds = coinRows.map((row) => Number(row.coin_id));
    const authoredIds = authoredIdSet(effectiveConfig);
    const insertedAuthoredIds = historicalIds.filter((id) => authoredIds.has(id));

    // Every runtime-authored coin must also have persistent state in this
    // world; otherwise silently counting it as a completed replacement would
    // hide a partial/corrupt insertion.
    for (const id of insertedAuthoredIds) {
      if (!stateById.has(id)) {
        throw new PersistentReplacementRuntimeError(
          `authored replacement coin ${id} exists without market_coin_state in world ${world.worldId}`
        );
      }
    }

    if (insertedAuthoredIds.length > deadRows.length) {
      throw new PersistentReplacementRuntimeError(
        `replacement invariant broken: ${insertedAuthoredIds.length} authored replacements exist for only ${deadRows.length} recorded deaths`
      );
    }

    const eligibleDeathCount = deadRows.reduce((count, row) => (
      parseDeathMs(row) <= eligibilityCutoffMs ? count + 1 : count
    ), 0);
    const pendingEligibleDeaths = Math.max(0, eligibleDeathCount - insertedAuthoredIds.length);

    const activeBefore = stateRows.reduce((count, row) => {
      if (row.status !== 'ALIVE') return count;
      const coin = coinById.get(Number(row.coin_id));
      return coin && coin.retired === false ? count + 1 : count;
    }, 0);
    const openSlots = Math.max(0, targetActiveCount - activeBefore);
    const insertCount = Math.min(openSlots, pendingEligibleDeaths);

    const inserted = [];
    for (let i = 0; i < insertCount; i += 1) {
      const definition = replacementPool.peekNextReplacement(historicalIds, effectiveConfig);
      if (!definition) {
        throw new PersistentReplacementRuntimeError(
          `authored replacement pool exhausted with ${pendingEligibleDeaths - i} eligible death(s) still pending`
        );
      }

      // Re-validate the exact authored row against ALL durable identities.
      // This is intentionally redundant with peek: failure here is loud and
      // protects S9-03 if the pool API changes later.
      const validated = replacementPool.validateReplacementDefinition(definition, {
        historicalIds
      });

      await client.query(
        `INSERT INTO coins (
           coin_id, name, symbol, current_price, market_cap,
           circulating_supply, price_change_24h, founder, date_added,
           cycle_baseline_price, retired
         ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, $9, FALSE)`,
        [
          validated.coinId,
          validated.name,
          validated.symbol,
          validated.startingPrice,
          validated.marketCap,
          validated.circulatingSupply,
          validated.founder,
          nowIso,
          validated.startingPrice
        ]
      );

      // Explicit authored archetype: replacement ids are intentionally NOT
      // added to the legacy GAMEPLAY_ROSTER and must never reach its silent
      // unknown-id -> MOON fallback.
      const state = {
        coinId: validated.coinId,
        worldId: world.worldId,
        archetype: validated.archetype,
        condition: 0,
        structuralReference: validated.startingPrice,
        peakReference: validated.startingPrice,
        status: 'ALIVE',
        diedAt: null
      };
      await coinStateModel.upsertCoinState(client, state);

      // Initialise the resumable pricing accumulator at the introduction
      // instant, rather than walking the replacement from the world's epoch.
      // Subsequent writer ticks resume from this checkpoint, so a coin added
      // months into a persistent world still has bounded first-tick work.
      const checkpoint = persistentPricing.extractPersistentCheckpoint({
        seed: world.seed,
        coinId: validated.coinId,
        archetypeId: validated.archetype,
        originMs: effectiveNowMs,
        nowMs: effectiveNowMs,
        reference: validated.startingPrice,
        environment: NEUTRAL_ENVIRONMENT
      });
      await checkpointModel.upsertCheckpoint(client, checkpoint);

      // The authored starting price is the visible introduction tick. The
      // next market batch resumes the checkpoint and begins normal movement.
      await client.query(
        `INSERT INTO price_history (coin_id, cycle_id, price, created_at, source)
         VALUES ($1, NULL, $2, $3, 'MARKET_TICK')`,
        [validated.coinId, validated.startingPrice, nowIso]
      );

      historicalIds.push(validated.coinId);
      stateById.set(validated.coinId, {
        coin_id: validated.coinId,
        status: 'ALIVE',
        died_at: null
      });
      coinById.set(validated.coinId, { coinId: validated.coinId, retired: false });
      inserted.push({
        coinId: validated.coinId,
        symbol: validated.symbol,
        archetype: validated.archetype,
        introducedAt: nowIso
      });
    }

    if (inserted.length > 0) {
      // Explicit authored ids do not advance a serial sequence by themselves.
      // Keep future default inserts above every historical identity so an
      // unrelated insert cannot later collide with an authored id already used.
      await client.query(
        `SELECT setval(
           pg_get_serial_sequence('coins', 'coin_id'),
           (SELECT MAX(coin_id) FROM coins),
           true
         )`
      );
    }

    await client.query('COMMIT');
    return {
      worldId: world.worldId,
      stateReady: true,
      retiredCoinIds: needsRetirement,
      inserted,
      eligibleDeaths: eligibleDeathCount,
      pendingEligibleDeaths,
      activeBefore,
      activeAfter: activeBefore + inserted.length
    };
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PersistentReplacementRuntimeError,
  reconcilePersistentReplacements
};
