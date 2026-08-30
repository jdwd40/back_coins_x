// SIM-06/07 redaction: the Wave 2 market state (market index, peak,
// drawdown, momentum, hidden lifecycle state, generated plateau target) is
// INTERNAL-ONLY. The persisted row exists and advances, while no public API
// shape changes and no hidden internals leak. (Player-facing phase/event
// exposure is Wave 5 / SIM-15..17, deliberately not here.)

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const { getCycleMarketState } = require('../game/marketStateEngine');
const { reconcileCycle } = require('../game/gameCycleService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

// The hidden Wave 2 internals that must never appear in public payloads.
// ('momentum' alone is NOT forbidden: market-signals exposes a coarse
// per-coin public momentum signal by design; the forbidden keys are the
// market-state internals.)
const FORBIDDEN_KEYS = [
  'lifecycle', 'lifecycleState', 'lifecycle_state',
  'marketIndex', 'market_index', 'startingIndex', 'starting_index',
  'currentIndex', 'current_index', 'peakIndex', 'peak_index', 'peakMarketIndex', 'peakAt', 'peak_at',
  'drawdown', 'marketDrawdown',
  'plateauTarget', 'plateau_target', 'plateau',
  'collapseRisk', 'collapseProbability',
  'seed', 'target'
];

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

describe('SIM-06/07: hidden market state never leaks through public APIs', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('the market state row exists and advances while /api/game/state keeps its exact public contract', async () => {
    const cycle = await reconcileCycle({ now: new Date(), generateSeed: () => 'sim07-redaction-seed' });
    const state = await getCycleMarketState(db, cycle.cycle_id);
    // The hidden state is real and persisted...
    expect(state).not.toBeNull();
    expect(state.lifecycle_state).toBe('GROWTH');
    expect(parseFloat(state.plateau_target)).toBeGreaterThan(0);
    expect(parseFloat(state.peak_index)).toBeGreaterThan(0);

    const response = await request(app).get('/api/game/state').expect(200);
    // ...and the public contract is exactly the pre-Wave-2 shape.
    expect(Object.keys(response.body).sort()).toEqual([
      'apocalypseId', 'apocalypsePercent', 'durationMs', 'endTime',
      'remainingMs', 'serverTime', 'startTime', 'status'
    ]);
    const keys = collectKeys(response.body);
    for (const forbidden of FORBIDDEN_KEYS) {
      expect(keys.has(forbidden)).toBe(false);
    }
  });

  test('market status, stats and coin payloads carry no lifecycle/index/target internals', async () => {
    await reconcileCycle({ now: new Date(), generateSeed: () => 'sim07-redaction-seed' });

    const status = await request(app).get('/api/market/status').expect(200);
    const stats = await request(app).get('/api/market/stats').expect(200);
    const coins = await request(app).get('/api/coins').expect(200);

    for (const body of [status.body, stats.body, coins.body]) {
      const keys = collectKeys(body);
      for (const forbidden of FORBIDDEN_KEYS) {
        expect(keys.has(forbidden)).toBe(false);
      }
    }
  });

  test('no market-state route exists (the internal table has no HTTP surface)', async () => {
    await request(app).get('/api/game/market-state').expect(404);
    await request(app).get('/api/game/lifecycle').expect(404);
    await request(app).get('/api/market/state').expect(404);
    await request(app).get('/api/market/lifecycle').expect(404);
  });
});
