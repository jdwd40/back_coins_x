// SIM-15 (Wave 5): the market-signals endpoint explains the live
// simulation — the current public market phase (id, display name, expiry)
// and, per live coin, up to five active coin events (public name,
// direction, expiry) — while hidden internals (lifecycle state, phase
// sequence/modifier, event strength/modifier/sequence, start times, seeds)
// never reach the payload. The existing envelope and coin fields are
// unchanged; collapsed coins keep their DEAD contract with an empty event
// list. Tests run against the REAL route on the disposable test DB, with
// the cycle reconciliation pinned to a persisted fixture cycle (the real
// wall clock is past its window), exactly like v2-market-signals.test.js.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const cycleService = require('../game/gameCycleService');
const { reconcileCycle } = cycleService;

jest.setTimeout(30000);

const FIXTURE_NOW = new Date('2026-08-20T10:07:00.000Z');

// Every persisted fixture event/phase window sits at fixture time; the
// endpoint evaluates at the REAL clock, so rows meant to be "active" are
// inserted with generous windows around Date.now().
async function pinCycle() {
  const cycle = await reconcileCycle({ now: FIXTURE_NOW });
  const spy = jest.spyOn(cycleService, 'reconcileCycle').mockResolvedValue(cycle);
  return { cycle, spy };
}

async function getSignals() {
  const response = await request(app).get('/api/game/market-signals').expect(200);
  expect(response.body.status).toBe('success');
  return response.body.data;
}

async function liveCoinIds(limit = 10) {
  const { rows } = await db.query(
    'SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id LIMIT $1',
    [limit]
  );
  return rows.map((r) => r.coin_id);
}

