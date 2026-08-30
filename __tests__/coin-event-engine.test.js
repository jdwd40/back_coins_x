// SIM-03: focused unit tests for the pure coin-event engine
// (game/coinEventEngine.js) — no database.
//
// Covered:
//   * generation bounds: 1-15 minute durations inside the cycle window;
//   * the 0-5 active-per-coin cap (including a forced-contention config);
//   * positive/negative coexistence and stacking with the configured cap;
//   * explicit name/direction/strength-category/modifier/start/end/coin
//     identity on every event;
//   * seeded determinism and per-coin/per-seed variation;
//   * expiry: expired/future events never affect the active set or the net
//     modifier;
//   * the configured slight negative long-run expectation over a large
//     deterministic sample (positive contribution 1.00 vs negative
//     1.20-1.30);
//   * config overrides flow through generation (no duplicated magic
//     numbers).

const {
  POSITIVE_EVENT_NAMES,
  NEGATIVE_EVENT_NAMES,
  drawCoinEventAt,
  placeCoinEvent,
  buildCoinEventSchedule,
  buildCycleCoinEvents,
  getActiveEvents,
  netEventModifier
} = require('../game/coinEventEngine');
const {
  COIN_EVENT_STRENGTH_IDS,
  DEFAULT_SIMULATION_CONFIG,
  resolveSimulationConfig
} = require('../game/simulationConfig');

const START = new Date('2026-08-30T10:00:00.000Z');
const END = new Date('2026-08-30T10:30:00.000Z'); // the 30-minute default cycle
const SEED = 'coin-event-engine-test-seed';

function concurrencySweep(events, cap, stepMs = 15000) {
  let maxSeen = 0;
  for (let t = START.getTime(); t < END.getTime(); t += stepMs) {
    const active = getActiveEvents(events, new Date(t)).length;
    if (active > cap) {
      throw new Error(`cap exceeded at ${new Date(t).toISOString()}: ${active} > ${cap}`);
    }
    maxSeen = Math.max(maxSeen, active);
  }
  return maxSeen;
}

describe('coin event generation: shape and bounds', () => {
  const events = buildCoinEventSchedule({ seed: SEED, coinId: 1, startTime: START, endTime: END });

  test('generates a non-empty schedule with explicit identity fields', () => {
    expect(events.length).toBeGreaterThan(0);
    for (const ev of events) {
      expect(ev.coin_id).toBe(1);
      expect(Number.isInteger(ev.event_seq)).toBe(true);
      expect(ev.event_seq).toBeGreaterThanOrEqual(1);
      expect(typeof ev.name).toBe('string');
      expect(ev.name.length).toBeGreaterThan(0);
      expect(['POSITIVE', 'NEGATIVE']).toContain(ev.direction);
      expect(COIN_EVENT_STRENGTH_IDS).toContain(ev.strength_category);
      expect(typeof ev.modifier).toBe('number');
      expect(Number.isFinite(ev.modifier)).toBe(true);
      expect(ev.starts_at).toBeInstanceOf(Date);
      expect(ev.ends_at).toBeInstanceOf(Date);
    }
    // Sequence numbers are dense per coin: 1..N in generation order.
    expect(events.map((e) => e.event_seq)).toEqual(events.map((_, i) => i + 1));
  });

  test('names come from the direction-appropriate flavour pool', () => {
    for (const ev of events) {
      if (ev.direction === 'POSITIVE') expect(POSITIVE_EVENT_NAMES).toContain(ev.name);
      else expect(NEGATIVE_EVENT_NAMES).toContain(ev.name);
    }
  });

  test('every duration is within the configured 1-15 minute band and starts inside the window', () => {
    const { durationMs } = DEFAULT_SIMULATION_CONFIG.coinEvents;
    for (const ev of events) {
      const duration = ev.ends_at.getTime() - ev.starts_at.getTime();
      expect(duration).toBeGreaterThanOrEqual(durationMs.min);
      expect(duration).toBeLessThanOrEqual(durationMs.max);
      expect(ev.starts_at.getTime()).toBeGreaterThanOrEqual(START.getTime());
      expect(ev.starts_at.getTime()).toBeLessThan(END.getTime());
      expect(ev.ends_at.getTime()).toBeGreaterThan(ev.starts_at.getTime());
    }
  });

  test('modifier sign always matches direction and magnitudes stay inside the category bands', () => {
    const { strengthRanges, negativeBiasFactor } = DEFAULT_SIMULATION_CONFIG.coinEvents;
    for (const ev of events) {
      const range = strengthRanges[ev.strength_category];
      const magnitude = Math.abs(ev.modifier);
      if (ev.direction === 'POSITIVE') {
        expect(ev.modifier).toBeGreaterThan(0);
        expect(magnitude).toBeGreaterThanOrEqual(range.min - 1e-12);
        expect(magnitude).toBeLessThanOrEqual(range.max + 1e-12);
      } else {
        expect(ev.modifier).toBeLessThan(0);
        // Negative magnitudes are scaled by the configured bias factor.
        expect(magnitude).toBeGreaterThanOrEqual(range.min * negativeBiasFactor - 1e-12);
        expect(magnitude).toBeLessThanOrEqual(range.max * negativeBiasFactor + 1e-12);
      }
    }
  });

  test('at most 5 events are active per coin at any instant (exhaustive sweep)', () => {
    const cap = DEFAULT_SIMULATION_CONFIG.coinEvents.maxActivePerCoin;
    const maxSeen = concurrencySweep(events, cap);
    expect(maxSeen).toBeLessThanOrEqual(cap);
  });

  test('zero active events is possible (the first gap before the first event)', () => {
    expect(getActiveEvents(events, START)).toHaveLength(0);
  });
});

