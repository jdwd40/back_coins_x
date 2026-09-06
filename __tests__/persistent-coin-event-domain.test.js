// Director Coin Events Wave 1: pure persistent coin-event domain helpers
// (game/persistentCoinEventDomain.js).
//
// Pure tests: no database access, no clock, no Math.random(). The helpers
// operate on plain event records (database rows or pure fixtures) with an
// INJECTED `now` — activity, the exact signed net modifier, the stack cap
// and the active direction counts are all pure functions of their inputs.

const {
  filterActiveEvents,
  netActiveModifierExact,
  capNetModifier,
  netActiveModifierCapped,
  activeCapacityVerdict,
  activeDirectionCounts
} = require('../game/persistentCoinEventDomain');
const { resolveSimulationConfig } = require('../game/simulationConfig');

const BASE = new Date('2026-09-01T00:00:00Z');
const MINUTE = 60 * 1000;
const at = (minutes) => new Date(BASE.getTime() + minutes * MINUTE);

// Exact binary fractions (2^-5, 2^-6, 2^-7) so "exact signed value"
// assertions are bit-exact, not approximate.
function ev({ coinId = 1, eventSeq = 1, startsAt, endsAt, modifier, direction }) {
  return {
    coin_id: coinId,
    event_seq: eventSeq,
    name: 'Test Event',
    direction,
    source: 'NORMAL',
    modifier,
    starts_at: startsAt,
    ends_at: endsAt
  };
}

// The persisted MODEL event shape (camelCase — the rowToEvent output of
// models/persistentCoinEvents.model.js).
function modelEv({ coinId = 1, eventSeq = 1, startsAt, endsAt, modifier, direction }) {
  return {
    eventId: 100 + eventSeq,
    worldId: 1,
    coinId,
    eventSeq,
    name: 'Test Event',
    direction,
    source: 'NORMAL',
    modifier,
    startsAt,
    endsAt,
    createdAt: BASE
  };
}

