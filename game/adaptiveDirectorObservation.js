// Director Coin Events Wave 2: the bounded current-market observation for
// the adaptive Director.
//
// Builds the complete, bounded snapshot the pure decision domain
// (game/adaptiveDirector.js) consumes. EXACT persisted-source definition
// (every value below names its source columns):
//
//   * liveCoinCount / coins[] —
//       market_coin_state (world_id = active world, status = 'ALIVE')
//       JOIN coins (retired = FALSE), ordered by coin_id.
//       Per coin: coinId, archetype, condition, structuralReference,
//       peakReference (all market_coin_state columns) and currentPrice
//       (coins.current_price). movementPct is derived from ticks (below).
//   * per-coin movementPct / breadth / medianMovementPct /
//     broadMovementPct / lastMeaningfulMovementAtMs —
//       price_history rows with source = 'MARKET_TICK' AND
//       cycle_id IS NULL (the persistent provenance, migration 019) AND
//       created_at inside (nowMs - observationLookbackMs, nowMs], with the
//       lower bound clipped UP to the world epoch (market_worlds
//       .epoch_started_at) so no pre-epoch row can leak in. Per coin the
//       movement is lastPrice/firstPrice - 1 over that window (null with
//       fewer than two in-window ticks); breadth counts coins at/above
//       breadthThresholdPct (null movement counts as flat); the median and
//       broad (mean) movement use only coins with an observed movement;
//       lastMeaningfulMovementAtMs is the MARKET-WIDE breadth-aware clock
//       (PR #36 correction): per LIVE coin, the latest in-window tick whose
//       delta from that coin's previous in-window tick reaches
//       stagnationThresholdPct; the market clock is the breadth-crossing
//       time — the k-th largest of those per-coin instants with
//       k = max(1, ceil(stagnationBreadthFraction x liveCoinCount)) — or
//       null when fewer than k live coins moved meaningfully (a single
//       outlier never resets the market clock).
//   * drawdownPct — mean over live coins of
//       max(0, 1 - coins.current_price / market_coin_state.peak_reference)
//       (the DECAYING peak reference, migration 024 — never an all-time
//       monotonic peak).
//   * weakCount / distressedCount — live coins with condition at/below
//       directorControl.weakConditionThreshold / distressedConditionThreshold.
//   * recentDeaths / recentDeathCount — market_coin_state rows with
//       status = 'DEAD' and died_at inside the WIDER of the death-cluster
//       window and the recent-death safety window; recentDeathCount counts
//       those inside deathClusterWindowMs.
//   * recentReplacements — market_coin_state.created_at (timestamptz)
//       inside the recent-death safety window. A replacement joins the
//       world with a freshly created state row; the opening roster's state
//       rows are created at the world's first batch, so once the world is
//       older than the safety window only genuine replacements qualify (a
//       world younger than the window briefly spares all fresh coins from
//       targeting — conservative and bounded).
//   * macro — the deterministic six-regime Director position at nowMs:
//       resumed from the committed market_director_state row via
//       marketDirector.resumeDirectorCursor (bit-verified) when one exists,
//       else the genesis walk from the world origin. Regime, regimeIndex,
//       intensity and the lerped Market Environment. This is a PURE seeded
//       computation over the committed cursor — no world-age walk.
//
// Boundedness contract: every query is time- or roster-bounded; nothing
// walks world-age history or future deterministic state. When handed the
// pool (getClient) the whole build runs inside ONE pooled-client
// REPEATABLE READ READ ONLY snapshot transaction so every read sees one
// consistent instant; when handed an already-acquired client it
// participates in the caller's transaction.
//
// Internal-only: the observation is never exposed on any public route.
// This module never reads or writes any apocalypse_* table and never
// writes anything at all.

const marketDirector = require('./marketDirector');
const directorStateModel = require('../models/marketDirectorState.model');
const { resolveSimulationConfig } = require('./simulationConfig');

function requireFiniteNow(nowMs) {
  const value = Number(nowMs);
  if (!Number.isFinite(value)) {
    throw new Error(`adaptive director observation nowMs must be finite; received ${String(nowMs)}`);
  }
  return value;
}

function requireWorld(world) {
  if (!world || typeof world !== 'object'
      || !Number.isInteger(Number(world.worldId)) || Number(world.worldId) <= 0
      || typeof world.seed !== 'string' || world.seed.length === 0
      || !Number.isFinite(Number(world.epochStartedAtMs))) {
    throw new Error('adaptive director observation requires a validated persistent world (worldId, seed, epochStartedAtMs)');
  }
  return world;
}

