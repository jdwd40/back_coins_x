// Persistent-market Stage 1: persistence for the per-coin pricing
// checkpoints (market_price_checkpoints, migration 023).
//
// The live market writer (models/market-simulator.js) loads the current
// checkpoints inside its price batch transaction, prices each coin resuming
// from them (bit-identical to the stateless origin engine — see
// game/pricingCheckpoint.js), and upserts the fresh accumulators in the SAME
// transaction as the price + price_history writes: price, history and
// checkpoint commit together or roll back together.
//
// Precision contract: the accumulator doubles are stored as float8 (IEEE 754
// binary64) and round-trip EXACTLY through node-pg — a number written here
// reads back Object.is-equal, which is what makes a DB-resumed continuation
// bit-identical to an in-memory one. checkpoint_ms is bigint (integral epoch
// ms) and arrives as a string, converted with Number() (safe: epoch ms is
// far below 2^53); every numeric field is asserted finite on use by the
// engine validators.

// Convert a raw pg row to the camelCase checkpoint shape the engine layer
// consumes. float8 arrives as Number already; bigint arrives as string.
function rowToCheckpoint(row) {
  return {
    coinId: Number(row.coin_id),
    seed: row.seed,
    checkpointMs: Number(row.checkpoint_ms),
    domainCycleIndex: Number(row.domain_cycle_index),
    domainCycleStartMs: Number(row.domain_cycle_start_ms),
    domainAnchor: row.domain_anchor,
    domainBoundary: row.domain_boundary,
    crashEpisodeIndex: Number(row.crash_episode_index),
    crashCursorMs: Number(row.crash_cursor_ms),
    crashFactor: row.crash_factor,
    activationContext: row.activation_context
  };
}

// Load the current checkpoints for one timeline seed, keyed by coin id.
// Runs on the caller's client so it participates in the batch transaction
// (and its row locks). Missing rows simply mean "no checkpoint yet" — the
// first batch after the migration (or after a cycle rollover) prices from
// the origin and writes the initial accumulators.
async function loadCheckpoints(client, seed) {
  const { rows } = await client.query(
    `SELECT coin_id, seed, checkpoint_ms,
            domain_cycle_index, domain_cycle_start_ms, domain_anchor, domain_boundary,
            crash_episode_index, crash_cursor_ms, crash_factor, activation_context
       FROM market_price_checkpoints
      WHERE seed = $1
      FOR UPDATE`,
    [seed]
  );
  const byCoin = new Map();
  for (const row of rows) {
    byCoin.set(Number(row.coin_id), rowToCheckpoint(row));
  }
  return byCoin;
}

// Upsert one fresh accumulator. Idempotent by construction: the same batch
// replayed writes the same values (the checkpoint is a pure function of the
// timeline and the batch instant).
async function upsertCheckpoint(client, cp) {
  await client.query(
    `INSERT INTO market_price_checkpoints (
       coin_id, seed, checkpoint_ms,
       domain_cycle_index, domain_cycle_start_ms, domain_anchor, domain_boundary,
       crash_episode_index, crash_cursor_ms, crash_factor, activation_context
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (coin_id, seed) DO UPDATE SET
       checkpoint_ms        = EXCLUDED.checkpoint_ms,
       domain_cycle_index   = EXCLUDED.domain_cycle_index,
       domain_cycle_start_ms = EXCLUDED.domain_cycle_start_ms,
       domain_anchor        = EXCLUDED.domain_anchor,
       domain_boundary      = EXCLUDED.domain_boundary,
       crash_episode_index  = EXCLUDED.crash_episode_index,
       crash_cursor_ms      = EXCLUDED.crash_cursor_ms,
       crash_factor         = EXCLUDED.crash_factor,
       activation_context   = EXCLUDED.activation_context,
       updated_at           = now()`,
    [
      cp.coinId, cp.seed, cp.checkpointMs,
      cp.domainCycleIndex, cp.domainCycleStartMs, cp.domainAnchor, cp.domainBoundary,
      cp.crashEpisodeIndex, cp.crashCursorMs, cp.crashFactor, cp.activationContext
    ]
  );
}

module.exports = {
  rowToCheckpoint,
  loadCheckpoints,
  upsertCheckpoint
};