describe('coin event generation: seeded determinism and variation', () => {
  test('same seed + coin + window reproduces the identical schedule', () => {
    const a = buildCoinEventSchedule({ seed: SEED, coinId: 3, startTime: START, endTime: END });
    const b = buildCoinEventSchedule({ seed: SEED, coinId: 3, startTime: START, endTime: END });
    expect(b).toEqual(a);
  });

  test('different coins of the same cycle get different events', () => {
    const a = buildCoinEventSchedule({ seed: SEED, coinId: 1, startTime: START, endTime: END });
    const b = buildCoinEventSchedule({ seed: SEED, coinId: 2, startTime: START, endTime: END });
    const strip = (rows) => rows.map(({ coin_id, ...rest }) => rest);
    expect(strip(b)).not.toEqual(strip(a));
  });

  test('different seeds produce different schedules', () => {
    const a = buildCoinEventSchedule({ seed: 'seed-a', coinId: 1, startTime: START, endTime: END });
    const b = buildCoinEventSchedule({ seed: 'seed-b', coinId: 1, startTime: START, endTime: END });
    expect(b).not.toEqual(a);
  });

  test('drawCoinEventAt is a pure per-sequence draw (no Math.random anywhere)', () => {
    const a = drawCoinEventAt({ seed: SEED, coinId: 1, eventSeq: 4 });
    const b = drawCoinEventAt({ seed: SEED, coinId: 1, eventSeq: 4 });
    expect(b).toEqual(a);
    // Different sequence, coin or seed -> different draws.
    expect(drawCoinEventAt({ seed: SEED, coinId: 1, eventSeq: 5 })).not.toEqual(a);
    expect(drawCoinEventAt({ seed: SEED, coinId: 2, eventSeq: 4 })).not.toEqual(a);
    expect(drawCoinEventAt({ seed: 'other', coinId: 1, eventSeq: 4 })).not.toEqual(a);
    // Every field honours the configured bands.
    const ce = DEFAULT_SIMULATION_CONFIG.coinEvents;
    for (let seq = 1; seq <= 200; seq++) {
      const d = drawCoinEventAt({ seed: SEED, coinId: 1, eventSeq: seq });
      expect(d.gapMs).toBeGreaterThanOrEqual(ce.arrivalGapMs.min);
      expect(d.gapMs).toBeLessThanOrEqual(ce.arrivalGapMs.max);
      expect(d.durationMs).toBeGreaterThanOrEqual(ce.durationMs.min);
      expect(d.durationMs).toBeLessThanOrEqual(ce.durationMs.max);
      expect(['POSITIVE', 'NEGATIVE']).toContain(d.direction);
      expect(COIN_EVENT_STRENGTH_IDS).toContain(d.strengthCategory);
      if (d.direction === 'POSITIVE') expect(POSITIVE_EVENT_NAMES).toContain(d.name);
      else expect(NEGATIVE_EVENT_NAMES).toContain(d.name);
    }
    expect(() => drawCoinEventAt({ seed: SEED, coinId: 1, eventSeq: 0 })).toThrow(/positive integer/);
  });

  test('placeCoinEvent places exactly after the gap and postpones without redrawing at the cap', () => {
    const drawn = {
      gapMs: 60000,
      durationMs: 300000,
      direction: 'NEGATIVE',
      strengthCategory: 'EXTREME',
      name: 'Network Outage',
      modifier: -0.0625
    };
    const base = START.getTime();
    const placed = placeCoinEvent({
      drawn, coinId: 1, eventSeq: 1, baseStartMs: base, priorEvents: [], endMs: END.getTime()
    });
    expect(placed.startMs).toBe(base + 60000);
    expect(placed.endMs).toBe(base + 60000 + 300000);
    expect(placed).toMatchObject({
      coin_id: 1, event_seq: 1, name: 'Network Outage', direction: 'NEGATIVE',
      strength_category: 'EXTREME', modifier: -0.0625
    });

    // Five long events already occupy the cap window: the sixth (same draw)
    // is postponed to the earliest expiry, keeping its full duration.
    const cap = DEFAULT_SIMULATION_CONFIG.coinEvents.maxActivePerCoin;
    const priors = [];
    for (let i = 0; i < cap; i++) {
      priors.push({ startMs: base + i * 1000, endMs: base + i * 1000 + 900000 });
    }
    const postponed = placeCoinEvent({
      drawn, coinId: 1, eventSeq: cap + 1, baseStartMs: base, priorEvents: priors, endMs: END.getTime()
    });
    expect(postponed.startMs).toBe(base + 900000); // the earliest expiry
    expect(postponed.endMs).toBe(base + 900000 + 300000);

    // No room left before the window end: null, never a squashed event.
    const noRoom = placeCoinEvent({
      drawn: { ...drawn, gapMs: 31 * 60000 }, coinId: 1, eventSeq: 2,
      baseStartMs: base, priorEvents: [], endMs: END.getTime()
    });
    expect(noRoom).toBeNull();
  });

  test('buildCycleCoinEvents canonicalises coin order (input order irrelevant)', () => {
    const a = buildCycleCoinEvents({ seed: SEED, coinIds: [3, 1, 2], startTime: START, endTime: END });
    const b = buildCycleCoinEvents({ seed: SEED, coinIds: [1, 2, 3], startTime: START, endTime: END });
    expect(b).toEqual(a);
    // Canonical (coin_id, event_seq) ordering.
    for (let i = 1; i < a.length; i++) {
      const prev = a[i - 1];
      const cur = a[i];
      expect(cur.coin_id > prev.coin_id || (cur.coin_id === prev.coin_id && cur.event_seq > prev.event_seq)).toBe(true);
    }
    expect(new Set(a.map((e) => e.coin_id))).toEqual(new Set([1, 2, 3]));
  });

  test('rejects an inverted window and a non-numeric coin id', () => {
    expect(() => buildCoinEventSchedule({ seed: SEED, coinId: 1, startTime: END, endTime: START })).toThrow(/endTime after startTime/);
    expect(() => buildCoinEventSchedule({ seed: SEED, coinId: 'x', startTime: START, endTime: END })).toThrow(/coinId/);
  });
});

