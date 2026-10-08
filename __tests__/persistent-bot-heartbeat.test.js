// Issue #56: persistent bots frozen (100% cash, no trades) — regression and
// hardening coverage against the REAL disposable coins_test database.
//
// Verified production root cause (read-only replay of the deployed decision
// code, 8 Oct): DUST positions. Full exits sized as floor(quantity * 1)
// left 1e-8 behind and repeated fractional sells shrank positions below the
// £0.01 minimum notional. Unsellable dust still counted as "held", so the
// coin was excluded from entries forever, and a risk-exit on dust was
// re-decided and rejected every tick before entries were considered.
//
// Hardening covered here (the issue's three suspected modes):
//   * healthy Reckless Ray buy despite dust in every coin;
//   * all-coin signal failure claims nothing and the SAME tick recovers;
//   * a hung database lock is cancelled server-side (lock/statement
//     timeouts) — the tick settles with outcome TIMEOUT, no overlap, no
//     leaked lock, and the next tick succeeds;
//   * cooperative deadline; cross-process run lock (BUSY, no claim);
//   * durable heartbeat: claim vs success distinct, stale after 3 intervals,
//     exposed through GET /api/persistent/runtime with allowlisted fields;
//   * worker: in-flight guard only clears when the tick has settled; one
//     safe summary line per tick.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const persistentWorld = require('../game/persistentWorld');
const persistentEconomy = require('../game/persistentEconomy');
const persistentDebt = require('../game/persistentDebt');
const persistentBots = require('../game/persistentBots');
const persistentSignals = require('../game/persistentSignals');
const persistentBotWorker = require('../game/persistentBotWorker');
const heartbeatModel = require('../models/persistentBotHeartbeat.model');
const logger = require('../utils/logger');
const { BOT_ROSTER, resolvePersistentBotTickLimits } = require('../game/botConfig');
const { ensureBotsProvisioned, createBotRandom } = require('../game/persistentBotProvisioning');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const WORLD_SEED = 'issue56-bot-heartbeat-seed';
const T_MS = Date.parse('2026-09-20T12:00:00.000Z');
const DEFAULT_LIMITS = resolvePersistentBotTickLimits(60000);
const FAST_LIMITS = {
  ...DEFAULT_LIMITS,
  deadlineMs: 20000,
  statementTimeoutMs: 3000,
  lockTimeoutMs: 300
};

let blockers = [];

async function openBlocker(...statements) {
  const client = await db.getClient();
  blockers.push(client);
  await client.query('BEGIN');
  for (const sql of statements) await client.query(sql);
  return client;
}

async function releaseBlockers() {
  for (const client of blockers) {
    try { await client.query('ROLLBACK'); } catch (_) { /* already closed */ }
    try { await client.query('SELECT pg_advisory_unlock_all()'); } catch (_) { /* ignore */ }
    client.release();
  }
  blockers = [];
}

async function provisionFreshWorld() {
  await persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(T_MS - 10 * 60 * 1000) });
  for (const offset of [-120000, -90000, -60000, -30000, 0]) {
    await marketSimulator.updateAllPrices({ nowMs: T_MS + offset });
  }
  return persistentWorld.resolveActiveWorld(db);
}

async function rosterBot(botKey) {
  const roster = await ensureBotsProvisioned({ queryable: db });
  const bot = roster.find((b) => b.botKey === botKey);
  const account = await persistentEconomy.provisionPersistentAccount({ userId: bot.userId });
  return { ...bot, accountId: account.accountId, worldId: account.worldId };
}

// The production shape: a 1e-8 (or sub-penny) dust holding in EVERY coin.
async function seedDustEverywhere(bot) {
  const { rows } = await db.query('SELECT coin_id FROM coins WHERE retired = false ORDER BY coin_id');
  for (const { coin_id: coinId } of rows) {
    await db.query(
      `INSERT INTO persistent_holdings (account_id, world_id, user_id, coin_id, quantity, cost_basis)
       VALUES ($1, $2, $3, $4, 0.00000001, 0)`,
      [bot.accountId, bot.worldId, bot.userId, coinId]
    );
  }
}

