// Director Coin Events Wave 3: focused tests for the PURE halves of the
// persistent coin-event runtime (game/persistentCoinEventRuntime.js) —
// deterministic payload planning and target reconciliation.
//
// Covered here (pure, no database):
//   * planCoinEventPayload — stable (world/coin/decision/sequence)-keyed
//     seeded payloads: direction-matched sign, the configured individual
//     modifier bound, the 1-15 minute duration band, the 8-decimal
//     persisted precision grid, the source vocabulary, replay determinism
//     and no Math.random/wall-clock;
//   * reconcileCoinEventTargets — reconcile only MISSING active events to
//     the planner's target counts: satisfied no-op, partial top-up,
//     total/per-direction caps, expired rows excluded from active counts
//     but counted for sequence identity, append-only inputs, canonical
//     creation order and monotone sequence allocation.
//
// The database-backed wrapper (reconcilePersistentCoinEvents) is covered
// against the real disposable test database in
// __tests__/wave3-persistent-coin-event-reconcile-db.test.js.

const fs = require('fs');
const path = require('path');
const {
  planCoinEventPayload,
  reconcileCoinEventTargets
} = require('../game/persistentCoinEventRuntime');
const { resolveSimulationConfig } = require('../game/simulationConfig');

const CONFIG = resolveSimulationConfig();
const BASE_MS = Date.parse('2026-09-01T00:00:00.000Z');
const MINUTE = 60 * 1000;
const WORLD_SEED = 'wave3-runtime-pure-seed';

function payloadInput(overrides = {}) {
  return {
    worldSeed: WORLD_SEED,
    worldId: 1,
    coinId: 4,
    eventSeq: 3,
    decisionIndex: 7,
    direction: 'POSITIVE',
    role: null,
    mode: 'NORMAL',
    eventSeverityScale: 1,
    nowMs: BASE_MS,
    config: CONFIG,
    ...overrides
  };
}

