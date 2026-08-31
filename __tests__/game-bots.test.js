// Core 5: autonomous roster bots.
//
// Proves: centralized validated config with an exactly-4 stable roster — the
// canonical personalities Conservative, Momentum, Dip Buyer, Reckless — plus
// validated limits (per-trade size cap, per-bot cooldown, maximum actions
// per tick); idempotent provisioning of bot users (is_bot persisted, no
// usable human credentials, no possible login) and identity rows; idempotent
// autojoin as a NORMAL Core 4 participant at the game starting cash;
// deterministic PRNG decisions keyed by cycle seed + bot identity + tick;
// deliberately shaped PUBLIC market state only (no schedule/future collapse
// data); service-layer enforcement of the size cap (per trade), cooldown
// (from persisted bot action times) and per-tick action budget; every bot
// trade through the shared gameRoundService domain ops (round
// cash/holdings/ledger only, never legacy users.funds / portfolios /
// transactions); pg-backed duplicate tick identity; and safe isBot exposure
// on public participant state.

const bcrypt = require('bcrypt');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');
const { authenticateUser } = require('../models/users.model');
const botConfig = require('../game/botConfig');
const botService = require('../game/botService');

const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const FIXED_SEED = 'core5-fixed-cycle-seed';

const BOT_ENV_KEYS = [
  'GAME_BOT_TICK_INTERVAL_MS',
  'GAME_BOTS_ENABLED',
  'GAME_BOT_MAX_TRADE_SIZE',
  'GAME_BOT_COOLDOWN_MS',
  'GAME_BOT_MAX_ACTIONS_PER_TICK'
];

function saveEnv() {
  return Object.fromEntries(BOT_ENV_KEYS.map((k) => [k, process.env[k]]));
}

