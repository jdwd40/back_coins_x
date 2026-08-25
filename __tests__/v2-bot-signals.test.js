// V2-4: bots play the V2 game legally and observably differently.
//
// Proves:
//   * the shaped public bot state is EXACTLY the allowlisted V2-4 shape —
//     current price + recent public history + coarse phase/momentum/
//     archetype/collapse-risk + apocalypsePercent + the bot's own cash/
//     holdings economics + its own Power view + its own open-position
//     count/limit — and that assertPublicBotState hard-rejects any extra
//     (seed, schedule row, collapse rank/timestamp, future value) or
//     missing field, for every personality;
//   * the live builder produces the SAME coarse public signals the
//     human-facing market-signals endpoint publishes for the same instant;
//   * the personalities behave distinctly on the public signals
//     (conservative avoids DANGER, momentum needs RISE+UP, dip buyer buys
//     the DIP phase, reckless hunts DEGEN/RUG and accepts CRITICAL);
//   * the decision layer is Power/position-limit aware (constrained HOLDs),
//     while selling stays available at zero Power;
//   * Power/position-limit domain rejections inside a live tick are
//     recorded as non-fatal bot skips (never bypassed, never fatal);
//   * the simulator adapter feeds the REAL decision layer with contract-
//     verified inputs, and a sell attempted at zero Power still executes.

const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');
const { GameRoundError } = gameRoundService;
const marketSignalsService = require('../game/marketSignalsService');
const botConfig = require('../game/botConfig');
const botService = require('../game/botService');
const { createRoundEnvironment } = require('../simulation/roundEnvironment');
const { createRoundContext, runRound } = require('../simulation/engine');
const { runBotStudy, buildBotReport, makeBotStrategy } = require('../simulation/botStudy');

const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const FIXED_SEED = 'v2-4-bot-signals-cycle-seed';

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

function decide(strategy, state, random = () => 0) {
  return botService.decideBotAction({ strategy, marketState: state, random });
}

async function setupCycle() {
  const now = new Date();
  const cycle = await reconcileCycle({ now, durationMs: LONG_DURATION_MS, generateSeed: () => FIXED_SEED });
  return { cycle, now };
}

describe('V2-4: the public-state contract is exact and enforced', () => {
  test('a well-formed shaped state passes for every personality', () => {
    const state = shapedState();
    expect(() => botService.assertPublicBotState(state)).not.toThrow();
    for (const strategy of botConfig.BOT_STRATEGIES) {
      expect(() => decide(strategy, state)).not.toThrow();
    }
  });

  test('hidden fields are hard-rejected at every depth — seed, schedule, collapse rank, future values', () => {
    const state = shapedState();
    const poisonedTop = { ...state, seed: 'cycle-seed' };
    expect(() => botService.assertPublicBotState(poisonedTop)).toThrow(/forbidden:seed/);
    const poisonedCoin = shapedState({
      coins: [{ ...state.coins[0], scheduledAt: '2026-08-25T00:00:00Z', collapseRank: 1 }]
    });
    expect(() => botService.assertPublicBotState(poisonedCoin)).toThrow(/forbidden:scheduledAt/);
    const poisonedHolding = shapedState({ holdings: [{ ...v2Holding(), futurePeak: 99 }] });
    expect(() => botService.assertPublicBotState(poisonedHolding)).toThrow(/forbidden:futurePeak/);
    const poisonedPower = shapedState({ power: { current: 1, max: 100, regenMsPerPoint: 30000, nextCollapseAtMs: 1 } });
    expect(() => botService.assertPublicBotState(poisonedPower)).toThrow(/forbidden:nextCollapseAtMs/);
    const poisonedPositions = shapedState({ openPositions: { open: 0, max: 3, collapseOrder: [1, 2] } });
    expect(() => botService.assertPublicBotState(poisonedPositions)).toThrow(/forbidden:collapseOrder/);
  });

  test('missing fields and invalid vocabulary are hard-rejected', () => {
    const state = shapedState();
    const missingPower = { ...state };
    delete missingPower.power;
    expect(() => botService.assertPublicBotState(missingPower)).toThrow(/missing:power/);
    const badPhase = shapedState({ coins: [{ ...state.coins[0], phase: 'MOON_SOON' }] });
    expect(() => botService.assertPublicBotState(badPhase)).toThrow(/phase must be one of/);
    const badRisk = shapedState({ coins: [{ ...state.coins[0], collapseRisk: 'DOOMED' }] });
    expect(() => botService.assertPublicBotState(badRisk)).toThrow(/collapseRisk must be one of/);
    // Dead state must be consistent across collapsed/phase/collapseRisk.
    const inconsistentDead = shapedState({
      coins: [v2Coin({ collapsed: true, currentPrice: 0, phase: 'RISE', collapseRisk: 'STABLE' })]
    });
    expect(() => botService.assertPublicBotState(inconsistentDead)).toThrow(/inconsistent/);
  });

  test('the decision layer itself refuses a poisoned state for every personality', () => {
    const poisoned = { ...shapedState(), cycleSeed: 'hidden' };
    for (const strategy of botConfig.BOT_STRATEGIES) {
      expect(() => decide(strategy, poisoned)).toThrow(/public-state contract/);
    }
  });
});