// Median of a numeric array (null on empty). Never mutates the input.
function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The pure snapshot reduction: coin rows + bounded ticks -> the
// observation's market fields. Deterministic: inputs come from one
// snapshot transaction and every ordering is canonical.
function reduceSnapshot({ coinRows, tickRows, deathRows, replacementRows, macro, nowMs, world, config }) {
  const dc = config.directorControl;
  const lookbackStartMs = Math.max(nowMs - dc.observationLookbackMs, world.epochStartedAtMs);

  // Canonical per-coin tick chains (already ordered coin_id, created_at).
  const ticksByCoin = new Map();
  for (const tick of tickRows) {
    const coinId = Number(tick.coin_id);
    if (!ticksByCoin.has(coinId)) ticksByCoin.set(coinId, []);
    ticksByCoin.get(coinId).push({ price: Number(tick.price), atMs: new Date(tick.created_at).getTime() });
  }

  const movementByCoin = new Map();
  // Per-coin last-meaningful-movement instants (LIVE coins only): the
  // latest in-window tick whose delta from that coin's previous in-window
  // tick reaches stagnationThresholdPct.
  const lastMeaningfulByCoin = new Map();
  for (const [coinId, ticks] of ticksByCoin) {
    if (ticks.length >= 2) {
      const first = ticks[0].price;
      const last = ticks[ticks.length - 1].price;
      if (first > 0) {
        movementByCoin.set(coinId, last / first - 1);
      }
    }
    for (let i = 1; i < ticks.length; i++) {
      const previous = ticks[i - 1].price;
      if (previous > 0 && Math.abs(ticks[i].price / previous - 1) >= dc.stagnationThresholdPct) {
        if (!lastMeaningfulByCoin.has(coinId) || ticks[i].atMs > lastMeaningfulByCoin.get(coinId)) {
          lastMeaningfulByCoin.set(coinId, ticks[i].atMs);
        }
      }
    }
  }

  const liveRows = coinRows.filter((row) => row.status === 'ALIVE' && row.retired !== true);
  const coins = liveRows.map((row) => {
    const coinId = Number(row.coin_id);
    return {
      coinId,
      archetype: row.archetype,
      condition: Number(row.condition),
      structuralReference: Number(row.structural_reference),
      peakReference: Number(row.peak_reference),
      currentPrice: Number(row.current_price),
      movementPct: movementByCoin.has(coinId) ? movementByCoin.get(coinId) : null
    };
  });

  const breadth = { rising: 0, falling: 0, flat: 0 };
  for (const coin of coins) {
    if (coin.movementPct === null || Math.abs(coin.movementPct) < dc.breadthThresholdPct) breadth.flat += 1;
    else if (coin.movementPct > 0) breadth.rising += 1;
    else breadth.falling += 1;
  }

  const movements = coins.map((coin) => coin.movementPct).filter((value) => value !== null);

  // Market-wide breadth-aware stagnation clock (PR #36 correction): the
  // market refreshes only when a useful breadth of LIVE coins —
  // ceil(stagnationBreadthFraction x liveCoinCount) — each moved
  // meaningfully inside the lookback. The refreshed instant is the
  // breadth-crossing time (the k-th largest per-coin last-meaningful
  // time), never the latest tick of any one coin; when fewer than k live
  // coins moved meaningfully the market did not move (null) and one
  // volatile outlier can never reset the clock.
  const requiredMeaningfulMovers = Math.max(1, Math.ceil(dc.stagnationBreadthFraction * coins.length));
  const liveMeaningfulTimes = coins
    .map((coin) => lastMeaningfulByCoin.get(coin.coinId))
    .filter((atMs) => atMs !== undefined)
    .sort((a, b) => b - a);
  const lastMeaningfulMovementAtMs = liveMeaningfulTimes.length >= requiredMeaningfulMovers
    ? liveMeaningfulTimes[requiredMeaningfulMovers - 1]
    : null;

  const drawdownPct = coins.length === 0
    ? 0
    : coins.reduce((sum, coin) => sum + Math.max(0, 1 - coin.currentPrice / coin.peakReference), 0) / coins.length;

  const deathWindowMs = Math.max(dc.deathClusterWindowMs, dc.recentDeathSafetyMs);
  const deaths = deathRows
    .map((row) => ({ coinId: Number(row.coin_id), diedAtMs: new Date(row.died_at).getTime() }))
    .filter((death) => nowMs - death.diedAtMs <= deathWindowMs)
    .sort((a, b) => a.diedAtMs - b.diedAtMs || a.coinId - b.coinId);
  const recentDeathCount = deaths.filter((death) => nowMs - death.diedAtMs <= dc.deathClusterWindowMs).length;

  const replacements = replacementRows
    .map((row) => ({ coinId: Number(row.coin_id), createdAtMs: new Date(row.created_at).getTime() }))
    .filter((replacement) => nowMs - replacement.createdAtMs <= dc.recentDeathSafetyMs)
    .sort((a, b) => a.createdAtMs - b.createdAtMs || a.coinId - b.coinId);

  return {
    nowMs,
    worldId: Number(world.worldId),
    lookbackStartMs,
    liveCoinCount: coins.length,
    coins,
    breadth,
    medianMovementPct: median(movements),
    broadMovementPct: movements.length === 0
      ? null
      : movements.reduce((sum, value) => sum + value, 0) / movements.length,
    drawdownPct,
    weakCount: coins.filter((coin) => coin.condition <= dc.weakConditionThreshold).length,
    distressedCount: coins.filter((coin) => coin.condition <= dc.distressedConditionThreshold).length,
    recentDeathCount,
    recentDeaths: deaths,
    recentReplacements: replacements,
    lastMeaningfulMovementAtMs,
    macro
  };
}