describe('coin event cap under contention', () => {
  test('a forced-contention config (tiny gaps, cap 2) never exceeds the cap and keeps durations', () => {
    const config = resolveSimulationConfig({
      coinEvents: {
        maxActivePerCoin: 2,
        arrivalGapMs: { min: 30 * 1000, max: 60 * 1000 }
      }
    });
    const events = buildCoinEventSchedule({ seed: SEED, coinId: 7, startTime: START, endTime: END, config });
    expect(events.length).toBeGreaterThan(0);
    concurrencySweep(events, 2, 5000);
    const { durationMs } = config.coinEvents;
    for (const ev of events) {
      const duration = ev.ends_at.getTime() - ev.starts_at.getTime();
      expect(duration).toBeGreaterThanOrEqual(durationMs.min);
      expect(duration).toBeLessThanOrEqual(durationMs.max);
    }
    // Postponement is deterministic too.
    const again = buildCoinEventSchedule({ seed: SEED, coinId: 7, startTime: START, endTime: END, config });
    expect(again).toEqual(events);
  });
});

describe('coin event stacking and expiry', () => {
  test('positive and negative events coexist and stack', () => {
    // Over enough coins, some instant has both directions active at once.
    let coexisted = false;
    for (let coinId = 1; coinId <= 10 && !coexisted; coinId++) {
      const events = buildCoinEventSchedule({ seed: SEED, coinId, startTime: START, endTime: END });
      for (let t = START.getTime(); t < END.getTime() && !coexisted; t += 10000) {
        const active = getActiveEvents(events, new Date(t));
        const directions = new Set(active.map((e) => e.direction));
        if (directions.size === 2) coexisted = true;
      }
    }
    expect(coexisted).toBe(true);
  });

  test('expired and future events never affect the active set', () => {
    const events = buildCoinEventSchedule({ seed: SEED, coinId: 5, startTime: START, endTime: END });
    const first = events[0];
    // One ms before it starts: inactive. During: active. At its end: expired.
    expect(getActiveEvents(events, new Date(first.starts_at.getTime() - 1))).toHaveLength(0);
    expect(getActiveEvents(events, new Date(first.starts_at.getTime()))).toContainEqual(first);
    expect(getActiveEvents(events, first.ends_at)).not.toContainEqual(first);
    // Long after the cycle: nothing is active.
    expect(getActiveEvents(events, new Date(END.getTime() + 60 * 60 * 1000))).toHaveLength(0);
  });

  test('the net stacked modifier is capped at the configured bound', () => {
    const config = DEFAULT_SIMULATION_CONFIG;
    const cap = config.coinEvents.maxStackedModifier;
    const now = new Date('2026-08-30T10:05:00.000Z');
    const mk = (modifier) => ({
      coin_id: 1,
      event_seq: 0,
      name: 'Synthetic',
      direction: modifier > 0 ? 'POSITIVE' : 'NEGATIVE',
      strength_category: 'EXTREME',
      modifier,
      starts_at: new Date(now.getTime() - 60000),
      ends_at: new Date(now.getTime() + 60000)
    });
    // Five simultaneous extreme events of one sign would sum far past the cap.
    const positives = [0.05, 0.05, 0.05, 0.05, 0.05].map(mk);
    expect(netEventModifier(positives, now, config)).toBeCloseTo(cap, 12);
    const negatives = [-0.0625, -0.0625, -0.0625, -0.0625, -0.0625].map(mk);
    expect(netEventModifier(negatives, now, config)).toBeCloseTo(-cap, 12);
    // Mixed stacking sums before clamping.
    const mixed = [0.02, 0.01, -0.03].map(mk);
    expect(netEventModifier(mixed, now, config)).toBeCloseTo(0, 12);
    // Expired events contribute nothing.
    const expired = [{
      ...mk(0.05),
      starts_at: new Date(now.getTime() - 10 * 60000),
      ends_at: new Date(now.getTime() - 60000)
    }];
    expect(netEventModifier(expired, now, config)).toBe(0);
  });
});