describe('persistent coin-event domain: activity windows', () => {
  test('an event is active exactly when starts_at <= now < ends_at', () => {
    const events = [
      ev({ startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),   // active
      ev({ startsAt: at(-10), endsAt: at(0), modifier: 0.03125, direction: 'POSITIVE' }), // expired AT now
      ev({ startsAt: at(1), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' })    // future
    ];
    const active = filterActiveEvents(events, BASE);
    expect(active).toHaveLength(1);
    expect(active[0].event_seq).toBe(1);
  });

  test('expired history is preserved in the input but excluded from the active set', () => {
    const expired = ev({ startsAt: at(-20), endsAt: at(-5), modifier: -0.015625, direction: 'NEGATIVE' });
    const events = [expired, ev({ eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' })];
    const active = filterActiveEvents(events, at(2));
    expect(active).toHaveLength(1);
    expect(events).toHaveLength(2); // the helper never mutates its input
    expect(active[0].modifier).toBe(0.03125);
  });

  test('the active set is canonically ordered (starts_at, coin_id, event_seq)', () => {
    const events = [
      ev({ coinId: 2, eventSeq: 1, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ coinId: 1, eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ coinId: 1, eventSeq: 1, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' })
    ];
    const active = filterActiveEvents(events, at(1));
    expect(active.map((e) => [e.coin_id, e.event_seq])).toEqual([[1, 1], [1, 2], [2, 1]]);
  });

  test('an invalid injected timestamp fails loudly (no hidden wall-clock)', () => {
    expect(() => filterActiveEvents([], 'not-a-date')).toThrow(/now/);
    expect(() => netActiveModifierExact([], 'not-a-date')).toThrow(/now/);
  });
});

describe('persistent coin-event domain: net modifier', () => {
  test('the exact signed net of active events is computed BEFORE any cap', () => {
    const events = [
      ev({ startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: -0.015625, direction: 'NEGATIVE' }),
      ev({ eventSeq: 3, startsAt: at(0), endsAt: at(5), modifier: 0.0078125, direction: 'POSITIVE' })
    ];
    expect(netActiveModifierExact(events, at(1))).toBe(0.0234375);
  });

  test('numeric modifiers returned as strings by node-pg are parsed exactly', () => {
    const events = [
      ev({ startsAt: at(0), endsAt: at(5), modifier: '0.03125', direction: 'POSITIVE' }),
      ev({ eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: '-0.015625', direction: 'NEGATIVE' })
    ];
    expect(netActiveModifierExact(events, at(1))).toBe(0.015625);
  });

  test('the stack cap bounds the net modifier symmetrically at the configured limit', () => {
    const config = resolveSimulationConfig();
    const cap = config.persistentEvents.maxNetModifier;
    const big = [
      ev({ startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 3, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' })
    ];
    // Exact net 0.09375 exceeds the 0.06 cap; the capped value is the cap.
    expect(netActiveModifierExact(big, at(1))).toBe(0.09375);
    expect(netActiveModifierCapped(big, at(1))).toBe(cap);

    const bigNegative = big.map((e) => ({ ...e, modifier: -e.modifier, direction: 'NEGATIVE' }));
    expect(netActiveModifierCapped(bigNegative, at(1))).toBe(-cap);

    const within = [ev({ startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' })];
    expect(netActiveModifierCapped(within, at(1))).toBe(0.03125);
  });

  test('capNetModifier clamps a raw signed value and validates it', () => {
    expect(capNetModifier(0.5)).toBe(0.06);
    expect(capNetModifier(-0.5)).toBe(-0.06);
    expect(capNetModifier(0.02)).toBe(0.02);
    expect(capNetModifier(0)).toBe(0);
    const overridden = resolveSimulationConfig({ persistentEvents: { maxNetModifier: 0.07 } });
    expect(capNetModifier(0.5, overridden)).toBe(0.07);
    expect(() => capNetModifier('0.5')).toThrow(/finite number/);
  });
});

describe('persistent coin-event domain: active direction counts', () => {
  test('counts active positive/negative events for the direction caps', () => {
    const events = [
      ev({ startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 3, startsAt: at(0), endsAt: at(5), modifier: -0.015625, direction: 'NEGATIVE' }),
      ev({ eventSeq: 4, startsAt: at(-10), endsAt: at(-1), modifier: 0.03125, direction: 'POSITIVE' }) // expired
    ];
    expect(activeDirectionCounts(events, at(1))).toEqual({ positive: 2, negative: 1, total: 3 });
    expect(activeDirectionCounts([], at(1))).toEqual({ positive: 0, negative: 0, total: 0 });
  });
});

describe('persistent coin-event domain: persisted model event shape', () => {
  test('model-shaped (camelCase) records pipe through every pure helper', () => {
    // Regression: the model returns startsAt/endsAt/coinId/eventSeq; piping
    // listActivePersistentCoinEvents() output into the pure helpers must
    // work exactly like raw snake_case rows.
    const modelEvents = [
      modelEv({ startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      modelEv({ eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: -0.015625, direction: 'NEGATIVE' }),
      modelEv({ eventSeq: 3, startsAt: at(-10), endsAt: at(-1), modifier: 0.0078125, direction: 'POSITIVE' }) // expired
    ];
    const before = modelEvents.map((e) => JSON.stringify(e));

    const active = filterActiveEvents(modelEvents, at(1));
    expect(active).toHaveLength(2);
    expect(active.map((e) => e.eventSeq)).toEqual([1, 2]);
    expect(netActiveModifierExact(modelEvents, at(1))).toBe(0.015625);
    expect(netActiveModifierCapped(modelEvents, at(1))).toBe(0.015625);
    expect(activeDirectionCounts(modelEvents, at(1))).toEqual({ positive: 1, negative: 1, total: 2 });

    // The helpers never mutate their input records.
    expect(modelEvents.map((e) => JSON.stringify(e))).toEqual(before);
  });

  test('model-shaped and row-shaped records mix in one canonical active set', () => {
    const mixed = [
      modelEv({ coinId: 2, eventSeq: 1, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ coinId: 1, eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: -0.015625, direction: 'NEGATIVE' }),
      modelEv({ coinId: 1, eventSeq: 1, startsAt: at(0), endsAt: at(5), modifier: 0.0078125, direction: 'POSITIVE' })
    ];
    const active = filterActiveEvents(mixed, at(1));
    expect(active.map((e) => [e.coinId ?? e.coin_id, e.eventSeq ?? e.event_seq]))
      .toEqual([[1, 1], [1, 2], [2, 1]]);
    expect(netActiveModifierExact(mixed, at(1))).toBe(0.0234375);
  });

  test('a model-shaped record missing a window field fails loudly, not silently', () => {
    const broken = [{ coinId: 1, eventSeq: 1, direction: 'POSITIVE', modifier: 0.03125 }];
    expect(() => filterActiveEvents(broken, at(1))).toThrow(/starts_at|startsAt/);
  });
});

describe('persistent coin-event domain: active capacity verdict', () => {
  // Small deterministic caps so the concurrency edges are explicit.
  const config = resolveSimulationConfig({
    persistentEvents: {
      maxActivePerCoin: 3,
      maxActivePositivePerCoin: 2,
      maxActiveNegativePerCoin: 2
    }
  });
  const candidate = (overrides = {}) => ({
    direction: 'POSITIVE',
    startsAt: at(10),
    endsAt: at(15),
    ...overrides
  });

  test('admission is allowed exactly up to the configured total cap', () => {
    const two = [
      ev({ eventSeq: 1, startsAt: at(9), endsAt: at(20), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 2, startsAt: at(9), endsAt: at(20), modifier: -0.015625, direction: 'NEGATIVE' })
    ];
    const verdict = activeCapacityVerdict(two, candidate(), config);
    expect(verdict.allowed).toBe(true);
    expect(verdict.peak).toEqual({ total: 3, positive: 2, negative: 1 });
  });

  test('the candidate that would exceed the total cap at any instant of its window is rejected', () => {
    const three = [
      ev({ eventSeq: 1, startsAt: at(9), endsAt: at(20), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 2, startsAt: at(9), endsAt: at(20), modifier: -0.015625, direction: 'NEGATIVE' }),
      ev({ eventSeq: 3, startsAt: at(12), endsAt: at(14), modifier: 0.0078125, direction: 'POSITIVE' }) // interior overlap only
    ];
    // At t=12 all three existing events are active; the candidate is active
    // across its whole window, so the peak is 4 > 3 even though only two
    // events overlap the candidate's START.
    const verdict = activeCapacityVerdict(three, candidate(), config);
    expect(verdict.allowed).toBe(false);
    expect(verdict.peak.total).toBe(4);
    expect(verdict.caps.maxActivePerCoin).toBe(3);
  });

  test('half-open boundaries: events ending at the candidate start or starting at its end do not count', () => {
    const neighbours = [
      ev({ eventSeq: 1, startsAt: at(5), endsAt: at(10), modifier: 0.03125, direction: 'POSITIVE' }),  // ends AT candidate start
      ev({ eventSeq: 2, startsAt: at(15), endsAt: at(20), modifier: 0.03125, direction: 'POSITIVE' }), // starts AT candidate end
      ev({ eventSeq: 3, startsAt: at(0), endsAt: at(30), modifier: 0.03125, direction: 'NEGATIVE' })   // spans the window
    ];
    const verdict = activeCapacityVerdict(neighbours, candidate(), config);
    expect(verdict.allowed).toBe(true);
    expect(verdict.peak).toEqual({ total: 2, positive: 1, negative: 1 });
  });

  test('events entirely outside the candidate window contribute nothing', () => {
    const history = [
      ev({ eventSeq: 1, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 2, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 3, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 4, startsAt: at(0), endsAt: at(5), modifier: 0.03125, direction: 'POSITIVE' })
    ];
    const verdict = activeCapacityVerdict(history, candidate(), config);
    expect(verdict.allowed).toBe(true);
    expect(verdict.peak).toEqual({ total: 1, positive: 1, negative: 0 });
  });

  test('the per-direction caps bind independently of the total cap', () => {
    const twoPositive = [
      ev({ eventSeq: 1, startsAt: at(9), endsAt: at(20), modifier: 0.03125, direction: 'POSITIVE' }),
      ev({ eventSeq: 2, startsAt: at(9), endsAt: at(20), modifier: 0.03125, direction: 'POSITIVE' })
    ];
    // Total peak 3 <= 3 but positive peak 3 > 2: rejected.
    expect(activeCapacityVerdict(twoPositive, candidate(), config).allowed).toBe(false);
    // A NEGATIVE candidate at the same window is fine (negative peak 1 <= 2).
    const negative = activeCapacityVerdict(twoPositive, candidate({ direction: 'NEGATIVE' }), config);
    expect(negative.allowed).toBe(true);
    expect(negative.peak).toEqual({ total: 3, positive: 2, negative: 1 });
  });

  test('the verdict accepts the camelCase model shape and never mutates inputs', () => {
    const existing = [
      modelEv({ eventSeq: 1, startsAt: at(9), endsAt: at(20), modifier: 0.03125, direction: 'POSITIVE' })
    ];
    const candidateEvent = candidate();
    const existingBefore = JSON.parse(JSON.stringify(existing));
    const candidateBefore = { ...candidateEvent };
    const verdict = activeCapacityVerdict(existing, candidateEvent, config);
    expect(verdict.allowed).toBe(true);
    expect(verdict.peak.total).toBe(2);
    expect(JSON.parse(JSON.stringify(existing))).toEqual(existingBefore);
    expect(candidateEvent).toEqual(candidateBefore);
  });

  test('invalid candidates fail loudly', () => {
    expect(() => activeCapacityVerdict('not-an-array', candidate(), config)).toThrow(/array/);
    expect(() => activeCapacityVerdict([], null, config)).toThrow(/candidate/);
    expect(() => activeCapacityVerdict([], candidate({ direction: 'SIDEWAYS' }), config)).toThrow(/direction/);
    expect(() => activeCapacityVerdict([], candidate({ startsAt: at(15), endsAt: at(10) }), config)).toThrow(/window/);
    expect(() => activeCapacityVerdict([], candidate({ startsAt: 'not-a-date' }), config)).toThrow(/startsAt|starts_at/);
  });
});