async function insertEvent({ cycleId, coinId, eventSeq, name, direction, startsAt, endsAt, modifier, strengthCategory = 'MINOR' }) {
  // The schema enforces modifier sign = direction sign.
  const signedModifier = modifier ?? (direction === 'POSITIVE' ? 0.01 : -0.01);
  await db.query(
    `INSERT INTO apocalypse_coin_events
       (cycle_id, coin_id, event_seq, name, direction, strength_category, modifier, starts_at, ends_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [cycleId, coinId, eventSeq, name, direction, strengthCategory, signedModifier, startsAt, endsAt]
  );
}

async function insertPhase({ cycleId, phaseSeq, phase, startsAt, endsAt, modifier }) {
  // The schema enforces modifier sign = phase sign.
  const signedModifier = modifier ?? (['GOLDEN_AGE', 'BOOM', 'BULL'].includes(phase) ? 0.01 : -0.01);
  await db.query(
    `INSERT INTO apocalypse_market_phases
       (cycle_id, phase_seq, phase, lifecycle_state, modifier, starts_at, ends_at)
     VALUES ($1, $2, $3, 'GROWTH', $4, $5, $6)`,
    [cycleId, phaseSeq, phase, signedModifier, startsAt, endsAt]
  );
}

function collectKeys(value, into = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

describe('SIM-15: public market phase on GET /api/game/market-signals', () => {
  test('an active persisted phase is exposed as { id, name, endsAt } only', async () => {
    const { cycle, spy } = await pinCycle();
    try {
      const now = Date.now();
      await insertPhase({
        cycleId: cycle.cycle_id,
        phaseSeq: 9001,
        phase: 'BULL',
        startsAt: new Date(now - 60_000),
        endsAt: new Date(now + 10 * 60_000)
      });
      const data = await getSignals();
      expect(data.marketPhase).not.toBeNull();
      expect(Object.keys(data.marketPhase).sort()).toEqual(['endsAt', 'id', 'name']);
      expect(data.marketPhase.id).toBe('BULL');
      expect(data.marketPhase.name).toBe('Bull');
      expect(new Date(data.marketPhase.endsAt).getTime()).toBeGreaterThan(new Date(data.serverTime).getTime());
    } finally {
      spy.mockRestore();
    }
  });

  test('an expired phase chain yields marketPhase: null (global phase expiry)', async () => {
    const { cycle, spy } = await pinCycle();
    try {
      // The fixture cycle's persisted chain covers fixture time only; every
      // row expired long before the real clock. Insert one extra EXPLICITLY
      // expired phase row to prove expiry filtering, not just absence.
      const now = Date.now();
      await insertPhase({
        cycleId: cycle.cycle_id,
        phaseSeq: 9002,
        phase: 'RECESSION',
        startsAt: new Date(now - 20 * 60_000),
        endsAt: new Date(now - 10 * 60_000)
      });
      const data = await getSignals();
      expect(data.marketPhase).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SIM-15: public coin events on GET /api/game/market-signals', () => {
  test('a coin with no active events exposes an empty list', async () => {
    const { spy } = await pinCycle();
    try {
      const data = await getSignals();
      expect(data.coins).toHaveLength(10);
      for (const coin of data.coins) {
        expect(coin.events).toEqual([]);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('one active event is exposed with exactly { name, direction, endsAt }', async () => {
    const { cycle, spy } = await pinCycle();
    try {
      const [coinId] = await liveCoinIds(1);
      const now = Date.now();
      const endsAt = new Date(now + 7 * 60_000);
      await insertEvent({
        cycleId: cycle.cycle_id, coinId, eventSeq: 9001,
        name: 'Viral Attention', direction: 'POSITIVE',
        startsAt: new Date(now - 60_000), endsAt
      });
      const data = await getSignals();
      const coin = data.coins.find((c) => c.coinId === coinId);
      expect(coin.events).toHaveLength(1);
      const event = coin.events[0];
      expect(Object.keys(event).sort()).toEqual(['direction', 'endsAt', 'name']);
      expect(event.name).toBe('Viral Attention');
      expect(event.direction).toBe('POSITIVE');
      expect(event.endsAt).toBe(endsAt.toISOString());
      // Every other coin stays quiet.
      for (const other of data.coins.filter((c) => c.coinId !== coinId)) {
        expect(other.events).toEqual([]);
      }
    } finally {
      spy.mockRestore();
    }
  });

  test('positive and negative directions are both exposed as persisted', async () => {
    const { cycle, spy } = await pinCycle();
    try {
      const [coinId] = await liveCoinIds(1);
      const now = Date.now();
      await insertEvent({
        cycleId: cycle.cycle_id, coinId, eventSeq: 9001,
        name: 'Whale Accumulation', direction: 'POSITIVE', modifier: 0.02,
        startsAt: new Date(now - 120_000), endsAt: new Date(now + 5 * 60_000)
      });
      await insertEvent({
        cycleId: cycle.cycle_id, coinId, eventSeq: 9002,
        name: 'Security Rumours', direction: 'NEGATIVE', modifier: -0.024, strengthCategory: 'MAJOR',
        startsAt: new Date(now - 60_000), endsAt: new Date(now + 6 * 60_000)
      });
      const data = await getSignals();
      const coin = data.coins.find((c) => c.coinId === coinId);
      expect(coin.events).toHaveLength(2);
      expect(coin.events.map((e) => e.direction)).toEqual(['POSITIVE', 'NEGATIVE']);
      expect(coin.events.map((e) => e.name)).toEqual(['Whale Accumulation', 'Security Rumours']);
    } finally {
      spy.mockRestore();
    }
  });

  test('at most five active events are exposed, earliest first, when more are active', async () => {
    const { cycle, spy } = await pinCycle();
    try {
      const [coinId] = await liveCoinIds(1);
      const now = Date.now();
      for (let i = 0; i < 6; i += 1) {
        await insertEvent({
          cycleId: cycle.cycle_id, coinId, eventSeq: 9001 + i,
          name: `Event ${i + 1}`, direction: i % 2 === 0 ? 'POSITIVE' : 'NEGATIVE',
          startsAt: new Date(now - (6 - i) * 60_000),
          endsAt: new Date(now + (i + 1) * 60_000)
        });
      }
      const data = await getSignals();
      const coin = data.coins.find((c) => c.coinId === coinId);
      expect(coin.events).toHaveLength(5);
      expect(coin.events.map((e) => e.name)).toEqual(['Event 1', 'Event 2', 'Event 3', 'Event 4', 'Event 5']);
    } finally {
      spy.mockRestore();
    }
  });

  test('expired events are filtered out even when persisted', async () => {
    const { cycle, spy } = await pinCycle();
    try {
      const [coinId] = await liveCoinIds(1);
      const now = Date.now();
      await insertEvent({
        cycleId: cycle.cycle_id, coinId, eventSeq: 9001,
        name: 'Failed Upgrade', direction: 'NEGATIVE',
        startsAt: new Date(now - 30 * 60_000), endsAt: new Date(now - 60_000) // expired
      });
      await insertEvent({
        cycleId: cycle.cycle_id, coinId, eventSeq: 9002,
        name: 'Network Upgrade', direction: 'POSITIVE',
        startsAt: new Date(now - 60_000), endsAt: new Date(now + 5 * 60_000) // active
      });
      const data = await getSignals();
      const coin = data.coins.find((c) => c.coinId === coinId);
      expect(coin.events).toHaveLength(1);
      expect(coin.events[0].name).toBe('Network Upgrade');
    } finally {
      spy.mockRestore();
    }
  });

  test('a collapsed coin keeps its DEAD contract and exposes an empty event list even with active rows', async () => {
    const { cycle, spy } = await pinCycle();
    try {
      const [doomedId] = await liveCoinIds(1);
      await db.query(
        `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
         VALUES ($1, $2, 0, $3)`,
        [cycle.cycle_id, doomedId, new Date(cycle.start_time)]
      );
      await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [doomedId]);
      // An event row that WOULD be active for this coin at the real clock:
      // the dead-coin contract must still suppress it.
      const now = Date.now();
      await insertEvent({
        cycleId: cycle.cycle_id, coinId: doomedId, eventSeq: 9001,
        name: 'Viral Attention', direction: 'POSITIVE',
        startsAt: new Date(now - 60_000), endsAt: new Date(now + 5 * 60_000)
      });
      const data = await getSignals();
      const dead = data.coins.find((c) => c.coinId === doomedId);
      expect(dead.dead).toBe(true);
      expect(dead.currentPrice).toBe(0);
      expect(dead.phase).toBe('DEAD');
      expect(dead.momentum).toBe('FLAT');
      expect(dead.recentChangePct).toBeNull();
      expect(dead.collapseRisk).toBe('DEAD');
      expect(dead.events).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('SIM-15: hidden internals never leak through the extended payload', () => {
  test('no internal field names or values survive anywhere in the response', async () => {
    const { cycle, spy } = await pinCycle();
    try {
      const [coinId] = await liveCoinIds(1);
      const now = Date.now();
      await insertPhase({
        cycleId: cycle.cycle_id, phaseSeq: 9003, phase: 'GOLDEN_AGE',
        modifier: 0.02718281,
        startsAt: new Date(now - 60_000), endsAt: new Date(now + 10 * 60_000)
      });
      await insertEvent({
        cycleId: cycle.cycle_id, coinId, eventSeq: 9001,
        name: 'Fraud Allegations', direction: 'NEGATIVE',
        modifier: -0.03141592, strengthCategory: 'EXTREME',
        startsAt: new Date(now - 60_000), endsAt: new Date(now + 5 * 60_000)
      });
      const response = await request(app).get('/api/game/market-signals').expect(200);
      const keys = collectKeys(response.body);
      const FORBIDDEN_KEYS = [
        'modifier', 'strength_category', 'strengthCategory',
        'event_seq', 'eventSeq', 'event_id', 'eventId',
        'phase_seq', 'phaseSeq', 'starts_at', 'startsAt', 'created_at', 'createdAt',
        'lifecycle', 'lifecycleState', 'lifecycle_state',
        'seed', 'peak', 'peakIndex', 'target', 'plateauTarget',
        'schedule', 'rank', 'collapseRank', 'probability', 'collapseProbability',
        'cycle_id', 'cycleId'
      ];
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys.has(forbidden)).toBe(false);
      }
      const serialised = JSON.stringify(response.body);
      // The persisted internal VALUES must not leak either: the hidden
      // lifecycle state recorded on the phase row, the strength category,
      // and the exact signed modifiers.
      expect(serialised).not.toContain('GROWTH');
      expect(serialised).not.toContain('PLATEAU');
      expect(serialised).not.toContain('DECLINE');
      expect(serialised).not.toContain('EXTREME');
      expect(serialised).not.toContain('0.03141592');
      expect(serialised).not.toContain('0.02718281');
      const { rows } = await db.query('SELECT seed FROM apocalypse_cycles WHERE cycle_id = $1', [cycle.cycle_id]);
      expect(serialised).not.toContain(rows[0].seed);
    } finally {
      spy.mockRestore();
    }
  });
});