// A tick id at which Ray's seeded draw does NOT take the contrarian branch,
// so his DEGEN/RUG preference decides (pure + deterministic).
function nonContrarianRayTick(from) {
  for (let tickId = from; tickId < from + 500; tickId++) {
    const random = createBotRandom({ seed: WORLD_SEED, botKey: 'reckless-ray', tickId });
    if (random() >= 0.15) return tickId;
  }
  throw new Error('no non-contrarian tick found');
}

async function heartbeatRow(worldId) {
  const { rows } = await db.query('SELECT * FROM persistent_bot_heartbeat WHERE world_id = $1', [worldId]);
  return rows[0] || null;
}

async function claimCount() {
  const { rows } = await db.query('SELECT count(*)::int AS n FROM persistent_bot_ticks');
  return rows[0].n;
}

function silentLogger() {
  const errors = [];
  return { errors, log: () => {}, warn: () => {}, info: () => {}, error: (...a) => errors.push(a.map(String).join(' ')) };
}

describe('issue #56: dust positions no longer freeze bots (pure decision layer)', () => {
  const degen = {
    coinId: 9, symbol: 'MTC', currentPrice: 22074.0657, dead: false, history: [22000, 22074.0657],
    phase: 'DIP', momentum: 'DOWN', archetype: 'DEGEN', collapseRisk: 'DANGER', recentChangePct: -15.6
  };
  const zip = {
    coinId: 1, symbol: 'FTR', currentPrice: 41601.0542, dead: false, history: [41000, 41601.0542],
    phase: 'DIP', momentum: 'DOWN', archetype: 'ZIP', collapseRisk: 'SHAKY', recentChangePct: -4.75
  };
  const dust = (coin) => ({
    coinId: coin.coinId, symbol: coin.symbol, quantity: 1e-8, costBasis: 0, averageEntryPrice: 0,
    currentValue: 0, unrealizedPnlPct: null
  });
  const notContrarian = (() => { const seq = [0.9, 0]; let i = 0; return () => seq[Math.min(i++, seq.length - 1)]; });

  test('production replay: Ray with 1e-8 dust in MTC still buys the live DEGEN coin', () => {
    const state = { coins: [zip, degen], cash: 19727.31, debt: 0, holdings: [dust(zip), dust(degen)] };
    const decision = persistentBots.decidePersistentBotAction({ strategy: 'reckless', state, random: notContrarian() });
    expect(decision.type).toBe('BUY');
    expect(decision.coinId).toBe(9);
    expect(decision.reason).toBe('entry');
    expect(decision.quantity * degen.currentPrice).toBeLessThanOrEqual(2500);
    expect(decision.quantity * degen.currentPrice).toBeGreaterThan(2499);
  });

  test('production replay: Carl never re-decides an unsellable 1e-8 risk-exit', () => {
    const state = { coins: [zip, degen], cash: 60281.3, debt: 0, holdings: [dust(zip), dust(degen)] };
    const decision = persistentBots.decidePersistentBotAction({ strategy: 'conservative', state, random: notContrarian() });
    expect(decision.type).not.toBe('SELL');
  });

  test('a full exit sells the exact held quantity (never a floored product that strands 1e-8)', () => {
    // 0.08241077 * 1 floored at 8dp was 0.08241076 in production (Ray, MTC:
    // BUY 0.08241077, SELL 0.08241076, 1e-8 left forever). The float product
    // is 8241076.999999999, so the old floor(quantity * fraction) formula
    // reproduces the exact production dust:
    expect(Math.floor(0.08241077 * 1 * 1e8) / 1e8).toBe(0.08241076);
    const coin = { ...degen, currentPrice: 24518.1 };
    const holding = { coinId: 9, symbol: 'MTC', quantity: 0.08241077, costBasis: 2500, averageEntryPrice: 2500 / 0.08241077, currentValue: 2020.5, unrealizedPnlPct: -19.18 };
    expect(persistentBots.exitSellQuantity(holding, coin, 1)).toBe(0.08241077);
  });

  test('a partial exit that would strand a sub-penny remainder sells the whole position', () => {
    const coin = { ...degen, currentPrice: 60 };
    const holding = { coinId: 9, symbol: 'MTC', quantity: 0.00012, costBasis: 0.01, averageEntryPrice: 83.33, currentValue: 0.01, unrealizedPnlPct: 0 };
    // £0.0072 position: half (0.00006, £0.0036) would be unsellable AND
    // leave unsellable dust behind (the production halving pattern), so the
    // whole meaningful position is sold instead.
    expect(persistentBots.exitSellQuantity(holding, coin, 0.5)).toBe(0.00012);
    // A healthy partial exit is unchanged when the remainder stays sellable.
    const big = { ...holding, quantity: 10, costBasis: 600, currentValue: 600 };
    expect(persistentBots.exitSellQuantity(big, coin, 0.5)).toBe(5);
    // Dust itself is unsellable: no exit quantity at all.
    expect(persistentBots.exitSellQuantity({ ...holding, quantity: 1e-8 }, coin, 1)).toBeNull();
  });
});