describe('V2-4: personalities trade the public signals observably differently', () => {
  test('conservative: refuses a DANGER entry and dumps a DANGER holding in full', () => {
    const dangerous = shapedState({
      coins: [v2Coin({
        phase: 'DIP', momentum: 'DOWN', collapseRisk: 'DANGER', recentChangePct: -20
      })]
    });
    expect(decide('conservative', dangerous, () => 0.1).type).toBe('HOLD'); // no-calm-entry
    // ...but a STABLE dip is exactly its trade.
    const calm = shapedState({
      coins: [v2Coin({
        currentPrice: 9, history: [10, 9],
        phase: 'DIP', momentum: 'DOWN', collapseRisk: 'STABLE', recentChangePct: -10
      })]
    });
    expect(decide('conservative', calm, () => 0.1)).toMatchObject({ type: 'BUY', coinId: 1 });
    // A held coin turning DANGEROUS is exited in full even while ahead.
    const heldDanger = shapedState({
      coins: [v2Coin({ collapseRisk: 'DANGER' })],
      holdings: [v2Holding({ quantity: 8 })]
    });
    expect(decide('conservative', heldDanger, () => 0.1)).toEqual({ type: 'SELL', coinId: 1, quantity: 8 });
  });

  test('conservative: banks a BOOM as soon as its momentum stops confirming', () => {
    const stalledBoom = shapedState({
      coins: [v2Coin({
        currentPrice: 24, history: [10, 20, 24],
        phase: 'BOOM', momentum: 'FLAT', collapseRisk: 'SHAKY', recentChangePct: 20
      })],
      holdings: [v2Holding({ quantity: 10 })]
    });
    // +100% would ALSO trip plain profit-taking; pin the P&L below the +8%
    // bar so only the BOOM-stall exit can fire.
    const onlyStall = shapedState({
      coins: [v2Coin({
        currentPrice: 10.4, history: [10, 10.4],
        phase: 'BOOM', momentum: 'FLAT', collapseRisk: 'SHAKY', recentChangePct: 1
      })],
      holdings: [v2Holding({ quantity: 10 })]
    });
    expect(decide('conservative', stalledBoom, () => 0.1)).toEqual({ type: 'SELL', coinId: 1, quantity: 5 });
    expect(decide('conservative', onlyStall, () => 0.1)).toEqual({ type: 'SELL', coinId: 1, quantity: 5 });
    // Reckless has no weak-momentum exit at all — the same stalled BOOM is
    // ridden (and here even bought into), the deliberate overstay contrast.
    expect(decide('reckless', onlyStall, () => 0.1).type).not.toBe('SELL');
  });

  test('momentum: enters only a confirmed RISE+UP, exits a FALL, and ignores dips', () => {
    const dipOnly = shapedState({
      coins: [v2Coin({
        currentPrice: 8, history: [10, 8],
        phase: 'DIP', momentum: 'DOWN', collapseRisk: 'STABLE', recentChangePct: -20
      })]
    });
    expect(decide('momentum', dipOnly).type).toBe('HOLD'); // not a momentum trade
    const unconfirmed = shapedState({
      coins: [v2Coin({
        currentPrice: 10.05, history: [10.1, 10.0, 10.05],
        phase: 'RISE', momentum: 'UP', collapseRisk: 'STABLE', recentChangePct: 0.5
      })]
    });
    // Public momentum UP but the short-window history is flat — not an
    // established trend, so no entry.
    expect(decide('momentum', unconfirmed).type).toBe('HOLD');
    const falling = shapedState({
      coins: [v2Coin({
        currentPrice: 12, history: [10, 12, 12],
        phase: 'FALL', momentum: 'DOWN', collapseRisk: 'SHAKY', recentChangePct: -3
      })],
      holdings: [v2Holding({ quantity: 8 })]
    });
    expect(decide('momentum', falling)).toEqual({ type: 'SELL', coinId: 1, quantity: 4 });
  });

  test('dip buyer: buys the public DIP phase, an early RISE, never CRITICAL; sells the completed BOOM ride', () => {
    const dip = shapedState({
      coins: [v2Coin({
        currentPrice: 8, history: [10, 8],
        phase: 'DIP', momentum: 'DOWN', collapseRisk: 'DANGER', recentChangePct: -20
      })]
    });
    expect(decide('dip_buyer', dip)).toMatchObject({ type: 'BUY', coinId: 1 }); // tolerates DANGER
    const criticalDip = shapedState({
      coins: [v2Coin({
        currentPrice: 8, history: [10, 8],
        phase: 'DIP', momentum: 'DOWN', collapseRisk: 'CRITICAL', recentChangePct: -20
      })]
    });
    expect(decide('dip_buyer', criticalDip).type).toBe('HOLD'); // never CRITICAL
    const earlyRise = shapedState({
      coins: [v2Coin({
        currentPrice: 10.1, history: [10, 10.1],
        phase: 'RISE', momentum: 'UP', collapseRisk: 'STABLE', recentChangePct: 1
      })]
    });
    expect(decide('dip_buyer', earlyRise)).toMatchObject({ type: 'BUY', coinId: 1 });
    const boomRide = shapedState({
      coins: [v2Coin({
        currentPrice: 15, history: [10, 15],
        phase: 'BOOM', momentum: 'UP', collapseRisk: 'SHAKY', recentChangePct: 50
      })],
      holdings: [v2Holding({ quantity: 7 })]
    });
    expect(decide('dip_buyer', boomRide)).toEqual({ type: 'SELL', coinId: 1, quantity: 7 });
    // A FALL wobble above the exit bar is ridden out (the overstay trait).
    const wobble = shapedState({
      coins: [v2Coin({
        currentPrice: 9.5, history: [10, 11.5, 9.5],
        phase: 'FALL', momentum: 'DOWN', collapseRisk: 'SHAKY', recentChangePct: -4
      })],
      holdings: [v2Holding({ quantity: 7, unrealizedPnlPct: -5 })]
    });
    expect(decide('dip_buyer', wobble).type).not.toBe('SELL');
  });

  test('reckless: prefers DEGEN/RUG archetypes and willingly buys CRITICAL readings', () => {
    const calm = v2Coin({
      coinId: 1, symbol: 'AAA', currentPrice: 10, history: [10, 10],
      phase: 'RISE', momentum: 'FLAT', archetype: 'MOON', collapseRisk: 'STABLE', recentChangePct: 0
    });
    const wild = v2Coin({
      coinId: 2, symbol: 'BBB', currentPrice: 10, history: [10, 10],
      phase: 'FALL', momentum: 'DOWN', archetype: 'RUG', collapseRisk: 'CRITICAL', recentChangePct: -30
    });
    const state = shapedState({ coins: [calm, wild] });
    // Both deterministic picks land on the RUG wildcard: the preferred
    // archetype pool excludes the calm MOON coin entirely.
    expect(decide('reckless', state, () => 0)).toMatchObject({ type: 'BUY', coinId: 2 });
    expect(decide('reckless', state, () => 0.99)).toMatchObject({ type: 'BUY', coinId: 2 });
    // Conservative refuses the same state outright (STABLE RISE exists but
    // the only DIP-style entry is CRITICAL; the calm coin is a RISE/STABLE
    // entry — Conservative WILL take the calm coin, Reckless never does).
    expect(decide('conservative', state, () => 0.1)).toMatchObject({ type: 'BUY', coinId: 1 });
  });
});

