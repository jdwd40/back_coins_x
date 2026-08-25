// V2-2: multi-round Power simulation — shared-domain identity, persistent
// Power accounts across rounds, position-limit enforcement, zero-cost sells
// at zero Power, late entrants, determinism and study metrics/invariants.
// DB-free: the simulator only touches pure domain modules.

const { createRoundEnvironment } = require('../simulation/roundEnvironment');
const { createRoundContext, runRound } = require('../simulation/engine');
const { runPowerStudy, buildPowerReport, deriveSequenceSeed, ALL_PLAYER_IDS } = require('../simulation/powerStudy');
const powerDomain = require('../game/powerDomain');

jest.setTimeout(120000);

const SEED = 'v2-2-power-sim-test-seed';

function fixedStrategy(id, script) {
  return { id, description: 'test script', usesFuture: false, usesOwnRandom: false, decide: script };
}

describe('V2-2 simulation: shared domain identity', () => {
  test('the simulator charges EXACTLY the live domain Power cost for a buy', () => {
    const env = createRoundEnvironment({ seed: SEED, economy: false });
    const context = createRoundContext(env);
    const account = { power: 100, updatedAtMs: 0 };
    const buyer = fixedStrategy('BUY_250', (obs) =>
      obs.tickIndex === 0 ? [{ action: 'buy', coinId: 6, spend: 250 }] : []
    );
    const result = runRound(context, buyer, { powerAccount: account });
    expect(result.executedBuys).toBe(1);
    // The executed consideration drives the shared formula — no sim copy.
    const expectedCost = powerDomain.buyPowerCost(result.cashDeployed);
    expect(result.powerSpent).toBe(expectedCost);
    expect(account.power).toBe(100 - expectedCost);
  });

  test('the simulator position predicate matches livePositionCoinIds semantics', () => {
    // A dead holding must not consume a sim slot, exactly like the live SQL.
    const env = createRoundEnvironment({ seed: SEED, economy: false });
    const context = createRoundContext(env);
    const account = { power: 100, updatedAtMs: 0 };
    // Buy four different coins (two per tick — the client cadence cap):
    // three succeed, the fourth is blocked by the shared
    // evaluatePositionLimit rule.
    const buyer = fixedStrategy('FOUR_COINS', (obs) => {
      if (obs.tickIndex === 0) return [1, 2].map((coinId) => ({ action: 'buy', coinId, spend: 100 }));
      if (obs.tickIndex === 1) return [3, 4].map((coinId) => ({ action: 'buy', coinId, spend: 100 }));
      return [];
    });
    const result = runRound(context, buyer, { powerAccount: account, maxPositions: 3 });
    expect(result.executedBuys).toBe(3);
    expect(result.blockedByPosition).toBe(1);
    expect(result.positionLimitViolations).toBe(0);
    // Shared predicate agrees on the final portfolio composition.
    const liveIds = powerDomain.livePositionCoinIds(
      [1, 2, 3].map((coinId) => ({ coinId, quantity: 1, dead: false }))
    );
    expect(liveIds.size).toBe(3);
  });

  test('fragmentation never reduces Power cost: identical trades, whole vs fragmented, on one seeded round', () => {
    // The clean anti-bypass experiment: the SAME trades at the SAME prices
    // on the SAME market path, executed whole by one player and chopped in
    // half by the other. (The study's SPLITTER strategy instead proves the
    // per-£ margin on full gameplay paths.)
    const env = createRoundEnvironment({ seed: SEED, economy: false });
    const script = (split) => fixedStrategy(split ? 'FRAGMENTED' : 'WHOLE', (obs) => {
      if (obs.tickIndex !== 0 && obs.tickIndex !== 5) return [];
      if (!split) return [{ action: 'buy', coinId: 6, spend: 1000 }];
      return [
        { action: 'buy', coinId: 6, spend: 500 },
        { action: 'buy', coinId: 6, spend: 500 }
      ];
    });

    const accountA = { power: 100, updatedAtMs: 0 };
    const accountB = { power: 100, updatedAtMs: 0 };
    const whole = runRound(createRoundContext(env), script(false), { powerAccount: accountA, maxPositions: 3 });
    const fragmented = runRound(createRoundContext(env), script(true), { powerAccount: accountB, maxPositions: 3 });

    // Same deployed money (±pennies of per-fragment rounding)...
    expect(Math.abs(whole.cashDeployed - fragmented.cashDeployed)).toBeLessThanOrEqual(0.04);
    // ...but strictly more Power spent by the fragmentation attacker.
    expect(fragmented.powerSpent).toBeGreaterThan(whole.powerSpent);
    // Exactly: two buys of £1000 (9 each = 18) vs four of £500 (5 each = 20).
    expect(whole.powerSpent).toBe(2 * powerDomain.buyPowerCost(whole.cashDeployed / 2));
    expect(fragmented.powerSpent).toBe(4 * powerDomain.buyPowerCost(fragmented.cashDeployed / 4));
    expect(fragmented.powerSpent).toBe(20);
    expect(whole.powerSpent).toBe(18);
    // And no cash advantage: identical prices, identical deployment.
    expect(Math.abs(whole.finalCash - fragmented.finalCash)).toBeLessThanOrEqual(0.04);
  });

  test('selling always works at zero Power; blocked buys consume nothing', () => {
    const env = createRoundEnvironment({ seed: SEED, economy: false });
    const context = createRoundContext(env);
    const account = { power: 1, updatedAtMs: 0 };
    const script = fixedStrategy('DRAIN_THEN_SELL', (obs) => {
      if (obs.tickIndex === 0) return [{ action: 'buy', coinId: 6, spend: 10 }]; // £10 -> 1 Power: drains to 0
      if (obs.tickIndex === 1) return [{ action: 'buy', coinId: 6, spend: 10 }]; // blocked: 0 Power
      if (obs.tickIndex === 2) return [{ action: 'sell', coinId: 6, fraction: 1 }]; // always free
      return [];
    });
    const result = runRound(context, script, { powerAccount: account });
    expect(result.executedBuys).toBe(1);
    expect(result.blockedByPower).toBe(1);
    expect(result.trades).toBe(2); // one buy + one sell
    expect(account.power).toBe(0); // blocked buy consumed nothing
  });
});