describe('coin event long-run expectation (Rule 1: slight negative drain)', () => {
  test('negative contribution outweighs positive within the configured 1.20-1.30 band over a large deterministic sample', () => {
    let positiveTotal = 0;
    let negativeTotal = 0;
    let count = 0;
    // 40 seeds x 10 coins x a full 30-minute cycle each: thousands of
    // events, fully deterministic.
    for (let s = 0; s < 40; s++) {
      const seed = `bias-sample-${s}`;
      for (let coinId = 1; coinId <= 10; coinId++) {
        for (const ev of buildCoinEventSchedule({ seed, coinId, startTime: START, endTime: END })) {
          count += 1;
          if (ev.direction === 'POSITIVE') positiveTotal += ev.modifier;
          else negativeTotal += -ev.modifier;
        }
      }
    }
    expect(count).toBeGreaterThan(4000);
    expect(positiveTotal).toBeGreaterThan(0);
    expect(negativeTotal).toBeGreaterThan(0);
    const ratio = negativeTotal / positiveTotal;
    expect(ratio).toBeGreaterThanOrEqual(1.20);
    expect(ratio).toBeLessThanOrEqual(1.30);
  });

  test('both directions keep occurring (the bias is strength, not event counts)', () => {
    let positives = 0;
    let negatives = 0;
    for (let coinId = 1; coinId <= 10; coinId++) {
      for (const ev of buildCoinEventSchedule({ seed: SEED, coinId, startTime: START, endTime: END })) {
        if (ev.direction === 'POSITIVE') positives += 1;
        else negatives += 1;
      }
    }
    expect(positives).toBeGreaterThan(0);
    expect(negatives).toBeGreaterThan(0);
  });
});