describe('V2-4: the decision layer is Power and position-limit aware', () => {
  test('a buy the visible Power balance cannot cover is a constrained HOLD', () => {
    const state = shapedState({ power: { current: 0, max: 100, regenMsPerPoint: 30000 } });
    expect(decide('dip_buyer', state)).toMatchObject({ type: 'HOLD', reason: 'power-constrained' });
    // A tiny visible balance still constrains an expensive stake.
    const thin = shapedState({ power: { current: 1, max: 100, regenMsPerPoint: 30000 } });
    // Dip buyer stake here is 30% of £1,000 = £300 -> 3 Power > 1.
    expect(decide('dip_buyer', thin)).toMatchObject({ type: 'HOLD', reason: 'power-constrained' });
  });

  test('selling stays available at zero Power', () => {
    const state = shapedState({
      power: { current: 0, max: 100, regenMsPerPoint: 30000 },
      holdings: [v2Holding({ quantity: 6 })] // +100% gainer
    });
    expect(decide('dip_buyer', state)).toEqual({ type: 'SELL', coinId: 1, quantity: 6 });
    const extreme = shapedState({
      apocalypsePercent: 95,
      power: { current: 0, max: 100, regenMsPerPoint: 30000 },
      holdings: [v2Holding({ quantity: 6 })]
    });
    expect(decide('reckless', extreme)).toEqual({ type: 'SELL', coinId: 1, quantity: 6 });
  });

  test('the position limit blocks NEW coins but never adds to a held one', () => {
    const state = shapedState({
      coins: [
        v2Coin(),
        v2Coin({
          coinId: 2, symbol: 'BBB', currentPrice: 10, history: [10, 9],
          phase: 'DIP', momentum: 'DOWN', collapseRisk: 'STABLE', recentChangePct: -10
        })
      ],
      holdings: [v2Holding({ coinId: 2, symbol: 'BBB', quantity: 5 })],
      openPositions: { open: 3, max: 3 }
    });
    // Dip buyer wants the coin-2 DIP... and coin 2 IS held, so the add is
    // allowed even at the cap.
    expect(decide('dip_buyer', state)).toMatchObject({ type: 'BUY', coinId: 2 });
    // Reckless wants a NEW coin: blocked with an explained HOLD.
    expect(decide('reckless', state)).toMatchObject({ type: 'HOLD', reason: 'position-limit' });
  });
});

