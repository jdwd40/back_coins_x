// Issue #20: bot exit strategies + late-Apocalypse liquidation pressure.
//
// Proves: every canonical personality has deterministic, reachable SELL
// behaviour — profit-taking, loss-cutting, reversal/recovery exits, and
// late/extreme liquidation; universal liquidation pressure is driven ONLY by
// public apocalypsePercent (identical shaped state, different progress ->
// different decision; no collapse-schedule fields anywhere); central
// exposure safeguards (per-coin exposure cap, max invested fraction, minimum
// cash reserve) can never be violated by repeated BUY decisions; and a
// representative multi-tick simulated round through the REAL tick service
// produces a materially healthier BUY/SELL mix than the pathological
// one-way behaviour audited in production — without any fixed 50/50 target.

const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const botConfig = require('../game/botConfig');
const botService = require('../game/botService');

const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const FIXED_SEED = 'issue20-simulated-round-seed';

const BOT_ENV_KEYS = [
  'GAME_BOT_TICK_INTERVAL_MS',
  'GAME_BOTS_ENABLED',
  'GAME_BOT_MAX_TRADE_SIZE',
  'GAME_BOT_COOLDOWN_MS',
  'GAME_BOT_MAX_ACTIONS_PER_TICK',
  'GAME_BOT_MAX_COIN_EXPOSURE_FRACTION'
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

// Deterministic market state fixture: coin 1 rising (+100% full window),
// coin 2 falling (-50% full window). Both alive.
function shapedState(overrides = {}) {
  return {
    apocalypsePercent: 20,
    cash: 1000,
    holdings: [],
    coins: [
      { coinId: 1, symbol: 'AAA', currentPrice: 20, collapsed: false, history: [10, 15, 20] },
      { coinId: 2, symbol: 'BBB', currentPrice: 10, collapsed: false, history: [20, 15, 10] }
    ],
    ...overrides
  };
}

function decide(strategy, state, random = () => 0) {
  return botService.decideBotAction({ strategy, marketState: state, random });
}

describe('issue #20: centralized exit/exposure configuration', () => {
  let saved;
  beforeEach(() => {
    saved = saveEnv();
  });
  afterEach(() => {
    restoreEnv(saved);
  });

  test('every canonical strategy has a validated personality profile with the required exit rules', () => {
    for (const strategy of botConfig.BOT_STRATEGIES) {
      const profile = botConfig.BOT_PERSONALITY_PROFILES[strategy];
      expect(profile).toBeDefined();
      expect(profile.maxInvestedFraction).toBeGreaterThan(0);
      expect(profile.minCashReserveFraction).toBeGreaterThan(0);
      expect(profile.lateCashTargetFraction).toBeGreaterThan(0);
    }
    // Personalities stay observably distinct under the shared rules.
    const p = botConfig.BOT_PERSONALITY_PROFILES;
    expect(p.conservative.stakeFraction).toBeLessThan(p.reckless.stakeFraction);
    expect(p.conservative.minCashReserveFraction).toBeGreaterThan(p.reckless.minCashReserveFraction);
    expect(p.conservative.lateCashTargetFraction).toBeGreaterThan(p.reckless.lateCashTargetFraction);
    expect(p.reckless.maxInvestedFraction).toBeGreaterThan(p.conservative.maxInvestedFraction);
  });

  test('malformed profiles are rejected at validation time', () => {
    expect(() => botConfig.validateBotPersonalityProfiles({})).toThrow(/missing a profile/);
    const broken = JSON.parse(JSON.stringify(botConfig.BOT_PERSONALITY_PROFILES));
    broken.reckless.stakeFraction = 4;
    expect(() => botConfig.validateBotPersonalityProfiles(broken)).toThrow(/reckless\.stakeFraction/);
    const missing = JSON.parse(JSON.stringify(botConfig.BOT_PERSONALITY_PROFILES));
    delete missing.momentum.momentumWindow;
    expect(() => botConfig.validateBotPersonalityProfiles(missing)).toThrow(/momentum\.momentumWindow/);
  });

  test('the per-coin exposure fraction is validated: finite fraction in (0, 1]', () => {
    for (const bad of ['abc', '0', '-0.5', '1.01', 'Infinity']) {
      process.env.GAME_BOT_MAX_COIN_EXPOSURE_FRACTION = bad;
      expect(() => botConfig.resolveBotConfig()).toThrow(/GAME_BOT_MAX_COIN_EXPOSURE_FRACTION/);
    }
    process.env.GAME_BOT_MAX_COIN_EXPOSURE_FRACTION = '0.25';
    expect(botConfig.resolveBotConfig().maxCoinExposureFraction).toBe(0.25);
    delete process.env.GAME_BOT_MAX_COIN_EXPOSURE_FRACTION;
    expect(botConfig.resolveBotConfig().maxCoinExposureFraction)
      .toBe(botConfig.DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION);
  });
});

describe('issue #20: universal liquidation-pressure phases', () => {
  test('phase boundaries are exact and derive only from apocalypsePercent', () => {
    expect(botService.liquidationPhase(0)).toBe('early');
    expect(botService.liquidationPhase(39.99)).toBe('early');
    expect(botService.liquidationPhase(40)).toBe('mid');
    expect(botService.liquidationPhase(69.99)).toBe('mid');
    expect(botService.liquidationPhase(70)).toBe('late');
    expect(botService.liquidationPhase(89.99)).toBe('late');
    expect(botService.liquidationPhase(90)).toBe('extreme');
    expect(botService.liquidationPhase(100)).toBe('extreme');
  });

  test('Apocalypse progress ALONE increases liquidation preference — identical state, no collapse data anywhere', () => {
    // A flat holding with no profit/loss trigger: the personality itself has
    // nothing to do. Only apocalypsePercent changes between the decisions.
    const base = shapedState({
      coins: [{ coinId: 1, symbol: 'AAA', currentPrice: 10, collapsed: false, history: [10, 10] }],
      holdings: [{ coinId: 1, symbol: 'AAA', quantity: 50 }],
      cash: 100
    });
    const early = decide('dip_buyer', { ...base, apocalypsePercent: 10 });
    expect(early.type).toBe('HOLD'); // no dip, no recovery, no pressure
    const late = decide('dip_buyer', { ...base, apocalypsePercent: 75 });
    expect(late).toEqual({ type: 'SELL', coinId: 1, quantity: 25 }); // reduce exposure
    const extreme = decide('dip_buyer', { ...base, apocalypsePercent: 95 });
    expect(extreme).toEqual({ type: 'SELL', coinId: 1, quantity: 50 }); // liquidate in full
  });

  test('late phase opens no new positions even on a perfect setup; extreme liquidates the worst live holding first', () => {
    const riser = shapedState({ apocalypsePercent: 75, cash: 10000, holdings: [] });
    for (const strategy of botConfig.BOT_STRATEGIES) {
      expect(decide(strategy, riser).type).toBe('HOLD');
    }
    // Extreme: worst full-window change liquidated in full, deterministically.
    const state = shapedState({
      apocalypsePercent: 92,
      cash: 9000,
      holdings: [
        { coinId: 1, symbol: 'AAA', quantity: 10 }, // +100%
        { coinId: 2, symbol: 'BBB', quantity: 8 } // -50%
      ]
    });
    expect(decide('reckless', state)).toEqual({ type: 'SELL', coinId: 2, quantity: 8 });
    // Dead holdings are excluded: a collapsed coin is worth £0 and selling
    // it recovers no cash, so there is nothing to liquidate.
    const deadOnly = shapedState({
      apocalypsePercent: 95,
      cash: 9000,
      coins: [{ coinId: 1, symbol: 'AAA', currentPrice: 0, collapsed: true, history: [10, 0] }],
      holdings: [{ coinId: 1, symbol: 'AAA', quantity: 10 }]
    });
    for (const strategy of botConfig.BOT_STRATEGIES) {
      const action = decide(strategy, deadOnly);
      expect(action.type).toBe('HOLD');
      expect(action.reason).toBe('extreme-no-live-holdings');
    }
  });

  test('the late-phase cash target is personality-shaped: conservative de-risks where reckless is already satisfied', () => {
    const state = shapedState({
      apocalypsePercent: 75,
      cash: 1000,
      holdings: [{ coinId: 2, symbol: 'BBB', quantity: 200 }] // £2,000 -> cash fraction 1/3
    });
    // Conservative targets 70% cash: 33% is below target -> sell the worst
    // holding in full.
    expect(decide('conservative', state, () => 0.1))
      .toEqual({ type: 'SELL', coinId: 2, quantity: 200 });
    // Reckless targets only 30% cash: 33% already satisfies it -> HOLD.
    expect(decide('reckless', state)).toMatchObject({ type: 'HOLD', reason: 'late-cash-target-met' });
  });

  test('the mid phase still trades but with a scaled-down invested cap', () => {
    const coins = [
      { coinId: 1, symbol: 'AAA', currentPrice: 10.5, collapsed: false, history: [10, 10.5] }, // +5% riser
      { coinId: 2, symbol: 'BBB', currentPrice: 10, collapsed: false, history: [10, 10] } // flat holding
    ];
    const base = shapedState({
      coins,
      cash: 550,
      holdings: [{ coinId: 2, symbol: 'BBB', quantity: 45 }] // £450 invested of £1,000 wealth
    });
    // Early: invested cap 60% of £1,000 = £600 -> £150 headroom -> BUY.
    expect(decide('momentum', { ...base, apocalypsePercent: 20 })).toMatchObject({ type: 'BUY', coinId: 1 });
    // Mid: cap scaled by 0.5 -> £300 < £450 already invested -> no new BUY.
    expect(decide('momentum', { ...base, apocalypsePercent: 50 }))
      .toMatchObject({ type: 'HOLD', reason: 'exposure-limits' });
  });
});

describe('issue #20: every personality has reachable SELL behaviour', () => {
  test('conservative: takes a modest profit (half) and cuts a meaningful loss (full)', () => {
    const gainer = shapedState({ holdings: [{ coinId: 1, symbol: 'AAA', quantity: 10 }] }); // +100%
    expect(decide('conservative', gainer, () => 0.1)).toEqual({ type: 'SELL', coinId: 1, quantity: 5 });
    const loser = shapedState({ holdings: [{ coinId: 2, symbol: 'BBB', quantity: 10 }] }); // -50%
    expect(decide('conservative', loser, () => 0.1)).toEqual({ type: 'SELL', coinId: 2, quantity: 10 });
  });

  test('momentum: halves a reversed position, takes profit on a solid gain, and enters on reachable short momentum', () => {
    const reversed = shapedState({ holdings: [{ coinId: 2, symbol: 'BBB', quantity: 6 }] }); // short trend < 0
    expect(decide('momentum', reversed)).toEqual({ type: 'SELL', coinId: 2, quantity: 3 });
    const gainer = shapedState({
      coins: [{ coinId: 1, symbol: 'AAA', currentPrice: 11.5, collapsed: false, history: [10, 11.5] }],
      holdings: [{ coinId: 1, symbol: 'AAA', quantity: 8 }]
    }); // +15% full window, still rising -> no reversal, take profit
    expect(decide('momentum', gainer)).toEqual({ type: 'SELL', coinId: 1, quantity: 4 });
    // Reachable entry: a modest recent uptick qualifies (the old full-window
    // rule almost never fired in a declining market).
    const uptick = shapedState({
      coins: [{ coinId: 1, symbol: 'AAA', currentPrice: 10.25, collapsed: false, history: [10.1, 10.0, 10.25] }]
    });
    expect(decide('momentum', uptick)).toMatchObject({ type: 'BUY', coinId: 1 });
  });

  test('dip buyer: sells a meaningful recovery and cuts a dip that keeps collapsing instead of averaging forever', () => {
    const recovered = shapedState({ holdings: [{ coinId: 1, symbol: 'AAA', quantity: 6 }] }); // +100%
    expect(decide('dip_buyer', recovered)).toEqual({ type: 'SELL', coinId: 1, quantity: 6 });
    const collapsing = shapedState({
      coins: [{ coinId: 2, symbol: 'BBB', currentPrice: 7, collapsed: false, history: [10, 8.5, 7] }],
      holdings: [{ coinId: 2, symbol: 'BBB', quantity: 5 }]
    }); // -30% full window: beyond the -25% cut
    expect(decide('dip_buyer', collapsing)).toEqual({ type: 'SELL', coinId: 2, quantity: 5 });
  });

  test('reckless: locks a big win (half) and panic-cuts a deep loser (full)', () => {
    const winner = shapedState({
      coins: [{ coinId: 1, symbol: 'AAA', currentPrice: 13.5, collapsed: false, history: [10, 13.5] }],
      holdings: [{ coinId: 1, symbol: 'AAA', quantity: 10 }]
    }); // +35% >= +30%
    expect(decide('reckless', winner)).toEqual({ type: 'SELL', coinId: 1, quantity: 5 });
    const deepLoser = shapedState({
      coins: [{ coinId: 2, symbol: 'BBB', currentPrice: 4.5, collapsed: false, history: [10, 4.5] }],
      holdings: [{ coinId: 2, symbol: 'BBB', quantity: 20 }]
    }); // -55% <= -50%
    expect(decide('reckless', deepLoser)).toEqual({ type: 'SELL', coinId: 2, quantity: 20 });
  });

  test('a full exit sells the EXACT fractional holding — never a rounded-up oversell', () => {
    const fractional = shapedState({
      apocalypsePercent: 95,
      cash: 100,
      holdings: [{ coinId: 2, symbol: 'BBB', quantity: 12.345678 }]
    });
    const action = decide('conservative', fractional, () => 0.1);
    expect(action).toEqual({ type: 'SELL', coinId: 2, quantity: 12.345678 });
  });
});

describe('issue #20: central exposure safeguards hold under repeated BUYs', () => {
  // Apply a BUY decision to a pure fixture state and assert every safeguard.
  function applyBuy(state, decision, profile) {
    const coin = state.coins.find((c) => c.coinId === decision.coinId);
    const cost = decision.quantity * coin.currentPrice;
    state.cash = Math.round((state.cash - cost) * 100) / 100;
    const holding = state.holdings.find((h) => h.coinId === decision.coinId);
    if (holding) holding.quantity += decision.quantity;
    else state.holdings.push({ coinId: decision.coinId, symbol: coin.symbol, quantity: decision.quantity });
    // Invariants, checked after EVERY buy.
    const snapshot = botService.portfolioSnapshot(state);
    const coinEntry = snapshot.holdings.find((e) => e.holding.coinId === decision.coinId);
    expect(snapshot.cash + 1e-9).toBeGreaterThanOrEqual(profile.minCashReserveFraction * snapshot.wealth);
    expect(snapshot.investedValue).toBeLessThanOrEqual(profile.maxInvestedFraction * snapshot.wealth + 1e-9);
    expect(coinEntry.value).toBeLessThanOrEqual(botConfig.DEFAULT_BOT_MAX_COIN_EXPOSURE_FRACTION * snapshot.wealth + 1e-9);
    return snapshot;
  }

  test('reckless: repeated aggressive buys stop at the caps instead of draining toward £0', () => {
    const profile = botConfig.BOT_PERSONALITY_PROFILES.reckless;
    const state = shapedState({
      apocalypsePercent: 10,
      cash: 10000,
      holdings: [],
      coins: [{ coinId: 1, symbol: 'AAA', currentPrice: 10, collapsed: false, history: [10, 10] }]
    });
    let buys = 0;
    let last;
    for (let i = 0; i < 20; i += 1) {
      const decision = decide('reckless', state);
      if (decision.type !== 'BUY') {
        last = decision;
        break;
      }
      buys += 1;
      applyBuy(state, decision, profile);
    }
    // The old behaviour bought forever (40% of cash each time, asymptotically
    // to £0). Now the caps stop it deterministically with an explained HOLD.
    expect(buys).toBeGreaterThan(0);
    expect(last).toMatchObject({ type: 'HOLD', reason: 'exposure-limits' });
    const snapshot = botService.portfolioSnapshot(state);
    expect(snapshot.cash).toBeGreaterThan(4000); // never anywhere near £0
  });

  test('dip buyer: repeated dip buys cannot consume nearly all cash without an exit', () => {
    const profile = botConfig.BOT_PERSONALITY_PROFILES.dip_buyer;
    const state = shapedState({
      apocalypsePercent: 10,
      cash: 10000,
      holdings: [],
      coins: [{ coinId: 1, symbol: 'AAA', currentPrice: 8.5, collapsed: false, history: [10, 8.5] }] // -15% dip
    });
    let buys = 0;
    let last;
    for (let i = 0; i < 30; i += 1) {
      const decision = decide('dip_buyer', state);
      if (decision.type !== 'BUY') {
        last = decision;
        break;
      }
      buys += 1;
      applyBuy(state, decision, profile);
    }
    expect(buys).toBeGreaterThan(1); // genuine averaging...
    expect(last).toMatchObject({ type: 'HOLD', reason: 'exposure-limits' }); // ...with a hard stop
    const snapshot = botService.portfolioSnapshot(state);
    expect(snapshot.cash).toBeGreaterThanOrEqual(profile.minCashReserveFraction * snapshot.wealth - 1e-9);
  });

  test('the minimum cash reserve blocks spending the last cash while overexposed', () => {
    const state = shapedState({
      apocalypsePercent: 10,
      cash: 100,
      coins: [
        { coinId: 1, symbol: 'AAA', currentPrice: 20, collapsed: false, history: [10, 15, 20] },
        { coinId: 2, symbol: 'BBB', currentPrice: 10, collapsed: false, history: [10, 10] }
      ],
      holdings: [{ coinId: 2, symbol: 'BBB', quantity: 90 }] // £900 of £1,000 invested, flat
    });
    // Conservative reserve is 30% of £1,000 wealth = £300 > £100 cash.
    expect(decide('conservative', state, () => 0.1))
      .toMatchObject({ type: 'HOLD', reason: 'exposure-limits' });
  });
});

describe('issue #20: representative multi-tick simulated round', () => {
  jest.setTimeout(60000);

  let step = 0;
  async function pushHistory(coinId, prices) {
    for (const price of prices) {
      step += 1;
      await db.query(
        `INSERT INTO price_history (coin_id, price, created_at) VALUES ($1, $2, now() + $3 * interval '1 second')`,
        [coinId, price, step]
      );
    }
  }

  async function setPrice(coinId, price, newPoints) {
    await db.query('UPDATE coins SET current_price = $2 WHERE coin_id = $1', [coinId, price]);
    await pushHistory(coinId, newPoints);
  }

  async function liveHoldingsValue(cycleId) {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(h.quantity * c.current_price), 0)::float AS value
       FROM apocalypse_holdings h
       JOIN coins c ON c.coin_id = h.coin_id
       JOIN users u ON u.user_id = h.user_id
       WHERE h.cycle_id = $1 AND u.is_bot = true AND h.quantity > 0 AND c.current_price > 0`,
      [cycleId]
    );
    return rows[0].value;
  }

  test('a full simulated Apocalypse produces credible exits, not one-way accumulation', async () => {
    const base = new Date();
    const cycle = await reconcileCycle({ now: base, durationMs: LONG_DURATION_MS, generateSeed: () => FIXED_SEED });
    const { rows: coinRows } = await db.query('SELECT coin_id FROM coins ORDER BY coin_id');
    const ids = coinRows.map((r) => r.coin_id);
    const c2 = ids[1]; // the momentum play (collapses ~90% under this fixed seed)
    const c4 = ids[3]; // the flat "stable" coin (collapses ~93%)
    const c9 = ids[8]; // the dip coin AND the scheduled survivor under this seed

    // Freeze the market deterministically, then concentrate it: only the
    // three tracked coins remain tradable, so late-phase positions are still
    // LIVE when endgame pressure arrives. The seed-derived collapse schedule
    // is TEST knowledge, used only to place the scenario — the shaped bot
    // state never contains it.
    await db.query('DELETE FROM price_history');
    for (const coinId of ids) {
      await db.query('UPDATE coins SET current_price = 10.00 WHERE coin_id = $1', [coinId]);
    }
    const active = new Set([c2, c4, c9]);
    for (const coinId of ids) {
      if (!active.has(coinId)) {
        await db.query('UPDATE coins SET retired = TRUE WHERE coin_id = $1', [coinId]);
      }
    }
    await setPrice(c2, 10, [10]); // momentum: rises early, fades late
    await setPrice(c4, 10, [10, 10]); // permanently flat
    await setPrice(c9, 5, [5]); // dips, then drifts without recovering

    // pct = public Apocalypse progress at each tick. The price paths make
    // every exit rule fire: momentum profit-taking, reversal exits, capped
    // dip averaging, late cash-target liquidation and extreme full exits.
    const ticks = [
      { pct: 2, prices: { [c2]: [10.3, [10.3]], [c9]: [4.4, [4.4]] } },
      { pct: 8, prices: { [c2]: [10.9, [10.9]], [c9]: [4.2, [4.2]] } },
      { pct: 14, prices: { [c2]: [11.6, [11.6]], [c9]: [4.0, [4.0]] } },
      { pct: 20, prices: { [c2]: [12.2, [12.2]], [c9]: [4.1, [4.1]] } },
      { pct: 35, prices: { [c2]: [12.6, [12.6]], [c9]: [4.2, [4.2]] } },
      { pct: 50, prices: { [c2]: [12.0, [12.0]], [c9]: [4.3, [4.3]] } },
      { pct: 62, prices: { [c2]: [11.0, [11.0]], [c9]: [4.4, [4.4]] } },
      { pct: 75, prices: { [c2]: [10.0, [10.0]], [c9]: [4.4, [4.4]] } },
      { pct: 80, prices: { [c9]: [4.4, [4.4]] } },
      { pct: 85, prices: { [c9]: [4.4, [4.4]] } },
      { pct: 92, prices: { [c9]: [4.4, [4.4]] } },
      { pct: 97, prices: { [c9]: [4.4, [4.4]] } }
    ];

    const results = [];
    for (let i = 0; i < ticks.length; i += 1) {
      const { pct, prices } = ticks[i];
      for (const coinId of Object.keys(prices)) {
        const [price, points] = prices[coinId];
        await setPrice(Number(coinId), price, points);
      }
      const now = new Date(base.getTime() + (pct / 100) * LONG_DURATION_MS);
      const result = await botService.runBotTick({ tickId: i + 1, now });
      expect(result.skipped).toBe(false);
      results.push({ pct, result });
    }

    const allActions = results.flatMap((r) => r.result.actions.map((a) => ({ pct: r.pct, ...a })));
    const executed = allActions.filter((a) => a.result === 'executed');
    const buys = executed.filter((a) => a.action && a.action.type === 'BUY');
    const sells = executed.filter((a) => a.action && a.action.type === 'SELL');
    const lateSells = sells.filter((a) => a.pct >= 70);

    // A materially healthier mix than the audited 116 BUY / 0 SELL pathology
    // — credible exits, not an artificial 50/50 symmetry.
    expect(buys.length).toBeGreaterThanOrEqual(3);
    expect(sells.length).toBeGreaterThanOrEqual(4);
    expect(lateSells.length).toBeGreaterThanOrEqual(3);
    expect(sells.length / (buys.length + sells.length)).toBeGreaterThanOrEqual(0.25);

    // No bot opens a new position once the Apocalypse turns dangerous.
    const lateActions = allActions.filter((a) => a.pct >= 70);
    expect(lateActions.every((a) => !a.action || a.action.type !== 'BUY')).toBe(true);

    // By the (near) end, surviving bot holdings trend to liquidation: nothing
    // live is left riding into settlement (positions were either sold or
    // their coins already publicly collapsed).
    expect(await liveHoldingsValue(cycle.cycle_id)).toBeLessThan(1);

    // Every bot finishes with meaningful cash — the production audit found
    // finals like £339 (Reckless) and £3,252 (Dip Buyer) from one-way
    // accumulation; exit rules leave every bot with a credible bankroll.
    const { rows: finals } = await db.query(
      `SELECT u.username, p.current_cash::float AS cash
       FROM apocalypse_participants p JOIN users u ON u.user_id = p.user_id
       WHERE p.cycle_id = $1 AND u.is_bot = true`,
      [cycle.cycle_id]
    );
    expect(finals).toHaveLength(4);
    for (const row of finals) {
      expect(row.cash).toBeGreaterThan(4000);
    }

    // Observability: every tick row records the full action ledger with
    // distinguishable results, and HOLDs carry explanations.
    const { rows: tickRows } = await db.query(
      'SELECT tick_id, actions FROM apocalypse_bot_ticks WHERE cycle_id = $1 ORDER BY tick_id',
      [cycle.cycle_id]
    );
    expect(tickRows).toHaveLength(ticks.length);
    for (const row of tickRows) {
      expect(row.actions).toHaveLength(4);
      for (const action of row.actions) {
        expect(['executed', 'skipped', 'rejected']).toContain(action.result);
      }
    }
    const holdReasons = new Set(
      allActions.filter((a) => a.action && a.action.type === 'HOLD').map((a) => a.action.reason)
    );
    expect(holdReasons.size).toBeGreaterThan(0);

    // Every executed bot trade is a real shared-service ledger row.
    const { rows: ledger } = await db.query(
      `SELECT type, count(*)::int AS n FROM apocalypse_transactions
       WHERE cycle_id = $1 GROUP BY type`,
      [cycle.cycle_id]
    );
    const byType = Object.fromEntries(ledger.map((r) => [r.type, r.n]));
    expect(byType.BUY).toBe(buys.length);
    expect(byType.SELL).toBe(sells.length);
  });
});