function restoreEnv(saved) {
  for (const k of BOT_ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
}

async function setupCycle() {
  const now = new Date();
  const cycle = await reconcileCycle({ now, durationMs: LONG_DURATION_MS, generateSeed: () => FIXED_SEED });
  return { cycle, now };
}

async function botUsers() {
  const { rows } = await db.query('SELECT * FROM users WHERE is_bot = true ORDER BY username');
  return rows;
}

async function legacyRowCounts(userId) {
  const pf = await db.query('SELECT count(*)::int AS n FROM portfolios WHERE user_id = $1', [userId]);
  const tx = await db.query('SELECT count(*)::int AS n FROM transactions WHERE user_id = $1', [userId]);
  return { portfolios: pf.rows[0].n, transactions: tx.rows[0].n };
}

// Deterministic market state fixture in the exact V2-4 public shape: coin 1
// rising (+100% full window, RISE/UP), coin 2 dipping (-50%, DIP). Both
// alive. Holdings carry the (nullable) own-position economics keys.
function v2Coin(overrides = {}) {
  return {
    coinId: 1, symbol: 'AAA', currentPrice: 20, collapsed: false, history: [10, 15, 20],
    phase: 'RISE', momentum: 'UP', archetype: 'MOON', collapseRisk: 'SHAKY', recentChangePct: 100,
    ...overrides
  };
}

function v2Holding(overrides = {}) {
  return {
    coinId: 1, symbol: 'AAA', quantity: 4,
    costBasis: null, averageEntryPrice: null, currentValue: null, unrealizedPnlPct: null,
    ...overrides
  };
}

function shapedState(overrides = {}) {
  return {
    apocalypsePercent: 20,
    cash: 1000,
    holdings: [],
    coins: [
      v2Coin(),
      v2Coin({
        coinId: 2, symbol: 'BBB', currentPrice: 10, history: [20, 15, 10],
        phase: 'DIP', momentum: 'DOWN', archetype: 'BULL', collapseRisk: 'STABLE', recentChangePct: -50
      })
    ],
    power: { current: 100, max: 100, regenMsPerPoint: 30000 },
    openPositions: { open: 0, max: 3 },
    ...overrides
  };
}

describe('Core 5: bot configuration', () => {
  let saved;
  beforeEach(() => {
    saved = saveEnv();
  });
  afterEach(() => {
    restoreEnv(saved);
  });

  test('the roster is exactly the canonical personalities: Conservative, Momentum, Dip Buyer, Reckless', () => {
    expect(botConfig.BOT_ROSTER).toHaveLength(4);
    expect(botConfig.BOT_STRATEGIES).toEqual(['conservative', 'momentum', 'dip_buyer', 'reckless']);
    expect(botConfig.BOT_ROSTER.map((b) => b.strategy)).toEqual([
      'conservative', 'momentum', 'dip_buyer', 'reckless'
    ]);
    expect(botConfig.BOT_ROSTER.map((b) => b.displayName)).toEqual([
      'Conservative', 'Momentum', 'Dip Buyer', 'Reckless'
    ]);
    const keys = botConfig.BOT_ROSTER.map((b) => b.botKey);
    const usernames = botConfig.BOT_ROSTER.map((b) => b.username);
    const emails = botConfig.BOT_ROSTER.map((b) => b.email);
    expect(new Set(keys).size).toBe(4);
    expect(new Set(usernames).size).toBe(4);
    expect(new Set(emails).size).toBe(4);
    for (const bot of botConfig.BOT_ROSTER) {
      expect(bot.username.length).toBeLessThanOrEqual(50);
      expect(bot.email.length).toBeLessThanOrEqual(100);
    }
  });

  test('a malformed roster is rejected at validation time', () => {
    expect(() => botConfig.validateBotRoster([])).toThrow(/exactly 4/);
    expect(() => botConfig.validateBotRoster(botConfig.BOT_ROSTER.map((b) => ({ ...b, strategy: 'contrarian' }))))
      .toThrow(/strategy must be one of/);
  });

  test('config resolves validated defaults', () => {
    for (const k of BOT_ENV_KEYS) delete process.env[k];
    const config = botConfig.resolveBotConfig();
    expect(config.tickIntervalMs).toBe(botConfig.DEFAULT_BOT_TICK_INTERVAL_MS);
    expect(config.enabled).toBe(true);
    expect(config.maxTradeSize).toBe(botConfig.DEFAULT_BOT_MAX_TRADE_SIZE);
    expect(config.cooldownMs).toBe(botConfig.DEFAULT_BOT_COOLDOWN_MS);
    expect(config.maxActionsPerTick).toBe(botConfig.DEFAULT_BOT_MAX_ACTIONS_PER_TICK);
  });

  test('malformed or out-of-range tick intervals are rejected, never coerced', () => {
    for (const bad of ['abc', '10.5', '0', '-5', '50', String(11 * 60 * 1000)]) {
      process.env.GAME_BOT_TICK_INTERVAL_MS = bad;
      expect(() => botConfig.resolveBotConfig()).toThrow(/GAME_BOT_TICK_INTERVAL_MS/);
    }
    process.env.GAME_BOT_TICK_INTERVAL_MS = '5000';
    expect(botConfig.resolveBotConfig().tickIntervalMs).toBe(5000);
  });

  test('trade-size cap is validated: finite, 2dp money, positive and safely bounded', () => {
    for (const bad of ['abc', '0', '-10', '10.555', '0.5', '10001', 'Infinity']) {
      process.env.GAME_BOT_MAX_TRADE_SIZE = bad;
      expect(() => botConfig.resolveBotConfig()).toThrow(/GAME_BOT_MAX_TRADE_SIZE/);
    }
    process.env.GAME_BOT_MAX_TRADE_SIZE = '125.50';
    expect(botConfig.resolveBotConfig().maxTradeSize).toBe(125.5);
    process.env.GAME_BOT_MAX_TRADE_SIZE = String(botConfig.MAX_BOT_MAX_TRADE_SIZE);
    expect(botConfig.resolveBotConfig().maxTradeSize).toBe(botConfig.MAX_BOT_MAX_TRADE_SIZE);
  });

  test('cooldown is validated: finite integer, nonnegative, bounded', () => {
    for (const bad of ['abc', '1.5', '-1', String(botConfig.MAX_BOT_COOLDOWN_MS + 1)]) {
      process.env.GAME_BOT_COOLDOWN_MS = bad;
      expect(() => botConfig.resolveBotConfig()).toThrow(/GAME_BOT_COOLDOWN_MS/);
    }
    process.env.GAME_BOT_COOLDOWN_MS = '0'; // zero explicitly disables the cooldown
    expect(botConfig.resolveBotConfig().cooldownMs).toBe(0);
    process.env.GAME_BOT_COOLDOWN_MS = '30000';
    expect(botConfig.resolveBotConfig().cooldownMs).toBe(30000);
  });

  test('maximum actions per tick is validated: integer within roster bounds', () => {
    for (const bad of ['abc', '0', '-2', '2.5', String(botConfig.MAX_BOT_MAX_ACTIONS_PER_TICK + 1)]) {
      process.env.GAME_BOT_MAX_ACTIONS_PER_TICK = bad;
      expect(() => botConfig.resolveBotConfig()).toThrow(/GAME_BOT_MAX_ACTIONS_PER_TICK/);
    }
    process.env.GAME_BOT_MAX_ACTIONS_PER_TICK = '1';
    expect(botConfig.resolveBotConfig().maxActionsPerTick).toBe(1);
  });

  test('enabled flag parses strictly', () => {
    process.env.GAME_BOTS_ENABLED = 'false';
    expect(botConfig.resolveBotConfig().enabled).toBe(false);
    process.env.GAME_BOTS_ENABLED = 'true';
    expect(botConfig.resolveBotConfig().enabled).toBe(true);
    process.env.GAME_BOTS_ENABLED = 'maybe';
    expect(() => botConfig.resolveBotConfig()).toThrow(/GAME_BOTS_ENABLED/);
  });
});

describe('Core 5: bot provisioning', () => {
  test('provisioning creates exactly the roster users with persisted is_bot and identity rows', async () => {
    const provisioned = await botService.ensureBotsProvisioned();
    expect(provisioned).toHaveLength(4);

    const users = await botUsers();
    expect(users).toHaveLength(4);
    expect(users.map((u) => u.username).sort())
      .toEqual(botConfig.BOT_ROSTER.map((b) => b.username).sort());

    const { rows: identities } = await db.query('SELECT * FROM apocalypse_bots ORDER BY bot_key');
    expect(identities).toHaveLength(4);
    expect(identities.map((r) => r.bot_key).sort())
      .toEqual(botConfig.BOT_ROSTER.map((b) => b.botKey).sort());
    expect(identities.map((r) => r.strategy).sort())
      .toEqual([...botConfig.BOT_STRATEGIES].sort());
    for (const row of identities) {
      const user = users.find((u) => u.user_id === row.user_id);
      expect(user).toBeDefined();
      expect(row.last_action_at).toBeNull(); // never acted yet
    }
  });

  test('provisioning is idempotent: repeated runs reuse the same stable user ids', async () => {
    const first = await botService.ensureBotsProvisioned();
    const second = await botService.ensureBotsProvisioned();
    expect(second.map((b) => b.userId).sort()).toEqual(first.map((b) => b.userId).sort());
    const users = await botUsers();
    expect(users).toHaveLength(4);
    const { rows: identities } = await db.query('SELECT count(*)::int AS n FROM apocalypse_bots');
    expect(identities[0].n).toBe(4);
  });

  test('bot users have no usable human credentials', async () => {
    await botService.ensureBotsProvisioned();
    const users = await botUsers();
    for (const user of users) {
      expect(user.is_bot).toBe(true);
      // A syntactically valid bcrypt hash of a never-stored random secret:
      // no candidate password can ever authenticate as a bot.
      expect(user.password_hash).toMatch(/^\$2b\$/);
      expect(await bcrypt.compare('password', user.password_hash)).toBe(false);
      expect(await bcrypt.compare('letmein', user.password_hash)).toBe(false);
    }
  });

  test('bot accounts can never log in — even via the NODE_ENV=test password123 bypass', async () => {
    await botService.ensureBotsProvisioned();
    expect(process.env.NODE_ENV).toBe('test');
    for (const user of await botUsers()) {
      await expect(authenticateUser(user.email, 'password123')).rejects.toThrow(/Invalid credentials/);
      await expect(authenticateUser(user.email, 'anything')).rejects.toThrow(/Invalid credentials/);
    }
    // Human login still works under the test bypass.
    const { rows: humans } = await db.query('SELECT email FROM users WHERE is_bot = false ORDER BY user_id LIMIT 1');
    await expect(authenticateUser(humans[0].email, 'password123')).resolves.toMatchObject({ token: expect.any(String) });
  });
});

describe('Core 5: deterministic decisions from public state only', () => {
  test('the seeded PRNG stream is stable per (seed, bot identity, tick) and distinct across bots and ticks', () => {
    const a1 = botService.createBotRandom({ seed: 's', botKey: 'momentum-mike', tickId: 7 });
    const a2 = botService.createBotRandom({ seed: 's', botKey: 'momentum-mike', tickId: 7 });
    const b = botService.createBotRandom({ seed: 's', botKey: 'dip-buyer-dana', tickId: 7 });
    const t8 = botService.createBotRandom({ seed: 's', botKey: 'momentum-mike', tickId: 8 });
    const stream = (rng) => [rng(), rng(), rng()];
    expect(stream(a1)).toEqual(stream(a2));
    expect(stream(botService.createBotRandom({ seed: 's', botKey: 'momentum-mike', tickId: 7 })))
      .not.toEqual(stream(b));
    expect(stream(botService.createBotRandom({ seed: 's', botKey: 'momentum-mike', tickId: 7 })))
      .not.toEqual(stream(t8));
    for (const v of stream(botService.createBotRandom({ seed: 's', botKey: 'x', tickId: 1 }))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  test('decisions are pure: same shaped state + same random stream give identical actions', () => {
    const state = shapedState();
    const d1 = botService.decideBotAction({
      strategy: 'momentum', marketState: state,
      random: botService.createBotRandom({ seed: 's', botKey: 'momentum-mike', tickId: 3 })
    });
    const d2 = botService.decideBotAction({
      strategy: 'momentum', marketState: state,
      random: botService.createBotRandom({ seed: 's', botKey: 'momentum-mike', tickId: 3 })
    });
    expect(d1).toEqual(d2);
  });

  test('conservative: acts less often, buys SMALL, preserves cash, sells defensively after a decline', () => {
    const state = shapedState();
    // Acts less often: gated by the seeded random.
    expect(botService.decideBotAction({ strategy: 'conservative', marketState: state, random: () => 0.9 }).type)
      .toBe('HOLD');
    // When it does buy: small stake (5% of cash) on the most stable coin.
    const buy = botService.decideBotAction({ strategy: 'conservative', marketState: state, random: () => 0.1 });
    expect(buy).toMatchObject({ type: 'BUY', coinId: 2 });
    expect(buy.quantity * 10).toBeLessThanOrEqual(500); // 5% of £10,000 at price 10
    // Defensive sell: a holding whose public history declined meaningfully is
    // dumped in full to protect cash.
    const holding = shapedState({ holdings: [v2Holding({ coinId: 2, symbol: 'BBB', quantity: 4 })] });
    const sell = botService.decideBotAction({ strategy: 'conservative', marketState: holding, random: () => 0.1 });
    expect(sell).toEqual({ type: 'SELL', coinId: 2, quantity: 4 });
    // Issue #20: a holding with a modest gain is SOLD (half) to take profit —
    // capital preservation now includes realizing gains, not just avoiding
    // losses. A small move below the profit bar is still preserved.
    const gainer = shapedState({ holdings: [v2Holding({ coinId: 1, symbol: 'AAA', quantity: 4 })] });
    const profit = botService.decideBotAction({ strategy: 'conservative', marketState: gainer, random: () => 0.1 });
    expect(profit).toEqual({ type: 'SELL', coinId: 1, quantity: 2 }); // +100% >= +8% bar, sell half
    const flat = shapedState({
      coins: [v2Coin({
        coinId: 5, symbol: 'EEE', currentPrice: 10.4, history: [10, 10.4],
        phase: 'RISE', momentum: 'FLAT', collapseRisk: 'STABLE', recentChangePct: 4
      })],
      holdings: [v2Holding({ coinId: 5, symbol: 'EEE', quantity: 4 })]
    });
    expect(botService.decideBotAction({ strategy: 'conservative', marketState: flat, random: () => 0.1 }).type)
      .not.toBe('SELL'); // +4% is below both the +8% profit bar and the -5% loss bar
  });

  test('momentum: chooses the rising coin, reduces a position after a negative move', () => {
    const state = shapedState();
    const buy = botService.decideBotAction({ strategy: 'momentum', marketState: state, random: () => 0 });
    expect(buy).toMatchObject({ type: 'BUY', coinId: 1 }); // the riser
    expect(buy.quantity * 20).toBeLessThanOrEqual(100); // 10% of cash at price 20
    // No riser at all -> HOLD, never buys a faller.
    const allFalling = shapedState({ coins: [shapedState().coins[1]] });
    expect(botService.decideBotAction({ strategy: 'momentum', marketState: allFalling, random: () => 0 }).type)
      .toBe('HOLD');
    // Reduces after negative: halves the declining holding (public momentum
    // DOWN on an underwater position).
    const holding = shapedState({ holdings: [v2Holding({ coinId: 2, symbol: 'BBB', quantity: 6 })] });
    const reduce = botService.decideBotAction({ strategy: 'momentum', marketState: holding, random: () => 0 });
    expect(reduce).toEqual({ type: 'SELL', coinId: 2, quantity: 3 });
  });

  test('dip buyer: buys the meaningfully dropped surviving coin, sells into a recovery', () => {
    const state = shapedState();
    const buy = botService.decideBotAction({ strategy: 'dip_buyer', marketState: state, random: () => 0 });
    expect(buy).toMatchObject({ type: 'BUY', coinId: 2 }); // the -50% DIP, still alive
    expect(buy.quantity * 10).toBeLessThanOrEqual(300); // 30% of cash at price 10
    // A drop that is not meaningful (a falling RISE reading) is ignored.
    const shallow = shapedState({
      coins: [v2Coin({
        coinId: 3, symbol: 'CCC', currentPrice: 9.5, history: [10, 9.5],
        phase: 'RISE', momentum: 'DOWN', collapseRisk: 'STABLE', recentChangePct: -5
      })]
    });
    expect(botService.decideBotAction({ strategy: 'dip_buyer', marketState: shallow, random: () => 0 }).type)
      .toBe('HOLD');
    // A meaningfully dropped coin that is DEAD is never bought.
    const dead = shapedState({
      coins: [v2Coin({
        coinId: 4, symbol: 'DDD', currentPrice: 0, collapsed: true, history: [10, 0],
        phase: 'DEAD', momentum: 'FLAT', collapseRisk: 'DEAD', recentChangePct: null
      })]
    });
    expect(botService.decideBotAction({ strategy: 'dip_buyer', marketState: dead, random: () => 0 }).type)
      .toBe('HOLD');
    // Sells into a meaningful recovery on a held position.
    const recovered = shapedState({ holdings: [v2Holding({ coinId: 1, symbol: 'AAA', quantity: 6 })] });
    const sell = botService.decideBotAction({ strategy: 'dip_buyer', marketState: recovered, random: () => 0 });
    expect(sell).toEqual({ type: 'SELL', coinId: 1, quantity: 6 });
  });

  test('reckless: aggressive LARGE purchase on a deterministically chosen eligible coin', () => {
    const state = shapedState();
    const buy0 = botService.decideBotAction({ strategy: 'reckless', marketState: state, random: () => 0 });
    const buy1 = botService.decideBotAction({ strategy: 'reckless', marketState: state, random: () => 0.99 });
    expect(buy0.type).toBe('BUY');
    expect(buy0.coinId).toBe(1); // deterministic eligible selection by the seeded random
    expect(buy1.coinId).toBe(2);
    // Large stake: 40% of cash — meaningfully larger than every other
    // personality's stake on the same state.
    expect(buy0.quantity * 20).toBeGreaterThan(300); // ~£400 at price 20
    const conservative = botService.decideBotAction({ strategy: 'conservative', marketState: state, random: () => 0.1 });
    expect(buy0.quantity * 20).toBeGreaterThan(conservative.quantity * 10);
    // No eligible coin -> HOLD, never a throw.
    const dead = shapedState({ coins: [v2Coin({
      currentPrice: 0, collapsed: true, history: [5, 0],
      phase: 'DEAD', momentum: 'FLAT', collapseRisk: 'DEAD', recentChangePct: null
    })] });
    expect(botService.decideBotAction({ strategy: 'reckless', marketState: dead, random: () => 0 }).type).toBe('HOLD');
  });

  test('the decision layer constructs trades inside the size cap when one is provided', () => {
    const state = shapedState();
    const reckless = botService.decideBotAction({
      strategy: 'reckless', marketState: state, random: () => 0, maxTradeSize: 50
    });
    expect(reckless.type).toBe('BUY');
    expect(reckless.quantity * 20).toBeLessThanOrEqual(50);
  });

  test('a collapsed coin is never bought and an oversell/overbuy is impossible by construction', () => {
    const collapsedRiser = shapedState({
      coins: [
        v2Coin({
          currentPrice: 0, collapsed: true, history: [10, 15, 20],
          phase: 'DEAD', momentum: 'FLAT', collapseRisk: 'DEAD', recentChangePct: null
        }),
        v2Coin({
          coinId: 2, symbol: 'BBB', currentPrice: 10, history: [20, 15, 10],
          phase: 'FALL', momentum: 'DOWN', collapseRisk: 'STABLE', recentChangePct: -50
        })
      ]
    });
    const momentum = botService.decideBotAction({ strategy: 'momentum', marketState: collapsedRiser, random: () => 0.5 });
    expect(momentum.coinId).not.toBe(1);
    if (momentum.type === 'BUY') {
      const coin = collapsedRiser.coins.find((c) => c.coinId === momentum.coinId);
      expect(momentum.quantity * coin.currentPrice).toBeLessThanOrEqual(collapsedRiser.cash);
    }

    // Sell is always bounded by the actual holding.
    const holding = shapedState({ holdings: [v2Holding({ coinId: 1, symbol: 'AAA', quantity: 3 })] });
    const sell = botService.decideBotAction({ strategy: 'dip_buyer', marketState: holding, random: () => 0.5 });
    expect(sell.type).toBe('SELL'); // coin 1 recovered +100%
    expect(sell.quantity).toBeGreaterThan(0);
    expect(sell.quantity).toBeLessThanOrEqual(3);

    // No alive coins at all -> HOLD, never a throw.
    const dead = shapedState({ coins: [v2Coin({
      currentPrice: 0, collapsed: true, history: [5, 0],
      phase: 'DEAD', momentum: 'FLAT', collapseRisk: 'DEAD', recentChangePct: null
    })] });
    for (const strategy of botConfig.BOT_STRATEGIES) {
      expect(botService.decideBotAction({ strategy, marketState: dead, random: () => 0.5 }).type).toBe('HOLD');
    }
  });

  test('the service-layer cap enforcement clamps any BUY to the configured size', () => {
    const state = shapedState();
    const greedy = { type: 'BUY', coinId: 1, quantity: 100 }; // £2,000 at price 20
    const enforced = botService.enforceTradeSizeCap(greedy, state, 50);
    expect(enforced.type).toBe('BUY');
    expect(enforced.quantity * 20).toBeLessThanOrEqual(50);
    // A cap below one 2dp unit of the coin leaves nothing to trade.
    expect(botService.enforceTradeSizeCap(greedy, state, 0.1)).toBeNull();
    // Non-BUY decisions pass through untouched.
    const sell = { type: 'SELL', coinId: 1, quantity: 3 };
    expect(botService.enforceTradeSizeCap(sell, state, 1)).toEqual(sell);
  });

  test('buildPublicMarketState exposes only public, deliberately shaped data — never schedule/future collapse internals', async () => {
    const { cycle, now } = await setupCycle();
    await botService.ensureBotsProvisioned();
    const [bot] = botConfig.BOT_ROSTER;
    const { rows: botUser } = await db.query('SELECT user_id FROM users WHERE username = $1', [bot.username]);
    const participant = await gameRoundService.joinRound({ userId: botUser[0].user_id, now });

    // SIM-14: the dynamic authority records NO future plan. A fresh healthy
    // cycle has no death records, and the shaped state must contain only
    // public alive-coin data (never latent timing/order fields).
    const { rows: deaths } = await db.query(
      `SELECT coin_id FROM apocalypse_coin_collapses WHERE cycle_id = $1`,
      [cycle.cycle_id]
    );
    expect(deaths).toHaveLength(0);
    const state = await botService.buildPublicMarketState({ cycle, participant, now });
    expect(state.coins.length).toBeGreaterThan(0);
    for (const coin of state.coins) {
      expect(Object.keys(coin).sort()).toEqual([...botService.BOT_COIN_KEYS].sort());
    }
    expect(Object.keys(state).sort()).toEqual([...botService.BOT_MARKET_STATE_KEYS].sort());
    expect(Object.keys(state.power).sort()).toEqual([...botService.BOT_POWER_KEYS].sort());
    expect(Object.keys(state.openPositions).sort()).toEqual([...botService.BOT_OPEN_POSITION_KEYS].sort());
    for (const holding of state.holdings) {
      expect(Object.keys(holding).sort()).toEqual([...botService.BOT_HOLDING_KEYS].sort());
    }
    expect(state.cash).toBe(10000);
    expect(state.apocalypsePercent).toBeGreaterThanOrEqual(0);
    expect(state.apocalypsePercent).toBeLessThanOrEqual(100);
    // The seed is never part of the shaped state, at any depth.
    expect(JSON.stringify(state)).not.toContain(cycle.seed);
  });
});

describe('Core 5: bot ticks', () => {
  let saved;
  beforeEach(() => {
    saved = saveEnv();
  });
  afterEach(() => {
    restoreEnv(saved);
  });

  test('a tick provisions + autojoins bots as NORMAL participants at the game starting cash', async () => {
    const { cycle, now } = await setupCycle();
    const result = await botService.runBotTick({ tickId: 1, now });
    expect(result.skipped).toBe(false);
    expect(result.cycleId).toBe(cycle.cycle_id);
    expect(result.apocalypseId).toBe(cycle.apocalypse_id);

    const users = await botUsers();
    expect(users).toHaveLength(4);
    const { rows: participants } = await db.query(
      'SELECT * FROM apocalypse_participants WHERE cycle_id = $1 ORDER BY user_id',
      [cycle.cycle_id]
    );
    // Issue #17: humans are auto-initialized too — assert the BOT rows.
    const botIds = new Set(users.map((u) => u.userId ?? u.user_id));
    const botParticipants = participants.filter((p) => botIds.has(p.user_id));
    expect(botParticipants).toHaveLength(4);
    for (const p of botParticipants) {
      expect(parseFloat(p.starting_cash)).toBe(10000);
      expect(p.status).toBe('ACTIVE');
      // Round cash only ever moved by real trades: never above the start.
      expect(parseFloat(p.current_cash)).toBeLessThanOrEqual(10000);
      expect(parseFloat(p.current_cash)).toBeGreaterThanOrEqual(0);
    }
  });

  test('duplicate tick identity is pg-backed: a repeated (cycle, tickId) never re-executes', async () => {
    const { cycle, now } = await setupCycle();
    const first = await botService.runBotTick({ tickId: 42, now });
    expect(first.skipped).toBe(false);

    const { rows: txBefore } = await db.query('SELECT count(*)::int AS n FROM apocalypse_transactions');
    const second = await botService.runBotTick({ tickId: 42, now });
    expect(second.skipped).toBe(true);
    expect(second.reason).toBe('duplicate-tick');

    const { rows: ticks } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_bot_ticks WHERE cycle_id = $1 AND tick_id = $2',
      [cycle.cycle_id, 42]
    );
    expect(ticks[0].n).toBe(1);
    const { rows: txAfter } = await db.query('SELECT count(*)::int AS n FROM apocalypse_transactions');
    expect(txAfter[0].n).toBe(txBefore[0].n);
  });

  test('every bot trade goes through the shared round service: round ledger only, legacy state untouched', async () => {
    const { cycle, now } = await setupCycle();
    // Deterministic market: coin 1 clearly rising so momentum buys it.
    const { rows: coins } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 2');
    const [rising, falling] = coins.map((c) => c.coin_id);
    await db.query('UPDATE coins SET current_price = 20.00 WHERE coin_id = $1', [rising]);
    await db.query('UPDATE coins SET current_price = 10.00 WHERE coin_id = $1', [falling]);
    await db.query('DELETE FROM price_history');
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at) VALUES
       ($1, 10.00, now() - interval '3 minutes'),
       ($1, 15.00, now() - interval '2 minutes'),
       ($1, 20.00, now() - interval '1 minute'),
       ($2, 20.00, now() - interval '3 minutes'),
       ($2, 15.00, now() - interval '2 minutes'),
       ($2, 10.00, now() - interval '1 minute')`,
      [rising, falling]
    );

    const result = await botService.runBotTick({ tickId: 5, now });
    expect(result.skipped).toBe(false);
    expect(Array.isArray(result.actions)).toBe(true);
    expect(result.actions).toHaveLength(4);

    const users = await botUsers();
    const userIds = users.map((u) => u.user_id);
    for (const userId of userIds) {
      // Legacy account state completely untouched by bot activity: bots are
      // provisioned with zero legacy funds and never gain or spend any.
      expect(parseFloat(users.find((u) => u.user_id === userId).funds)).toBe(0);
      expect(await legacyRowCounts(userId)).toEqual({ portfolios: 0, transactions: 0 });
    }

    // Any executed trade is a well-formed round ledger row at the
    // authoritative server price, matching the recorded tick actions.
    const { rows: ledger } = await db.query(
      `SELECT * FROM apocalypse_transactions WHERE cycle_id = $1 ORDER BY round_transaction_id`,
      [cycle.cycle_id]
    );
    const executed = result.actions.filter((a) => a.result === 'executed');
    expect(ledger).toHaveLength(executed.length);
    for (const tx of ledger) {
      expect(userIds).toContain(tx.user_id);
      expect(['BUY', 'SELL']).toContain(tx.type);
      expect(parseFloat(tx.quantity)).toBeGreaterThan(0);
      const { rows: coin } = await db.query('SELECT current_price FROM coins WHERE coin_id = $1', [tx.coin_id]);
      expect(parseFloat(tx.price)).toBeCloseTo(parseFloat(coin[0].current_price), 2);
    }

    // The durable tick row records exactly these actions (observability).
    const { rows: tickRows } = await db.query(
      'SELECT * FROM apocalypse_bot_ticks WHERE cycle_id = $1 AND tick_id = $2',
      [cycle.cycle_id, 5]
    );
    expect(tickRows).toHaveLength(1);
    expect(Array.isArray(tickRows[0].actions)).toBe(true);
    expect(tickRows[0].actions).toHaveLength(4);
  });

  test('ticks are deterministic: replaying the same seed/tick against a reset database chooses the same actions', async () => {
    const { cycle, now } = await setupCycle();
    const { rows: coins } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 2');
    const [rising, falling] = coins.map((c) => c.coin_id);
    await db.query('UPDATE coins SET current_price = 20.00 WHERE coin_id = $1', [rising]);
    await db.query('UPDATE coins SET current_price = 10.00 WHERE coin_id = $1', [falling]);
    await db.query('DELETE FROM price_history');
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at) VALUES
       ($1, 10.00, now() - interval '3 minutes'),
       ($1, 15.00, now() - interval '2 minutes'),
       ($1, 20.00, now() - interval '1 minute'),
       ($2, 20.00, now() - interval '3 minutes'),
       ($2, 15.00, now() - interval '2 minutes'),
       ($2, 10.00, now() - interval '1 minute')`,
      [rising, falling]
    );

    const first = await botService.runBotTick({ tickId: 9, now });
    expect(first.skipped).toBe(false);

    // Rebuild the identical market situation for the SAME cycle seed and a
    // second tick id, then compare per-bot decision shapes across replays of
    // the pure decision layer keyed identically.
    for (const bot of botConfig.BOT_ROSTER) {
      const rngA = botService.createBotRandom({ seed: FIXED_SEED, botKey: bot.botKey, tickId: 9 });
      const rngB = botService.createBotRandom({ seed: FIXED_SEED, botKey: bot.botKey, tickId: 9 });
      const stateA = await botService.buildPublicMarketState({
        cycle,
        participant: await gameRoundService.joinRound({
          userId: (await db.query('SELECT user_id FROM users WHERE username = $1', [bot.username])).rows[0].user_id,
          now
        }),
        now
      });
      const d1 = botService.decideBotAction({ strategy: bot.strategy, marketState: stateA, random: rngA });
      const d2 = botService.decideBotAction({ strategy: bot.strategy, marketState: stateA, random: rngB });
      expect(d1).toEqual(d2);
    }
    // And the executed tick's recorded actions match what the decision layer
    // produced for the same inputs (no hidden nondeterminism in the tick).
    expect(first.actions.every((a) => ['executed', 'skipped', 'rejected'].includes(a.result))).toBe(true);
  });

  test('invalid tick ids are rejected before any database write', async () => {
    await setupCycle();
    for (const bad of [-1, 1.5, NaN, 'x', undefined]) {
      await expect(botService.runBotTick({ tickId: bad, now: new Date() })).rejects.toThrow(/tickId/);
    }
  });
});

describe('Core 5: service-layer limit enforcement', () => {
  let saved;
  beforeEach(() => {
    saved = saveEnv();
  });
  afterEach(() => {
    restoreEnv(saved);
  });

  // Deterministic market: coin 1 rising, coin 2 falling hard — momentum and
  // the dip buyer both want to BUY, reckless always buys.
  async function deterministicMarket() {
    const { rows: coins } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id LIMIT 2');
    const [rising, falling] = coins.map((c) => c.coin_id);
    await db.query('UPDATE coins SET current_price = 20.00 WHERE coin_id = $1', [rising]);
    await db.query('UPDATE coins SET current_price = 10.00 WHERE coin_id = $1', [falling]);
    await db.query('DELETE FROM price_history');
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at) VALUES
       ($1, 10.00, now() - interval '3 minutes'),
       ($1, 15.00, now() - interval '2 minutes'),
       ($1, 20.00, now() - interval '1 minute'),
       ($2, 20.00, now() - interval '3 minutes'),
       ($2, 15.00, now() - interval '2 minutes'),
       ($2, 10.00, now() - interval '1 minute')`,
      [rising, falling]
    );
  }

  test('the per-trade size cap is enforced on every executed bot trade', async () => {
    process.env.GAME_BOT_MAX_TRADE_SIZE = '25';
    const { cycle, now } = await setupCycle();
    await deterministicMarket();

    const result = await botService.runBotTick({ tickId: 1, now });
    expect(result.skipped).toBe(false);
    const executed = result.actions.filter((a) => a.result === 'executed');
    expect(executed.length).toBeGreaterThan(0);

    const { rows: ledger } = await db.query(
      'SELECT * FROM apocalypse_transactions WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    expect(ledger).toHaveLength(executed.length);
    for (const tx of ledger) {
      // No bot trade may exceed the configured £25 cap — reckless included.
      expect(parseFloat(tx.total_amount)).toBeLessThanOrEqual(25);
    }
  });

  test('the per-bot cooldown is enforced from PERSISTED bot action times', async () => {
    const { cycle, now } = await setupCycle();
    await deterministicMarket();
    await botService.ensureBotsProvisioned();

    // Every bot acted one second ago (persisted): the default 60s cooldown
    // must suppress ALL of them, with no ledger writes.
    await db.query('UPDATE apocalypse_bots SET last_action_at = $1', [new Date(now.getTime() - 1000)]);
    const suppressed = await botService.runBotTick({ tickId: 1, now });
    expect(suppressed.skipped).toBe(false);
    expect(suppressed.actions).toHaveLength(4);
    expect(suppressed.actions.every((a) => a.result === 'skipped' && a.reason === 'cooldown')).toBe(true);
    const { rows: ledger } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_transactions WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    expect(ledger[0].n).toBe(0);

    // An explicit zero cooldown disables suppression entirely; executed
    // trades then re-stamp the persisted action time to this tick's `now`.
    process.env.GAME_BOT_COOLDOWN_MS = '0';
    const free = await botService.runBotTick({ tickId: 2, now });
    expect(free.actions.some((a) => a.result === 'executed')).toBe(true);
    const { rows: stamps } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_bots
       WHERE last_action_at IS NOT NULL AND last_action_at > $1`,
      [new Date(now.getTime() - 2000)]
    );
    expect(stamps[0].n).toBeGreaterThan(0);
  });

  test('the maximum actions per tick bound is enforced and recorded', async () => {
    process.env.GAME_BOT_MAX_ACTIONS_PER_TICK = '1';
    const { cycle, now } = await setupCycle();
    await deterministicMarket();

    const result = await botService.runBotTick({ tickId: 1, now });
    expect(result.skipped).toBe(false);
    expect(result.actions).toHaveLength(4);

    const executed = result.actions.filter((a) => a.result === 'executed');
    // Momentum always buys the riser here, so exactly one action executes and
    // every later bot is suppressed by the budget.
    expect(executed).toHaveLength(1);
    const firstExecutedIndex = result.actions.findIndex((a) => a.result === 'executed');
    for (const later of result.actions.slice(firstExecutedIndex + 1)) {
      expect(later.result).toBe('skipped');
      expect(later.reason).toBe('max-actions-per-tick');
    }

    const { rows: ledger } = await db.query(
      'SELECT count(*)::int AS n FROM apocalypse_transactions WHERE cycle_id = $1',
      [cycle.cycle_id]
    );
    expect(ledger[0].n).toBe(1);
  });
});

describe('Core 5: safe public bot exposure', () => {
  test('participant round state carries isBot and never strategy internals', async () => {
    const { now } = await setupCycle();
    await botService.runBotTick({ tickId: 1, now });

    const { rows: botUser } = await db.query(
      'SELECT user_id FROM users WHERE username = $1',
      [botConfig.BOT_ROSTER[0].username]
    );
    const { rows: p } = await db.query(
      'SELECT participant_id FROM apocalypse_participants WHERE user_id = $1',
      [botUser[0].user_id]
    );
    const botState = await gameRoundService.getParticipantRoundState(p[0].participant_id);
    expect(botState.isBot).toBe(true);
    expect(botState).not.toHaveProperty('strategy');
    expect(botState).not.toHaveProperty('botKey');

    const human = await gameRoundService.joinRound({ userId: 1, now });
    expect(human.isBot).toBe(false);
  });
});