describe('V2-4: live tick records resource rejections as non-fatal skips', () => {
  afterEach(() => jest.restoreAllMocks());

  test('classifyBotDomainError maps only the Power/position-limit rejections', () => {
    expect(botService.classifyBotDomainError(new GameRoundError('Insufficient Power. This buy costs 3 Power but you have 0.', 400)))
      .toBe('power-blocked');
    expect(botService.classifyBotDomainError(new GameRoundError('Position limit reached: you may hold at most 3...', 400)))
      .toBe('position-limit');
    expect(botService.classifyBotDomainError(new GameRoundError('Insufficient round cash. You need £1 but have £0.', 400)))
      .toBeNull();
    expect(botService.classifyBotDomainError(new Error('boom'))).toBeNull();
  });

  test('a Power rejection from the shared service becomes a power-blocked skip — no trade, no cooldown stamp', async () => {
    const { cycle, now } = await setupCycle();
    // Control: without interference at least one bot really trades...
    const control = await botService.runBotTick({ tickId: 1, now });
    expect(control.skipped).toBe(false);
    const controlBuys = control.actions.filter((a) => a.result === 'executed' && a.action && a.action.type === 'BUY').length;
    expect(controlBuys).toBeGreaterThan(0);

    jest.spyOn(gameRoundService, 'buyRoundTrade')
      .mockRejectedValue(new GameRoundError('Insufficient Power. This buy costs 3 Power but you have 0. Power regenerates +1 every 30 seconds; selling is always free.', 400));
    // Past the persisted 60s cooldown so tick-1 buyers can act again.
    const result = await botService.runBotTick({ tickId: 2, now: new Date(now.getTime() + 61 * 1000) });
    expect(result.skipped).toBe(false);
    const blocked = result.actions.filter((a) => a.result === 'skipped' && a.reason === 'power-blocked');
    expect(blocked.length).toBeGreaterThan(0);
    // No BUY executed under the mocked rejection (sells are never Power-gated).
    expect(result.actions.every((a) => a.result !== 'executed' || (a.action && a.action.type === 'SELL'))).toBe(true);

    // The blocked tick added zero BUY rows to the shared ledger — the
    // rejection consumed nothing — and the tick row itself was recorded.
    const { rows: buys } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_transactions WHERE cycle_id = $1 AND type = 'BUY'`,
      [cycle.cycle_id]
    );
    expect(buys[0].n).toBe(controlBuys);
    const { rows: tickRows } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_bot_ticks WHERE cycle_id = $1 AND tick_id = 2`,
      [cycle.cycle_id]
    );
    expect(tickRows[0].n).toBe(1);
  });

  test('a position-limit rejection becomes a position-limit skip; other domain errors stay rejected', async () => {
    const { now } = await setupCycle();
    jest.spyOn(gameRoundService, 'buyRoundTrade')
      .mockRejectedValueOnce(new GameRoundError('Position limit reached: you may hold at most 3 different open live positions and already have 3.', 400))
      .mockRejectedValue(new GameRoundError('Insufficient round cash. You need £10.00 but have £0.00.', 400));
    const result = await botService.runBotTick({ tickId: 1, now });
    expect(result.skipped).toBe(false);
    expect(result.actions.some((a) => a.result === 'skipped' && a.reason === 'position-limit')).toBe(true);
    // Any further buy attempts that tick are plain 'rejected' domain errors.
    const rejected = result.actions.filter((a) => a.result === 'rejected');
    for (const action of rejected) {
      expect(action.reason).toMatch(/Insufficient round cash/);
    }
    const { rows: ledger } = await db.query('SELECT count(*)::int AS n FROM apocalypse_transactions');
    expect(ledger[0].n).toBe(0);
  });
});