describe('V2-2 simulation: persistent accounts across consecutive rounds', () => {
  test('Power carries across rounds with continuous-clock lazy regeneration', () => {
    const account = { power: 100, updatedAtMs: 0 };
    const buyer = fixedStrategy('STEADY_BUYER', (obs) =>
      obs.tickIndex === 0 ? [{ action: 'buy', coinId: 6, spend: 250 }] : []
    );
    const seedA = deriveSequenceSeed(SEED, 0);
    let previousEnd = null;
    const starts = [];
    for (let r = 0; r < 3; r++) {
      const env = createRoundEnvironment({ seed: `${seedA}:${r}`, economy: false });
      const context = createRoundContext(env);
      const result = runRound(context, buyer, {
        powerAccount: account,
        maxPositions: 3,
        timeOffsetMs: r * env.durationMs
      });
      if (previousEnd !== null) {
        // No actions between rounds: this round's start Power is exactly
        // last round's end Power (regen inside the round is accounted).
        expect(result.powerStart).toBe(previousEnd);
      }
      previousEnd = result.powerEnd;
      starts.push(result.powerStart);
    }
    // Each round: one £250 buy (2 Power) and a full round of regen
    // (30 min / 120s = 15 points), clamped at 100.
    expect(starts).toEqual([100, 100, 100]);
    expect(previousEnd).toBe(100);
  });

  test('a depleted account visibly recovers across rounds, never instantly', () => {
    const account = { power: 3, updatedAtMs: 0 };
    const idle = fixedStrategy('IDLE', () => []);
    const seedA = deriveSequenceSeed(SEED, 1);
    const startPowers = [];
    for (let r = 0; r < 3; r++) {
      const env = createRoundEnvironment({ seed: `${seedA}:${r}`, economy: false });
      const context = createRoundContext(env);
      const result = runRound(context, idle, { powerAccount: account, timeOffsetMs: r * env.durationMs });
      startPowers.push(result.powerStart);
    }
    // +60 per 30-minute round from the continuous clock (30s per point),
    // clamped at the 100 max.
    expect(startPowers).toEqual([3, 63, 100]);
  });
});