async function buildWithClient(client, { world, nowMs, config }) {
  const dc = config.directorControl;
  const worldId = Number(world.worldId);
  const nowIso = new Date(nowMs).toISOString();
  const lookbackStartMs = Math.max(nowMs - dc.observationLookbackMs, world.epochStartedAtMs);
  const deathWindowMs = Math.max(dc.deathClusterWindowMs, dc.recentDeathSafetyMs);
  const deathStartIso = new Date(nowMs - deathWindowMs).toISOString();
  const replacementStartIso = new Date(nowMs - dc.recentDeathSafetyMs).toISOString();

  // 1. Live/roster snapshot (roster-bounded).
  const { rows: coinRows } = await client.query(
    `SELECT c.coin_id, c.current_price, c.retired,
            s.archetype, s.condition, s.structural_reference, s.peak_reference, s.status
       FROM market_coin_state s
       JOIN coins c ON c.coin_id = s.coin_id
      WHERE s.world_id = $1
      ORDER BY c.coin_id`,
    [worldId]
  );
  // 2. Bounded persistent ticks inside the lookback (epoch-clipped).
  const { rows: tickRows } = await client.query(
    `SELECT coin_id, price, created_at
       FROM price_history
      WHERE source = 'MARKET_TICK'
        AND cycle_id IS NULL
        AND created_at > $1
        AND created_at <= $2
      ORDER BY coin_id, created_at`,
    [new Date(lookbackStartMs).toISOString(), nowIso]
  );
  // 3. Recent deaths (bounded by the wider death/safety window).
  const { rows: deathRows } = await client.query(
    `SELECT coin_id, died_at
       FROM market_coin_state
      WHERE world_id = $1
        AND status = 'DEAD'
        AND died_at > $2
        AND died_at <= $3
      ORDER BY died_at, coin_id`,
    [worldId, deathStartIso, nowIso]
  );
  // 4. Recent replacements: state rows created inside the safety window
  //    (a replacement joins the world with a fresh market_coin_state row).
  const { rows: replacementRows } = await client.query(
    `SELECT coin_id, created_at
       FROM market_coin_state
      WHERE world_id = $1
        AND created_at > $2
        AND created_at <= $3
      ORDER BY created_at, coin_id`,
    [worldId, replacementStartIso, nowIso]
  );
  // 5. The committed Director cursor (lock-free plain read; the adaptive
  //    observer never takes write locks).
  const { rows: directorRows } = await client.query(
    `SELECT world_id, regime, regime_started_at, intensity, regime_index
       FROM market_director_state
      WHERE world_id = $1`,
    [worldId]
  );
  const committedDirector = directorRows.length === 0 ? null : directorStateModel.rowToState(directorRows[0]);

  // The macro environment: a pure seeded resume from the committed cursor
  // (bit-verified) or the genesis walk — never a world-age walk.
  const provider = marketDirector.createMarketDirectorProvider({
    seed: world.seed,
    originMs: world.epochStartedAtMs,
    cursor: committedDirector
      ? marketDirector.resumeDirectorCursor({ seed: world.seed, state: committedDirector, config })
      : null,
    config
  });
  const located = provider.regimeAt(nowMs);

  return reduceSnapshot({
    coinRows,
    tickRows,
    deathRows,
    replacementRows,
    macro: {
      regime: located.regime,
      regimeIndex: located.regimeIndex,
      intensity: located.intensity,
      environment: provider.environmentAt(nowMs)
    },
    nowMs,
    world,
    config
  });
}

// Build the bounded observation for the active world at the injected
// instant. Pool input: one REPEATABLE READ READ ONLY snapshot transaction
// on a single client. Client input: participates in the caller's
// transaction.
async function buildAdaptiveDirectorObservation(queryable, { world, nowMs, config = resolveSimulationConfig() } = {}) {
  requireWorld(world);
  const now = requireFiniteNow(nowMs);
  if (!config || !config.directorControl) {
    throw new Error('adaptive director observation requires a validated config with a directorControl section');
  }
  if (typeof queryable.getClient === 'function') {
    const client = await queryable.getClient();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const observation = await buildWithClient(client, { world, nowMs: now, config });
      await client.query('COMMIT');
      return observation;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
  return buildWithClient(queryable, { world, nowMs: now, config });
}

module.exports = {
  buildAdaptiveDirectorObservation
};