describe('V2-4: live builder publishes the same public signals humans get', () => {
  test('buildPublicMarketState phase/momentum/risk match the market-signals endpoint for the same instant', async () => {
    const { cycle, now } = await setupCycle();
    await botService.ensureBotsProvisioned();
    const [bot] = botConfig.BOT_ROSTER;
    const { rows: botUser } = await db.query('SELECT user_id FROM users WHERE username = $1', [bot.username]);
    const participant = await gameRoundService.joinRound({ userId: botUser[0].user_id, now });

    const [state, signals] = await Promise.all([
      botService.buildPublicMarketState({ cycle, participant, now }),
      marketSignalsService.getPublicMarketSignals({ now })
    ]);
    const signalByCoin = new Map(signals.coins.map((c) => [c.coinId, c]));
    expect(state.coins.length).toBe(signals.coins.length);
    for (const coin of state.coins) {
      const signal = signalByCoin.get(coin.coinId);
      expect(signal).toBeDefined();
      expect(coin.phase).toBe(signal.phase);
      expect(coin.momentum).toBe(signal.momentum);
      expect(coin.archetype).toBe(signal.archetype);
      expect(coin.collapseRisk).toBe(signal.collapseRisk);
      expect(coin.recentChangePct).toBe(signal.recentChangePct);
    }
    // The bot's own Power and position slots are part of the shaped state.
    expect(state.power.current).toBe(100); // fresh participant starts at max Power
    expect(state.openPositions).toEqual({ open: 0, max: 3 });
  });

  test('a publicly collapsed coin is shaped DEAD everywhere and can never be a buy candidate', async () => {
    const { cycle, now } = await setupCycle();
    await botService.ensureBotsProvisioned();
    const [bot] = botConfig.BOT_ROSTER;
    const { rows: botUser } = await db.query('SELECT user_id FROM users WHERE username = $1', [bot.username]);
    const participant = await gameRoundService.joinRound({ userId: botUser[0].user_id, now });

    // Execute the first scheduled collapse publicly (Core 3 semantics).
    const { rows: scheduled } = await db.query(
      `SELECT coin_id FROM coin_collapse_schedule WHERE cycle_id = $1 AND executed_at IS NULL ORDER BY collapse_rank LIMIT 1`,
      [cycle.cycle_id]
    );
    const doomedId = scheduled[0].coin_id;
    await db.query(
      `UPDATE coin_collapse_schedule SET executed_at = scheduled_at WHERE cycle_id = $1 AND coin_id = $2`,
      [cycle.cycle_id, doomedId]
    );
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [doomedId]);

    const state = await botService.buildPublicMarketState({ cycle, participant, now });
    const dead = state.coins.find((c) => c.coinId === doomedId);
    expect(dead.collapsed).toBe(true);
    expect(dead.phase).toBe('DEAD');
    expect(dead.collapseRisk).toBe('DEAD');
    expect(dead.momentum).toBe('FLAT');
    expect(dead.recentChangePct).toBeNull();
    for (const strategy of botConfig.BOT_STRATEGIES) {
      const action = botService.decideBotAction({ strategy, marketState: state, random: () => 0 });
      expect(action.coinId).not.toBe(doomedId);
    }
  });
});