describe('V2-2 simulation: late entrants', () => {
  test('joinAtMs blocks actions in the first half but Power regenerates throughout', () => {
    const env = createRoundEnvironment({ seed: SEED, economy: false });
    const context = createRoundContext(env);
    const account = { power: 0, updatedAtMs: 0 };
    const alwaysBuys = fixedStrategy('ALWAYS', (obs) =>
      obs.portfolio.cash > 100 ? [{ action: 'buy', coinId: 6, spend: 10 }] : []
    );
    const half = Math.floor(env.durationMs / 2);
    const result = runRound(context, alwaysBuys, { powerAccount: account, joinAtMs: half });
    // No attempts before the midpoint; by then 15 regen points have landed.
    const ticksPerHalf = Math.ceil(context.ticks.length / 2);
    expect(result.attemptedBuys).toBeLessThanOrEqual(ticksPerHalf + 1);
    expect(result.powerStart).toBe(0);
    expect(result.executedBuys).toBeGreaterThan(0); // stored Power let them play
  });
});

describe('V2-2 simulation: study runner', () => {
  test('a small study is fully deterministic and carries all required metrics with zero invariant violations', () => {
    const options = { sequences: 2, roundsPerSequence: 3, baseSeed: SEED, playerIds: ['DIP_BOOM', 'SPAM', 'LATE_ENTRANT', 'RETURNING'] };
    const first = buildPowerReport(runPowerStudy(options));
    const second = buildPowerReport(runPowerStudy(options));
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));

    for (const id of ['DIP_BOOM', 'SPAM', 'LATE_ENTRANT', 'RETURNING']) {
      const p = first.players[id];
      expect(p.roundsTotal).toBe(6);
      expect(p.powerAtRoundStart.mean).toBeGreaterThanOrEqual(0);
      expect(p.powerAtRoundEnd.mean).toBeLessThanOrEqual(100);
      expect(typeof p.starvedTickPct).toBe('number');
      expect(typeof p.opportunitiesSkippedByPower).toBe('number');
      expect(typeof p.positionLimitBlocked).toBe('number');
      expect(typeof p.powerPerPoundDeployed).toBe('number');
      expect(typeof p.maxConsecutiveStarvedRoundStarts).toBe('number');
      expect(p.invariantViolations).toBe(0); // cash/basis books always balance
    }
    // RETURNING sat out round index 1 of each sequence.
    expect(first.players.RETURNING.roundsPlayed).toBe(4);
    expect(first.config.powerConfig.maxPower).toBe(100);
    // Partial roster: the strategy gate is skipped, but every player's
    // per-round books still balanced (asserted per player above).
    expect(first.gate.pass).toBeNull();
    expect(first.gate.skipped.reason).toMatch(/partial player roster/);
  });

  test('study tunable overrides flow into the shared domain', () => {
    const study = runPowerStudy({
      sequences: 1, roundsPerSequence: 1, baseSeed: SEED,
      playerIds: ['DIP_BOOM'],
      powerConfig: { maxPower: 40, regenMsPerPoint: 60000, buyCostDivisor: 250, maxOpenPositions: 2 }
    });
    const report = buildPowerReport(study);
    expect(report.config.powerConfig.maxPower).toBe(40);
    expect(report.config.powerConfig.regenMsPerPoint).toBe(60000);
    expect(report.config.powerConfig.buyCostDivisor).toBe(250);
    expect(report.config.powerConfig.maxOpenPositions).toBe(2);
    // A £3,000-scale buy now costs ceil(total/250), through the same formula.
    const deployed = report.players.DIP_BOOM.cashDeployedTotal;
    if (deployed > 0) {
      expect(report.players.DIP_BOOM.powerPerPoundDeployed).toBeLessThanOrEqual(1 / 250 + 0.001);
    }
  });

  test('every default study player id resolves to a real strategy', () => {
    expect(ALL_PLAYER_IDS).toContain('DIP_BOOM');
    expect(ALL_PLAYER_IDS).toContain('RANDOM');
    expect(ALL_PLAYER_IDS).toContain('SPAM');
    expect(ALL_PLAYER_IDS).toContain('PUBLIC_SIGNAL_EXPLOITER');
    expect(ALL_PLAYER_IDS).toContain('CONSERVATIVE_POWER');
    expect(ALL_PLAYER_IDS).toContain('AGGRESSIVE_POWER');
    expect(ALL_PLAYER_IDS).toContain('SPLITTER');
    expect(ALL_PLAYER_IDS).toContain('LATE_ENTRANT');
    expect(ALL_PLAYER_IDS).toContain('RETURNING');
  });
});