describe('Wave 3 pure runtime: planCoinEventPayload', () => {
  test('produces a model-valid payload inside every configured bound', () => {
    const event = planCoinEventPayload(payloadInput());
    expect(event).toEqual({
      worldId: 1,
      coinId: 4,
      eventSeq: 3,
      name: expect.any(String),
      direction: 'POSITIVE',
      source: 'NORMAL',
      modifier: expect.any(Number),
      startsAt: new Date(BASE_MS).toISOString(),
      endsAt: expect.any(String)
    });
    expect(event.name.length).toBeGreaterThan(0);
    expect(event.name.length).toBeLessThanOrEqual(100);
    // The signed individual bound and the direction-matched sign.
    expect(event.modifier).toBeGreaterThan(0);
    expect(event.modifier).toBeLessThanOrEqual(CONFIG.persistentEvents.maxIndividualModifier);
    // The 1-15 minute duration band, starting at the injected instant.
    const durationMs = new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime();
    expect(durationMs).toBeGreaterThanOrEqual(CONFIG.persistentEvents.durationMs.min);
    expect(durationMs).toBeLessThanOrEqual(CONFIG.persistentEvents.durationMs.max);
    // Exactly representable at the persisted NUMERIC(12,8) grid.
    expect(Math.round(Math.abs(event.modifier) * 1e8) / 1e8).toBe(event.modifier);
  });

  test('a NEGATIVE direction carries a negative signed modifier', () => {
    const event = planCoinEventPayload(payloadInput({ direction: 'NEGATIVE' }));
    expect(event.direction).toBe('NEGATIVE');
    expect(event.modifier).toBeLessThan(0);
    expect(Math.abs(event.modifier)).toBeLessThanOrEqual(CONFIG.persistentEvents.maxIndividualModifier);
  });

  test('the source maps the planner role, else the decision mode', () => {
    expect(planCoinEventPayload(payloadInput({ role: 'GOLDEN' })).source).toBe('GOLDEN');
    expect(planCoinEventPayload(payloadInput({ role: 'DEMON' })).source).toBe('DEMON');
    expect(planCoinEventPayload(payloadInput({ mode: 'RESCUE' })).source).toBe('RESCUE');
    expect(planCoinEventPayload(payloadInput({ mode: 'BOOM' })).source).toBe('DIRECTOR');
    expect(planCoinEventPayload(payloadInput({ mode: 'BUST' })).source).toBe('DIRECTOR');
    expect(planCoinEventPayload(payloadInput({ mode: 'NORMAL' })).source).toBe('NORMAL');
    // A role takes precedence over the mode.
    expect(planCoinEventPayload(payloadInput({ mode: 'RESCUE', role: 'GOLDEN' })).source).toBe('GOLDEN');
  });

  test('deterministic replay: identical stable inputs produce the identical payload', () => {
    const a = planCoinEventPayload(payloadInput());
    const b = planCoinEventPayload(payloadInput());
    expect(a).toEqual(b);
  });

  test('distinct identities draw distinct payloads (seeded variety)', () => {
    const bySeq = [1, 2, 3, 4, 5].map((eventSeq) => planCoinEventPayload(payloadInput({ eventSeq })));
    const distinctModifiers = new Set(bySeq.map((e) => e.modifier));
    expect(distinctModifiers.size).toBeGreaterThan(1);
    const otherCoin = planCoinEventPayload(payloadInput({ coinId: 9 }));
    const otherDecision = planCoinEventPayload(payloadInput({ decisionIndex: 8 }));
    const otherWorld = planCoinEventPayload(payloadInput({ worldSeed: `${WORLD_SEED}-2` }));
    const base = planCoinEventPayload(payloadInput());
    expect([otherCoin, otherDecision, otherWorld].some((e) => e.modifier !== base.modifier || e.name !== base.name)).toBe(true);
  });

  test('the macro event severity scale scales draws but never breaches the individual bound', () => {
    const neutral = [1, 2, 3, 4, 5, 6].map((eventSeq) =>
      planCoinEventPayload(payloadInput({ eventSeq, eventSeverityScale: 1 })).modifier);
    const hot = [1, 2, 3, 4, 5, 6].map((eventSeq) =>
      planCoinEventPayload(payloadInput({ eventSeq, eventSeverityScale: 4 })).modifier);
    // A hotter environment scales at least one draw upward...
    expect(hot.some((m, i) => m > neutral[i])).toBe(true);
    // ...and every draw stays inside the configured bound.
    for (const m of hot) {
      expect(m).toBeLessThanOrEqual(CONFIG.persistentEvents.maxIndividualModifier);
    }
  });

  test('loud validation: direction, role, mode, sequence, severity scale and instant', () => {
    expect(() => planCoinEventPayload(payloadInput({ direction: 'SIDEWAYS' }))).toThrow(/direction/);
    expect(() => planCoinEventPayload(payloadInput({ role: 'HERO' }))).toThrow(/role/);
    expect(() => planCoinEventPayload(payloadInput({ mode: 'SIDEWAYS' }))).toThrow(/mode/);
    expect(() => planCoinEventPayload(payloadInput({ eventSeq: 0 }))).toThrow(/eventSeq/);
    expect(() => planCoinEventPayload(payloadInput({ eventSeverityScale: 0 }))).toThrow(/eventSeverityScale/);
    expect(() => planCoinEventPayload(payloadInput({ nowMs: NaN }))).toThrow(/nowMs/);
    expect(() => planCoinEventPayload(payloadInput({ worldSeed: '' }))).toThrow(/seed/i);
  });

  test('purity: no Math.random, no wall-clock reads, no database imports', () => {
    const source = fs.readFileSync(path.join(__dirname, '../game/persistentCoinEventRuntime.js'), 'utf8');
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    expect(executable).not.toMatch(/Math\.random/);
    expect(executable).not.toMatch(/Date\.now|new Date\(\)/);
  });
});

function activeEvent(coinId, eventSeq, direction, overrides = {}) {
  return {
    eventId: eventSeq,
    worldId: 1,
    coinId,
    eventSeq,
    name: `event ${eventSeq}`,
    direction,
    source: 'NORMAL',
    modifier: direction === 'POSITIVE' ? 0.02 : -0.02,
    startsAt: new Date(BASE_MS - 2 * MINUTE).toISOString(),
    endsAt: new Date(BASE_MS + 8 * MINUTE).toISOString(),
    createdAt: new Date(BASE_MS - 2 * MINUTE).toISOString(),
    ...overrides
  };
}