describe('V2-4: simulation adapter feeds the real decision layer legally', () => {
  test('a mini bot study runs the real decision layer with contract-verified inputs and deterministic results', () => {
    const studyArgs = { sequences: 2, roundsPerSequence: 2 };
    const first = buildBotReport(runBotStudy(studyArgs));
    expect(first.hiddenInfoEvidence.decisionInputsChecked).toBeGreaterThan(0);
    expect(first.hiddenInfoEvidence.hiddenFieldViolations).toBe(0);
    for (const id of ['BOT_CONSERVATIVE', 'BOT_MOMENTUM', 'BOT_DIP_BUYER', 'BOT_RECKLESS', 'DIP_BOOM']) {
      expect(first.players[id]).toBeDefined();
      expect(first.players[id].roundsPlayed).toBe(4);
      expect(first.players[id].invariantViolations).toBe(0);
      expect(first.players[id].maxOpenPositionsSeen).toBeLessThanOrEqual(3);
      expect(first.players[id].entryPhases.total).toBeGreaterThan(0);
    }
    // Determinism: an identical rerun reproduces the metrics bit-for-bit.
    const second = buildBotReport(runBotStudy(studyArgs));
    for (const id of Object.keys(first.players)) {
      expect(second.players[id].medianFinalCash).toBe(first.players[id].medianFinalCash);
      expect(second.players[id].meanTradesPerRound).toBe(first.players[id].meanTradesPerRound);
    }
    expect(second.hiddenInfoEvidence.decisionInputsChecked)
      .toBe(first.hiddenInfoEvidence.decisionInputsChecked);
  });

  test('the adapter drives real bot decisions through the shared engine trade mechanics', () => {
    // The makeBotStrategy adapter (public observation -> exact bot-shaped
    // state -> real decideBotAction) executes genuine trades under the
    // shared Power/position/cost-basis mechanics — no simulator shortcut.
    const env = createRoundEnvironment({ seed: 'v2-4-adapter-probe-seed', economy: false });
    const context = createRoundContext(env, {});
    const powerDomain = require('../game/powerDomain');
    const powerConfig = powerDomain.resolvePowerConfig({});
    const def = { id: 'PROBE', botStrategy: 'dip_buyer', botKey: 'dip-buyer-dana' };
    const tracker = { decisionInputsChecked: 0, holdReasons: {} };
    const legal = makeBotStrategy(def, env, powerConfig, tracker);
    const result = runRound(context, legal, {
      powerAccount: { power: powerConfig.maxPower, updatedAtMs: 0 },
      maxPositions: powerConfig.maxOpenPositions,
      powerConfig
    });
    expect(result.executedBuys).toBeGreaterThan(0);
    expect(tracker.decisionInputsChecked).toBeGreaterThan(0); // every input contract-verified
    expect(result.cashDrift).toBeLessThanOrEqual(0.01);
    expect(result.basisDrift).toBeLessThanOrEqual(0.01);
  });

  test('a sell attempted at zero Power still executes (engine-level guarantee)', () => {
    const env = createRoundEnvironment({ seed: 'v2-4-zero-power-sell-seed', economy: false });
    const context = createRoundContext(env, {});
    const powerConfig = { maxPower: 5, regenMsPerPoint: 10 * 60 * 60 * 1000, buyCostDivisor: 125, maxOpenPositions: 3 };
    // Scripted client: drain the account with one big buy on the first
    // tick, then sell the position on the next tick while the account sits
    // at zero Power and cannot regenerate.
    const scripted = {
      id: 'ZERO_POWER_SELLER',
      usesFuture: false,
      usesOwnRandom: false,
      decide(observation) {
        if (observation.tickIndex === 0) {
          const coin = observation.coins.find((c) => !c.dead && c.currentPrice > 0.5);
          return [{ action: 'buy', coinId: coin.coinId, spend: 500 }];
        }
        if (observation.tickIndex === 1) {
          const holding = observation.portfolio.holdings[0];
          return holding ? [{ action: 'sell', coinId: holding.coinId, fraction: 1 }] : [];
        }
        return [];
      }
    };
    const result = runRound(context, scripted, {
      powerAccount: { power: 5, updatedAtMs: 0 },
      maxPositions: powerConfig.maxOpenPositions,
      powerConfig
    });
    // The £500 buy costs 1 + floor(500/125) = 5 Power: the account is at 0.
    expect(result.executedBuys).toBe(1);
    expect(result.powerEnd).toBe(0);
    expect(result.zeroPowerSellAttempts).toBe(1);
    expect(result.zeroPowerSellExecuted).toBe(1);
    expect(result.executedSells).toBe(1);
  });
});