describe('issue #56: tick hardening against the real disposable database', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
    marketSimulator.lastBatch = null;
  });

  afterEach(async () => {
    await releaseBlockers();
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('healthy tick: Reckless Ray opens a DEGEN/RUG position despite dust in every coin; heartbeat records SUCCESS', async () => {
    const world = await provisionFreshWorld();
    const ray = await rosterBot('reckless-ray');
    await seedDustEverywhere(ray);
    const tickId = nonContrarianRayTick(1000);

    const result = await persistentBots.runPersistentBotTick({ tickId, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(result.claimed).toBe(true);
    expect(result.outcome).toBe('SUCCESS');
    const rayAction = result.actions.find((a) => a.botKey === 'reckless-ray');
    expect(rayAction.action).toBe('BUY');
    expect([3, 9]).toContain(rayAction.coinId); // test catalogue: 3 = RUG, 9 = DEGEN

    const { rows: [held] } = await db.query(
      'SELECT quantity FROM persistent_holdings WHERE account_id = $1 AND coin_id = $2',
      [ray.accountId, rayAction.coinId]
    );
    expect(parseFloat(held.quantity)).toBeGreaterThan(1);

    const hb = await heartbeatRow(world.worldId);
    expect(hb.last_outcome).toBe('SUCCESS');
    expect(Number(hb.last_claimed_tick_id)).toBe(tickId);
    expect(Number(hb.last_success_tick_id)).toBe(tickId);
    expect(hb.last_action_at).not.toBeNull();
    expect(hb.consecutive_failures).toBe(0);
    expect(hb.last_trade_count).toBe(result.summary.trades);
    expect(hb.last_trade_count + hb.last_hold_count + hb.last_skip_count).toBe(result.actions.length);
  });

  test('all-coin signal failure claims nothing, records SIGNALS_FAILED, and the SAME tick recovers', async () => {
    const world = await provisionFreshWorld();
    const spy = jest.spyOn(persistentSignals, 'computeCommittedPersistentCoinSignal').mockImplementation(() => {
      throw new Error('synthetic signal outage');
    });
    const log = silentLogger();
    const failure = await persistentBots.runPersistentBotTick({ tickId: 2000, nowMs: T_MS, logger: log, limits: FAST_LIMITS })
      .then(() => null, (err) => err);
    expect(failure).not.toBeNull();
    expect(failure.message).toMatch(/failed for all \d+ live coins/);
    expect(failure.outcome).toBe('SIGNALS_FAILED');
    expect(failure.claimed).toBe(false);
    expect(await claimCount()).toBe(0); // a failed tick never looks claimed
    let hb = await heartbeatRow(world.worldId);
    expect(hb.last_outcome).toBe('SIGNALS_FAILED');
    expect(hb.consecutive_failures).toBe(1);
    expect(hb.last_success_at).toBeNull();
    expect(hb.last_claimed_at).toBeNull();

    spy.mockRestore();
    const recovered = await persistentBots.runPersistentBotTick({ tickId: 2000, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(recovered.claimed).toBe(true);
    expect(recovered.outcome).toBe('SUCCESS');
    hb = await heartbeatRow(world.worldId);
    expect(hb.last_outcome).toBe('SUCCESS');
    expect(hb.consecutive_failures).toBe(0);
    expect(Number(hb.last_success_tick_id)).toBe(2000);
    expect(hb.last_failure_at).not.toBeNull(); // the failure stays visible
  });

  test('a hung lock is cancelled by the server: the tick settles as TIMEOUT, leaves no running work or lock, and the next tick succeeds', async () => {
    const world = await provisionFreshWorld();
    await openBlocker('LOCK TABLE persistent_bot_ticks IN ACCESS EXCLUSIVE MODE');

    const started = Date.now();
    const failure = await persistentBots.runPersistentBotTick({ tickId: 3000, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS })
      .then(() => null, (err) => err);
    const elapsed = Date.now() - started;
    expect(failure).not.toBeNull();
    expect(failure.outcome).toBe('TIMEOUT');
    expect(elapsed).toBeLessThan(FAST_LIMITS.statementTimeoutMs + 5000);

    // The cancelled statement is not still running in the background and
    // the run lock is not leaked.
    const { rows: running } = await db.query(
      `SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid()
          AND state = 'active' AND query ILIKE '%persistent_bot_ticks%'`
    );
    expect(running[0].n).toBe(0);
    const { rows: advisory } = await db.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = $1",
      [persistentBots.PERSISTENT_BOT_RUN_LOCK_KEY]
    );
    expect(advisory[0].n).toBe(0);
    const hb = await heartbeatRow(world.worldId);
    expect(hb.last_outcome).toBe('TIMEOUT');
    expect(hb.last_success_at).toBeNull();

    await releaseBlockers();
    const next = await persistentBots.runPersistentBotTick({ tickId: 3001, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(next.outcome).toBe('SUCCESS');
    expect((await heartbeatRow(world.worldId)).consecutive_failures).toBe(0);
  });

  // Review R1 replaced the former "that bot is skipped, the tick still
  // completes (SUCCESS)" expectation: a server-cancelled lock wait is an
  // infrastructure failure, not a domain skip. The remaining bots still
  // run, the claim stays, but the tick is NOT successful.
  test('a stuck coin row lock bounds the bot trade: that bot FAILS (timeout), the others still run, the tick is not successful', async () => {
    const world = await provisionFreshWorld();
    const ray = await rosterBot('reckless-ray');
    await seedDustEverywhere(ray);
    await openBlocker('SELECT coin_id FROM coins WHERE coin_id IN (3, 9) FOR UPDATE');
    const tickId = nonContrarianRayTick(4000);

    const started = Date.now();
    const failure = await persistentBots.runPersistentBotTick({ tickId, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS })
      .then(() => null, (err) => err);
    expect(Date.now() - started).toBeLessThan(15000);
    expect(failure).not.toBeNull();
    expect(failure.outcome).toBe('TIMEOUT');
    expect(failure.claimed).toBe(true);
    expect(failure.message).toMatch(/1 of 4 bots failed \(buy:timeout\)/);
    const rayAction = failure.actions.find((a) => a.botKey === 'reckless-ray');
    expect(rayAction.action).toBe('ERROR');
    expect(rayAction.reason).toMatch(/^buy-failed \(timeout\): .*lock timeout/);
    expect(failure.actions).toHaveLength(BOT_ROSTER.length); // every bot was still processed
    expect(failure.summary.errors).toBe(1);

    const hb = await heartbeatRow(world.worldId);
    expect(hb.last_outcome).toBe('TIMEOUT');
    expect(hb.last_success_at).toBeNull();
    expect(Number(hb.last_claimed_tick_id)).toBe(tickId);
    expect(hb.consecutive_failures).toBe(1);

    await releaseBlockers();
    const next = await persistentBots.runPersistentBotTick({ tickId: tickId + 1, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(next.outcome).toBe('SUCCESS');
    expect((await heartbeatRow(world.worldId)).consecutive_failures).toBe(0);
  });

  // Review R1: a tick whose every decision throws is a FAILED tick — it
  // must not refresh last_success_*, clear the failure counter, or report
  // SUCCESS; the next healthy tick recovers.
  test('all decisions failing is ERROR (never SUCCESS): success fields untouched, failures counted, then recovery', async () => {
    const world = await provisionFreshWorld();
    const healthy = await persistentBots.runPersistentBotTick({ tickId: 7000, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(healthy.outcome).toBe('SUCCESS');
    const before = await heartbeatRow(world.worldId);

    const original = persistentEconomy.getPersistentAccountState;
    const spy = jest.spyOn(persistentEconomy, 'getPersistentAccountState')
      .mockImplementation(async (args) => ({ ...(await original(args)), cash: NaN }));
    for (const tickId of [7001, 7002]) {
      const failure = await persistentBots.runPersistentBotTick({ tickId, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS })
        .then(() => null, (err) => err);
      expect(failure).not.toBeNull();
      expect(failure.outcome).toBe('ERROR');
      expect(failure.claimed).toBe(true);
      expect(failure.summary).toEqual(expect.objectContaining({ trades: 0, holds: 0, skips: 0, errors: BOT_ROSTER.length }));
      expect(failure.actions.every((a) => a.action === 'ERROR' && /^decision-failed \(error\): /.test(a.reason))).toBe(true);
    }
    spy.mockRestore();

    let hb = await heartbeatRow(world.worldId);
    expect(hb.last_outcome).toBe('ERROR');
    expect(Number(hb.last_success_tick_id)).toBe(7000);
    expect(hb.last_success_at.toISOString()).toBe(before.last_success_at.toISOString());
    expect(hb.consecutive_failures).toBe(2);
    expect(Number(hb.last_claimed_tick_id)).toBe(7002);
    const bots = (await request(app).get('/api/persistent/runtime').expect(200)).body.data.bots;
    expect(bots.lastOutcome).toBe('ERROR');
    expect(bots.consecutiveFailures).toBe(2);
    expect(JSON.stringify(bots)).not.toMatch(/NaN|decision|cash/i);

    const recovered = await persistentBots.runPersistentBotTick({ tickId: 7003, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(recovered.outcome).toBe('SUCCESS');
    hb = await heartbeatRow(world.worldId);
    expect(Number(hb.last_success_tick_id)).toBe(7003);
    expect(hb.consecutive_failures).toBe(0);
  });

  // Review R1: every trade service failing with an infrastructure error
  // (simulated backend connection loss) is ERROR, never a "rejection".
  test('all trade services failing with an infrastructure error is ERROR (never SUCCESS), then recovery', async () => {
    const world = await provisionFreshWorld();
    const lost = async () => {
      const err = new Error('synthetic backend connection loss');
      err.code = '08006';
      throw err;
    };
    const spies = [
      jest.spyOn(persistentEconomy, 'buyPersistentTrade').mockImplementation(lost),
      jest.spyOn(persistentEconomy, 'sellPersistentTrade').mockImplementation(lost),
      jest.spyOn(persistentDebt, 'issueBotLoan').mockImplementation(lost)
    ];
    const failure = await persistentBots.runPersistentBotTick({ tickId: 7100, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS })
      .then(() => null, (err) => err);
    const attempted = spies.reduce((n, s) => n + s.mock.calls.length, 0);
    spies.forEach((s) => s.mockRestore());
    expect(attempted).toBeGreaterThan(0);
    expect(failure).not.toBeNull();
    expect(failure.outcome).toBe('ERROR');
    expect(failure.summary.errors).toBe(attempted);
    expect(failure.summary.trades).toBe(0);
    expect(failure.actions.filter((a) => a.action === 'ERROR').every((a) => /-failed \(error\): synthetic backend connection loss$/.test(a.reason))).toBe(true);
    let hb = await heartbeatRow(world.worldId);
    expect(hb.last_outcome).toBe('ERROR');
    expect(hb.last_success_at).toBeNull();
    expect(hb.last_success_tick_id).toBeNull();
    expect(hb.last_action_at).toBeNull();
    expect(hb.consecutive_failures).toBe(1);

    const recovered = await persistentBots.runPersistentBotTick({ tickId: 7101, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(recovered.outcome).toBe('SUCCESS');
    hb = await heartbeatRow(world.worldId);
    expect(Number(hb.last_success_tick_id)).toBe(7101);
    expect(hb.consecutive_failures).toBe(0);
  });

  test('expected domain rejections stay skips: classification of service errors', () => {
    expect(persistentBots.isExpectedDomainRejection(new persistentEconomy.PersistentEconomyError('Insufficient funds.', 400))).toBe(true);
    expect(persistentBots.isExpectedDomainRejection(new persistentDebt.PersistentDebtError('Not bankrupt.', 409))).toBe(true);
    expect(persistentBots.isExpectedDomainRejection(new persistentDebt.PersistentDebtError('guarded update failed', 500))).toBe(false);
    const lockTimeout = new Error('canceling statement due to lock timeout');
    lockTimeout.code = '55P03';
    expect(persistentBots.isExpectedDomainRejection(lockTimeout)).toBe(false);
    expect(persistentBots.isExpectedDomainRejection(new TypeError('x is undefined'))).toBe(false);
  });

  // Review R5: an action that COMMITTED stays visible in last_action_at even
  // when a later deadline aborts the tick (which is still not a success).
  test('a committed loan followed by a tick TIMEOUT is still recorded in lastActionAt (tick not successful)', async () => {
    const world = await provisionFreshWorld();
    const roster = await ensureBotsProvisioned({ queryable: db });
    const first = roster[0];
    // Make the FIRST roster bot bankrupt so its decision is a LOAN.
    await persistentEconomy.provisionPersistentAccount({ userId: first.userId });
    await db.query('UPDATE persistent_accounts SET cash = 0 WHERE user_id = $1', [first.userId]);
    let calls = 0;
    // start, snapshot, claim, bot 1 -> in budget; bot 2 check -> over.
    const clock = () => { calls += 1; return calls >= 5 ? T_MS + 10 * 60 * 1000 : T_MS; };
    const failure = await persistentBots.runPersistentBotTick({ tickId: 7200, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS, clock })
      .then(() => null, (err) => err);
    expect(failure.outcome).toBe('TIMEOUT');
    expect(failure.claimed).toBe(true);
    const { rows: loans } = await db.query('SELECT type, amount FROM persistent_loans WHERE user_id = $1', [first.userId]);
    expect(loans.length).toBe(1);
    const hb = await heartbeatRow(world.worldId);
    expect(hb.last_action_at).not.toBeNull();
    expect(hb.last_success_at).toBeNull();
    expect(hb.last_outcome).toBe('TIMEOUT');
    const bots = (await request(app).get('/api/persistent/runtime').expect(200)).body.data.bots;
    expect(bots.lastActionAt).toBe(hb.last_action_at.toISOString());
    expect(bots.lastSuccessfulTickAt).toBeNull();
    expect(bots.stale).toBe(true);
  });

  test('cooperative deadline: a tick that runs out of budget mid-roster is TIMEOUT (claimed, never successful)', async () => {
    const world = await provisionFreshWorld();
    let calls = 0;
    // start, snapshot check, claim check, bot 1 check -> in budget; bot 2 check -> over.
    const clock = () => { calls += 1; return calls >= 5 ? T_MS + 10 * 60 * 1000 : T_MS; };
    const failure = await persistentBots.runPersistentBotTick({ tickId: 5000, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS, clock })
      .then(() => null, (err) => err);
    expect(failure.outcome).toBe('TIMEOUT');
    expect(failure.claimed).toBe(true);
    expect(failure.message).toMatch(/deadline/);
    const hb = await heartbeatRow(world.worldId);
    expect(Number(hb.last_claimed_tick_id)).toBe(5000);
    expect(hb.last_success_at).toBeNull();
    expect(hb.last_outcome).toBe('TIMEOUT');

    // Public runtime: the claim is visible but is NOT a success, so stale.
    const res = await request(app).get('/api/persistent/runtime').expect(200);
    expect(res.body.data.bots.lastClaimedTickAt).not.toBeNull();
    expect(res.body.data.bots.lastSuccessfulTickAt).toBeNull();
    expect(res.body.data.bots.stale).toBe(true);
    expect(res.body.data.bots.lastOutcome).toBe('TIMEOUT');

    const next = await persistentBots.runPersistentBotTick({ tickId: 5001, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(next.outcome).toBe('SUCCESS');
  });

  test('cross-process single writer: while another session holds the run lock the tick is BUSY and touches nothing', async () => {
    const world = await provisionFreshWorld();
    await openBlocker(`SELECT pg_advisory_lock(${persistentBots.PERSISTENT_BOT_RUN_LOCK_KEY})`);
    const busy = await persistentBots.runPersistentBotTick({ tickId: 6000, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(busy).toEqual({ tickId: 6000, claimed: false, outcome: 'BUSY', actions: [] });
    expect(await claimCount()).toBe(0);
    expect(await heartbeatRow(world.worldId)).toBeNull();

    await releaseBlockers();
    const ran = await persistentBots.runPersistentBotTick({ tickId: 6000, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(ran.outcome).toBe('SUCCESS');
    // Back-to-back ticks are never BUSY against their own released lock.
    const again = await persistentBots.runPersistentBotTick({ tickId: 6001, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(again.outcome).toBe('SUCCESS');
    const replay = await persistentBots.runPersistentBotTick({ tickId: 6001, nowMs: T_MS, logger: silentLogger(), limits: FAST_LIMITS });
    expect(replay).toEqual({ tickId: 6001, claimed: false, outcome: 'ALREADY_CLAIMED', actions: [] });
  });
});

describe('issue #56: public heartbeat on GET /api/persistent/runtime', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
    marketSimulator.stop();
  });

  afterEach(() => {
    marketSimulator.stop();
    jest.restoreAllMocks();
  });

  test('no heartbeat yet: allowlisted nulls and stale=true; after a success: fresh; > 3 intervals later: stale', async () => {
    await persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(Date.now() - 120000) });
    await marketSimulator.updateAllPrices({ nowMs: Date.now() - 30000 });
    await marketSimulator.updateAllPrices({ nowMs: Date.now() });
    const world = await persistentWorld.resolveActiveWorld(db);

    let bots = (await request(app).get('/api/persistent/runtime').expect(200)).body.data.bots;
    expect(bots).toEqual({
      tickIntervalMs: 60000,
      staleAfterMs: 180000,
      stale: true,
      lastAttemptAt: null,
      lastClaimedTickAt: null,
      lastSuccessfulTickAt: null,
      lastActionAt: null,
      lastFailureAt: null,
      lastOutcome: null,
      consecutiveFailures: 0,
      lastTickSummary: null
    });

    const tickId = Math.floor(Date.now() / 60000);
    const result = await persistentBots.runPersistentBotTick({ tickId, nowMs: Date.now(), logger: silentLogger() });
    expect(result.outcome).toBe('SUCCESS');
    const res = await request(app).get('/api/persistent/runtime').expect(200);
    bots = res.body.data.bots;
    expect(bots.stale).toBe(false);
    expect(bots.lastOutcome).toBe('SUCCESS');
    expect(bots.lastSuccessfulTickAt).not.toBeNull();
    expect(bots.lastClaimedTickAt).not.toBeNull();
    expect(bots.lastTickSummary).toEqual({
      trades: result.summary.trades,
      holds: result.summary.holds,
      skips: result.summary.skips
    });
    // Allowlist: no seeds, raw errors, strategy/config internals.
    const text = JSON.stringify(bots);
    for (const forbidden of ['seed', 'strategy', 'reason', 'botKey', 'userId', 'stake', 'message', 'error']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }

    // Age the durable success by four intervals: stale is derived from the
    // database clock against staleAfterMs (3 intervals).
    await db.query(
      `UPDATE persistent_bot_heartbeat SET last_success_at = now() - interval '4 minutes' WHERE world_id = $1`,
      [world.worldId]
    );
    bots = (await request(app).get('/api/persistent/runtime').expect(200)).body.data.bots;
    expect(bots.stale).toBe(true);
    await db.query(
      `UPDATE persistent_bot_heartbeat SET last_success_at = now() - interval '2 minutes' WHERE world_id = $1`,
      [world.worldId]
    );
    bots = (await request(app).get('/api/persistent/runtime').expect(200)).body.data.bots;
    expect(bots.stale).toBe(false);
  });

  test('the model refuses a success that was never claimed, and an unknown failure outcome', async () => {
    await persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(Date.now() - 60000) });
    const world = await persistentWorld.resolveActiveWorld(db);
    await heartbeatModel.recordAttempt(db, world.worldId);
    await expect(heartbeatModel.recordSuccess(db, world.worldId, 7, { trades: 0, holds: 0, skips: 0 }))
      .rejects.toThrow(/cannot succeed before it is claimed/);
    await expect(heartbeatModel.recordFailure(db, world.worldId, 'Error: connect ECONNREFUSED 10.0.0.1'))
      .rejects.toThrow(/failure outcome must be one of/);
    await expect(db.query(
      `UPDATE persistent_bot_heartbeat SET last_outcome = 'raw error text' WHERE world_id = $1`, [world.worldId]
    )).rejects.toThrow(/persistent_bot_heartbeat_outcome_known/);
  });

  // Review R4 (defence in depth): even on an incompatible schema whose
  // outcome CHECK was weakened, the public projection never publishes an
  // out-of-vocabulary stored outcome verbatim.
  test('an out-of-vocabulary stored outcome is published as ERROR, never as its raw text', async () => {
    await persistentWorld.provisionWorld(db, { seed: WORLD_SEED, epochStartedAt: new Date(Date.now() - 60000) });
    await marketSimulator.updateAllPrices({ nowMs: Date.now() });
    const world = await persistentWorld.resolveActiveWorld(db);
    await heartbeatModel.recordAttempt(db, world.worldId);
    await db.query('ALTER TABLE persistent_bot_heartbeat DROP CONSTRAINT persistent_bot_heartbeat_outcome_known');
    await db.query(`UPDATE persistent_bot_heartbeat SET last_outcome = 'RAW_ERROR' WHERE world_id = $1`, [world.worldId]);
    const loaded = await heartbeatModel.loadHeartbeat(db, world.worldId);
    expect(loaded.lastOutcome).toBe('ERROR');
    const bots = (await request(app).get('/api/persistent/runtime').expect(200)).body.data.bots;
    expect(bots.lastOutcome).toBe('ERROR');
    expect(JSON.stringify(bots)).not.toContain('RAW_ERROR');
  });
});

describe('issue #56: worker lifecycle (no overlap, settle-only clearing, safe summary logs)', () => {
  afterEach(() => {
    persistentBotWorker.stop();
    jest.restoreAllMocks();
  });

  test('the in-flight guard clears only when the tick settles; overlapping wakeups never start a second tick', async () => {
    let resolveTick;
    const tick = jest.fn(() => new Promise((resolve) => { resolveTick = resolve; }));
    const info = jest.spyOn(logger, 'info').mockImplementation(() => {});
    const first = persistentBotWorker.runTick(new Date(T_MS), { tick });
    await new Promise((r) => setImmediate(r));
    expect(tick).toHaveBeenCalledTimes(1);
    const [args] = tick.mock.calls[0];
    expect(args.tickId).toBe(Math.floor(T_MS / 60000));
    expect(args.limits.statementTimeoutMs).toBeGreaterThan(0);
    expect(args.limits.deadlineMs).toBeLessThan(60000);

    const overlap = persistentBotWorker.runTick(new Date(T_MS + 60000), { tick });
    expect(overlap).toBe(first);
    await new Promise((r) => setTimeout(r, 50));
    expect(persistentBotWorker.inFlight).not.toBeNull(); // still running: never cleared early
    expect(tick).toHaveBeenCalledTimes(1);

    resolveTick({
      tickId: args.tickId, claimed: true, outcome: 'SUCCESS', durationMs: 12,
      actions: [], summary: { trades: 1, holds: 2, skips: 1, buys: 1, sells: 0, loans: 0, repays: 0 }
    });
    await first;
    expect(persistentBotWorker.inFlight).toBeNull();
    const lines = info.mock.calls.map((c) => c.join(' '));
    expect(lines).toContain(`[GAME] Persistent bot tick ${args.tickId} SUCCESS in 12ms: buy=1 sell=0 loan=0 repay=0 hold=2 skip=1`);
  });

  test('a failed tick is logged with its outcome and the worker stays usable', async () => {
    const error = jest.spyOn(logger, 'error').mockImplementation(() => {});
    const failing = jest.fn(async () => {
      const err = new Error('canceling statement due to lock timeout');
      err.outcome = 'TIMEOUT';
      err.claimed = true;
      throw err;
    });
    await persistentBotWorker.runTick(new Date(T_MS), { tick: failing });
    expect(persistentBotWorker.inFlight).toBeNull();
    expect(error.mock.calls.map((c) => c.join(' ')).some((l) => /tick \d+ TIMEOUT \(claimed, not successful\)/.test(l))).toBe(true);
    const ok = jest.fn(async () => ({ tickId: 1, claimed: false, outcome: 'BUSY', actions: [] }));
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    await persistentBotWorker.runTick(new Date(T_MS), { tick: ok });
    expect(ok).toHaveBeenCalledTimes(1);
  });

  test('the roster size is what the heartbeat summary counts against', () => {
    expect(BOT_ROSTER.length).toBe(4);
  });
});