function expiredEvent(coinId, eventSeq, direction, overrides = {}) {
  return activeEvent(coinId, eventSeq, direction, {
    startsAt: new Date(BASE_MS - 30 * MINUTE).toISOString(),
    endsAt: new Date(BASE_MS - 20 * MINUTE).toISOString(),
    ...overrides
  });
}

function reconcileInput(overrides = {}) {
  return {
    activeEvents: [],
    maxEventSeq: 0,
    coinId: 4,
    targetPositive: 1,
    targetNegative: 1,
    role: null,
    reason: 'NORMAL baseline',
    decision: { mode: 'NORMAL', decisionIndex: 0 },
    worldSeed: WORLD_SEED,
    worldId: 1,
    eventSeverityScale: 1,
    nowMs: BASE_MS,
    config: CONFIG,
    ...overrides
  };
}

describe('Wave 3 pure runtime: reconcileCoinEventTargets', () => {
  test('an empty ledger is reconciled to the target counts, creating only the missing events', () => {
    const result = reconcileCoinEventTargets(reconcileInput({ targetPositive: 2, targetNegative: 1 }));
    expect(result.created).toHaveLength(3);
    expect(result.created.filter((e) => e.direction === 'POSITIVE')).toHaveLength(2);
    expect(result.created.filter((e) => e.direction === 'NEGATIVE')).toHaveLength(1);
    // Sequence identity allocates monotonically from the ledger maximum.
    expect(result.created.map((e) => e.eventSeq)).toEqual([1, 2, 3]);
    // Canonical creation order: positives first, then negatives.
    expect(result.created.map((e) => e.direction)).toEqual(['POSITIVE', 'POSITIVE', 'NEGATIVE']);
    for (const event of result.created) {
      expect(event.coinId).toBe(4);
      expect(new Date(event.startsAt).getTime()).toBe(BASE_MS);
    }
    expect(result.counts).toEqual({ positive: 0, negative: 0, total: 0 });
  });

  test('a satisfied target is a strict no-op', () => {
    const result = reconcileCoinEventTargets(reconcileInput({
      activeEvents: [activeEvent(4, 1, 'POSITIVE'), activeEvent(4, 2, 'NEGATIVE')],
      maxEventSeq: 2,
      targetPositive: 1,
      targetNegative: 1
    }));
    expect(result.created).toEqual([]);
    expect(result.counts).toEqual({ positive: 1, negative: 1, total: 2 });
  });

  test('a partial shortfall creates only the missing count in the missing direction', () => {
    const result = reconcileCoinEventTargets(reconcileInput({
      activeEvents: [activeEvent(4, 5, 'POSITIVE')],
      maxEventSeq: 5,
      targetPositive: 2,
      targetNegative: 2
    }));
    expect(result.created).toHaveLength(3);
    expect(result.created.map((e) => e.direction)).toEqual(['POSITIVE', 'NEGATIVE', 'NEGATIVE']);
    // Sequence continues after the ledger maximum — never reused.
    expect(result.created.map((e) => e.eventSeq)).toEqual([6, 7, 8]);
  });

  test('expired rows are excluded from the active counts but still anchor the sequence', () => {
    const result = reconcileCoinEventTargets(reconcileInput({
      activeEvents: [], // the caller passes only ACTIVE events
      maxEventSeq: 9,   // ...but the coin's full history reached seq 9
      targetPositive: 1,
      targetNegative: 0
    }));
    expect(result.created).toHaveLength(1);
    expect(result.created[0].eventSeq).toBe(10);
    expect(result.created[0].direction).toBe('POSITIVE');
  });

  test('surplus active events are left untouched (never trimmed or rewritten)', () => {
    const active = [activeEvent(4, 1, 'POSITIVE'), activeEvent(4, 2, 'POSITIVE'), activeEvent(4, 3, 'NEGATIVE')];
    const snapshot = JSON.parse(JSON.stringify(active));
    const result = reconcileCoinEventTargets(reconcileInput({
      activeEvents: active,
      maxEventSeq: 3,
      targetPositive: 1,
      targetNegative: 1
    }));
    expect(result.created).toEqual([]);
    // Append-only contract: the input array is never mutated.
    expect(active).toEqual(snapshot);
  });

  test('the configured total and per-direction caps bound creation even above target', () => {
    // 4 active negatives (at the per-direction cap), target asks for 2
    // positives: the total cap (5) leaves room for exactly one.
    const result = reconcileCoinEventTargets(reconcileInput({
      activeEvents: [
        activeEvent(4, 1, 'NEGATIVE'), activeEvent(4, 2, 'NEGATIVE'),
        activeEvent(4, 3, 'NEGATIVE'), activeEvent(4, 4, 'NEGATIVE')
      ],
      maxEventSeq: 4,
      targetPositive: 2,
      targetNegative: 4
    }));
    expect(result.created).toHaveLength(1);
    expect(result.created[0].direction).toBe('POSITIVE');
    expect(result.counts.total).toBe(4);
  });

  test('targets above the per-direction caps are clamped to the Wave 1 caps', () => {
    const result = reconcileCoinEventTargets(reconcileInput({
      targetPositive: CONFIG.persistentEvents.maxActivePositivePerCoin + 3,
      targetNegative: 0
    }));
    expect(result.created).toHaveLength(CONFIG.persistentEvents.maxActivePositivePerCoin);
    expect(result.created.every((e) => e.direction === 'POSITIVE')).toBe(true);
  });

  test('creation is deterministic: identical inputs plan identical payloads', () => {
    const a = reconcileCoinEventTargets(reconcileInput({ targetPositive: 2, targetNegative: 2 }));
    const b = reconcileCoinEventTargets(reconcileInput({ targetPositive: 2, targetNegative: 2 }));
    expect(a.created).toEqual(b.created);
  });

  test('role and mode flow into the created payload sources', () => {
    const golden = reconcileCoinEventTargets(reconcileInput({ role: 'GOLDEN', targetPositive: 1, targetNegative: 0 }));
    expect(golden.created[0].source).toBe('GOLDEN');
    const rescue = reconcileCoinEventTargets(reconcileInput({
      decision: { mode: 'RESCUE', decisionIndex: 3 },
      targetPositive: 1,
      targetNegative: 0
    }));
    expect(rescue.created[0].source).toBe('RESCUE');
    const swing = reconcileCoinEventTargets(reconcileInput({
      decision: { mode: 'BUST', decisionIndex: 3 },
      targetPositive: 0,
      targetNegative: 1
    }));
    expect(swing.created[0].source).toBe('DIRECTOR');
  });

  test('loud validation: targets, decision, sequence anchor and instant', () => {
    expect(() => reconcileCoinEventTargets(reconcileInput({ targetPositive: -1 }))).toThrow(/targetPositive/);
    expect(() => reconcileCoinEventTargets(reconcileInput({ targetPositive: 1.5 }))).toThrow(/targetPositive/);
    expect(() => reconcileCoinEventTargets(reconcileInput({ targetNegative: -2 }))).toThrow(/targetNegative/);
    expect(() => reconcileCoinEventTargets(reconcileInput({ maxEventSeq: -1 }))).toThrow(/maxEventSeq/);
    expect(() => reconcileCoinEventTargets(reconcileInput({ decision: { mode: 'SIDEWAYS', decisionIndex: 0 } }))).toThrow(/mode/);
    expect(() => reconcileCoinEventTargets(reconcileInput({ decision: { mode: 'NORMAL', decisionIndex: -1 } }))).toThrow(/decisionIndex/);
    expect(() => reconcileCoinEventTargets(reconcileInput({ nowMs: Number.NaN }))).toThrow(/nowMs/);
    // An active event for a DIFFERENT coin is a caller bug, not data.
    expect(() => reconcileCoinEventTargets(reconcileInput({
      activeEvents: [activeEvent(7, 1, 'POSITIVE')]
    }))).toThrow(/coin/);
  });
});
