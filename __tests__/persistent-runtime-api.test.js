// Director Coin Events Wave 4: public GET /api/persistent/runtime
// Real PostgreSQL tests against disposable coins_test (guard enforced;
// jest.setup.js reseeds before each test).
//
// Covers: no-auth public 200, exact null-world response, exact DTO keys at
// every level (no convenience fields), adaptive-Director projection
// (NORMAL direction null / intensity 0, committed window preserved),
// recentDecisions newest-first with allowlisted summaryCode only,
// role validity/expiry/off-roster/collision rules, ALIVE/non-retired
// roster filtering, zero-event coins, active/future/expired event
// boundaries, signed percentage conversion and the canonical stack cap,
// prohibited-field absence, REPEATABLE READ READ ONLY snapshot with one DB
// transaction timestamp and an unchanged DB fingerprint, real death and
// real replacement isolation, and the unchanged signals contract.
//
// Writer batches run at REAL time (Date.now()) so decision windows, role
// expiries and event windows are all live when the endpoint reads them.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const marketSimulator = require('../models/market-simulator');
const collapseRiskDomain = require('../game/collapseRiskDomain');
const replacementRuntime = require('../game/persistentReplacementRuntime');
const persistentWorld = require('../game/persistentWorld');
const persistentCoinEventDomain = require('../game/persistentCoinEventDomain');
const persistentRuntimeService = require('../game/persistentRuntimeService');
const historyModel = require('../models/directorDecisionHistory.model');
const { resolveSimulationConfig } = require('../game/simulationConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(120000);

const WORLD_SEED = 'wave4-persistent-runtime-api-test';

function roundTo(v, d) {
  const s = 10 ** d;
  const r = Math.round(v * s) / s;
  return r === 0 ? 0 : r;
}

async function cleanHighCoins() {
  await db.query('DELETE FROM price_history WHERE coin_id >= 100');
  await db.query('DELETE FROM persistent_coin_events WHERE coin_id >= 100');
  await db.query('DELETE FROM market_coin_state WHERE coin_id >= 100');
  await db.query('DELETE FROM coins WHERE coin_id >= 100');
  await db.query('UPDATE coins SET retired = false WHERE coin_id BETWEEN 1 AND 10');
}

async function provisionedWorld() {
  return persistentWorld.provisionWorld(db, {
    seed: WORLD_SEED,
    epochStartedAt: new Date(Date.now() - 60000)
  });
}

async function forceWriterDeath(coinId, nowMs) {
  const spy = jest.spyOn(collapseRiskDomain, 'getPersistentCollapseRiskScore')
    .mockImplementation((opts) => (Number(opts.coinId) === Number(coinId) ? 9.5 : 0.5));
  await marketSimulator.updateAllPrices({ nowMs });
  spy.mockRestore();
}

async function snapshotFingerprint() {
  const [prices, coinStates, control, history, events, priceHistory, worlds] = await Promise.all([
    db.query('SELECT coin_id, current_price, retired FROM coins ORDER BY coin_id'),
    db.query('SELECT coin_id, status, condition, archetype FROM market_coin_state ORDER BY coin_id'),
    db.query('SELECT world_id, decision_index, updated_at FROM director_control_state ORDER BY world_id'),
    db.query('SELECT world_id, decision_index, summary_code FROM director_decision_history ORDER BY world_id, decision_index'),
    db.query('SELECT event_id, coin_id, event_seq, modifier FROM persistent_coin_events ORDER BY event_id'),
    db.query('SELECT count(*)::int AS n FROM price_history'),
    db.query('SELECT world_id, seed, active FROM market_worlds ORDER BY world_id')
  ]);
  return {
    prices: prices.rows,
    coinStates: coinStates.rows,
    control: control.rows,
    history: history.rows,
    events: events.rows,
    priceHistoryCount: priceHistory.rows[0].n,
    worlds: worlds.rows
  };
}

const DIRECTOR_KEYS = ['mode', 'direction', 'intensity', 'startedAt', 'endsAt', 'goldenCoinId', 'goldenExpiresAt', 'demonCoinId', 'demonExpiresAt', 'recentDecisions'].sort();
const DECISION_KEYS = ['mode', 'direction', 'intensity', 'startedAt', 'endsAt', 'summaryCode'].sort();
const COIN_KEYS = ['coinId', 'events', 'activeNetModifierPct'].sort();
const EVENT_KEYS = ['eventId', 'name', 'modifierPct', 'startsAt', 'endsAt'].sort();
const SUMMARY_ALLOWLIST = ['GENESIS_NORMAL', 'NORMAL_SWING', 'REFRACTORY_NORMAL', 'STAGNATION_SWING', 'RESCUE_DISTRESS', 'OVERHEAT_CORRECTION', 'ROLE_ROTATION', 'OTHER_SAFE'];

function assertExactRuntimeKeys(data) {
  expect(Object.keys(data).sort()).toEqual(['coins', 'director', 'serverTime', 'worldId'].sort());
  expect(typeof data.serverTime).toBe('string');
  expect(Number.isFinite(new Date(data.serverTime).getTime())).toBe(true);
  if (data.director !== null) {
    expect(Object.keys(data.director).sort()).toEqual(DIRECTOR_KEYS);
    expect(['NORMAL', 'BOOM', 'BUST', 'RESCUE']).toContain(data.director.mode);
    for (const decision of data.director.recentDecisions) {
      expect(Object.keys(decision).sort()).toEqual(DECISION_KEYS);
      expect(SUMMARY_ALLOWLIST).toContain(decision.summaryCode);
    }
  }
  for (const coin of data.coins) {
    expect(Object.keys(coin).sort()).toEqual(COIN_KEYS);
    expect(typeof coin.coinId).toBe('number');
    expect(typeof coin.activeNetModifierPct).toBe('number');
    expect(Object.keys(coin.events).sort()).toEqual(['negative', 'positive']);
    for (const event of [...coin.events.positive, ...coin.events.negative]) {
      expect(Object.keys(event).sort()).toEqual(EVENT_KEYS);
      expect(typeof event.eventId).toBe('number');
      expect(typeof event.name).toBe('string');
      expect(typeof event.modifierPct).toBe('number');
    }
  }
}

function assertNoProhibitedFields(body) {
  const s = JSON.stringify(body);
  for (const forbidden of [
    'seed', 'reason', 'decisionIndex', 'decision_index', 'decisionId',
    'eventSeq', 'event_seq', 'source', 'regime', 'checkpoint', 'cursor',
    'threshold', 'refractory', 'apocalypse', 'cycle', 'target', 'roll'
  ]) {
    expect(s).not.toContain(forbidden);
  }
}

describe('Wave 4: GET /api/persistent/runtime (real PG, disposable coins_test)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await cleanHighCoins();
  });

  test('no active world: 200 public null-world response with exact keys (no auth)', async () => {
    const res = await request(app).get('/api/persistent/runtime').expect(200);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'status'].sort());
    expect(res.body.status).toBe('success');
    const data = res.body.data;
    expect(Object.keys(data).sort()).toEqual(['coins', 'director', 'serverTime', 'worldId'].sort());
    expect(data.worldId).toBeNull();
    expect(data.director).toBeNull();
    expect(data.coins).toEqual([]);
    expect(typeof data.serverTime).toBe('string');
    // The soft resolve must never provision a world.
    const { rows } = await db.query('SELECT count(*)::int AS n FROM market_worlds');
    expect(rows[0].n).toBe(0);
  });

  describe('with an active world (real writer batch at real time)', () => {
    beforeEach(async () => {
      await provisionedWorld();
      await marketSimulator.updateAllPrices({ nowMs: Date.now() });
    });

    test('exact DTO keys at every level; genesis NORMAL projects direction null and intensity 0', async () => {
      const res = await request(app).get('/api/persistent/runtime').expect(200);
      const data = res.body.data;
      assertExactRuntimeKeys(data);
      expect(data.worldId).not.toBeNull();
      expect(data.coins.length).toBeGreaterThan(0);

      const control = (await db.query(
        'SELECT mode, decision_index, started_at, ends_at FROM director_control_state WHERE world_id = $1',
        [data.worldId]
      )).rows[0];
      expect(control.mode).toBe('NORMAL');
      const d = data.director;
      expect(d.mode).toBe('NORMAL');
      expect(d.direction).toBeNull();
      expect(d.intensity).toBe(0);
      // The committed window is preserved verbatim.
      expect(new Date(d.startedAt).getTime()).toBe(new Date(control.started_at).getTime());
      expect(new Date(d.endsAt).getTime()).toBe(new Date(control.ends_at).getTime());

      // The genesis decision is the current committed decision, included
      // in recentDecisions with the allowlisted summary only.
      expect(d.recentDecisions).toHaveLength(1);
      expect(d.recentDecisions[0].summaryCode).toBe('GENESIS_NORMAL');
      expect(d.recentDecisions[0].direction).toBeNull();
      expect(d.recentDecisions[0].intensity).toBe(0);
      assertNoProhibitedFields(res.body);
    });

    test('recentDecisions are newest-first with NORMAL projection applied to history', async () => {
      const world = await persistentWorld.resolveActiveWorld(db);
      const control = (await db.query(
        'SELECT decision_index, ends_at FROM director_control_state WHERE world_id = $1',
        [world.worldId]
      )).rows[0];
      // A newer non-NORMAL committed decision in the ledger.
      const started = new Date(new Date(control.ends_at).getTime() + 1000);
      await historyModel.appendDirectorDecision(db, {
        worldId: world.worldId,
        decisionIndex: control.decision_index + 1,
        mode: 'BUST',
        direction: 'NEGATIVE',
        intensity: 0.45678,
        startedAt: started.toISOString(),
        endsAt: new Date(started.getTime() + 300000).toISOString(),
        summaryCode: 'OVERHEAT_CORRECTION'
      });

      const res = await request(app).get('/api/persistent/runtime').expect(200);
      const decisions = res.body.data.director.recentDecisions;
      expect(decisions).toHaveLength(2);
      expect(decisions[0].summaryCode).toBe('OVERHEAT_CORRECTION');
      expect(decisions[0].mode).toBe('BUST');
      expect(decisions[0].direction).toBe('NEGATIVE');
      expect(decisions[0].intensity).toBe(0.457); // public 3dp rounding
      expect(decisions[0].startedAt).toBe(started.toISOString());
      expect(decisions[1].summaryCode).toBe('GENESIS_NORMAL');
      expect(decisions[1].direction).toBeNull(); // NORMAL projection in history
      assertNoProhibitedFields(res.body);
    });

    test('null Director still returns the non-empty roster and events', async () => {
      await db.query('DELETE FROM director_control_state');
      const res = await request(app).get('/api/persistent/runtime').expect(200);
      const data = res.body.data;
      expect(data.worldId).not.toBeNull();
      expect(data.director).toBeNull();
      expect(data.coins.length).toBeGreaterThan(0);
      assertExactRuntimeKeys(data);
    });

    test('valid roles publish; expired and off-roster roles null BOTH fields', async () => {
      // Roles are assigned by the first roster-observing decision: the
      // genesis evaluation runs before the first batch opens coin states,
      // so advance one committed window (future nowMs keeps the assigned
      // role expiries unexpired at request time).
      const world = await persistentWorld.resolveActiveWorld(db);
      const genesis = (await db.query(
        'SELECT ends_at FROM director_control_state WHERE world_id = $1',
        [world.worldId]
      )).rows[0];
      await marketSimulator.updateAllPrices({ nowMs: new Date(genesis.ends_at).getTime() + 1000 });

      const res1 = await request(app).get('/api/persistent/runtime').expect(200);
      const d1 = res1.body.data.director;
      const rosterIds = new Set(res1.body.data.coins.map((c) => c.coinId));
      // Genesis assigns both roles; unexpired and on-roster.
      expect(d1.goldenCoinId).not.toBeNull();
      expect(d1.demonCoinId).not.toBeNull();
      expect(rosterIds.has(d1.goldenCoinId)).toBe(true);
      expect(rosterIds.has(d1.demonCoinId)).toBe(true);
      expect(d1.goldenCoinId).not.toBe(d1.demonCoinId);
      expect(new Date(d1.goldenExpiresAt).getTime()).toBeGreaterThan(new Date(res1.body.data.serverTime).getTime());

      // Expired Golden: both id and expiry null; Demon untouched.
      await db.query(
        `UPDATE director_control_state SET golden_expires_at = now() - interval '1 minute'`
      );
      const res2 = await request(app).get('/api/persistent/runtime').expect(200);
      const d2 = res2.body.data.director;
      expect(d2.goldenCoinId).toBeNull();
      expect(d2.goldenExpiresAt).toBeNull();
      expect(d2.demonCoinId).toBe(d1.demonCoinId);

      // Off-roster Demon (coin retired): both id and expiry null.
      await db.query('UPDATE coins SET retired = true WHERE coin_id = $1', [d1.demonCoinId]);
      const res3 = await request(app).get('/api/persistent/runtime').expect(200);
      const d3 = res3.body.data.director;
      expect(d3.demonCoinId).toBeNull();
      expect(d3.demonExpiresAt).toBeNull();
      // The retired coin leaves the roster entirely.
      expect(res3.body.data.coins.find((c) => c.coinId === d1.demonCoinId)).toBeUndefined();
    });

    test('role projection collision nulls BOTH roles (pure projection rule)', () => {
      const now = Date.now();
      const rosterIds = new Set([1, 2, 3]);
      const expiry = new Date(now + 600000).toISOString();
      const collided = persistentRuntimeService.projectRoles(
        { goldenCoinId: 2, goldenExpiresAt: expiry, demonCoinId: 2, demonExpiresAt: expiry },
        rosterIds,
        now
      );
      expect(collided.golden).toEqual({ id: null, expiresAt: null });
      expect(collided.demon).toEqual({ id: null, expiresAt: null });
      // An off-roster or expired role never publishes.
      const stale = persistentRuntimeService.projectRoles(
        { goldenCoinId: 9, goldenExpiresAt: expiry, demonCoinId: 3, demonExpiresAt: new Date(now - 1000).toISOString() },
        rosterIds,
        now
      );
      expect(stale.golden).toEqual({ id: null, expiresAt: null });
      expect(stale.demon).toEqual({ id: null, expiresAt: null });
    });

    test('zero-event coins appear with empty events and 0 net modifier', async () => {
      // A second in-window batch reconciles events for the now-observable
      // roster (the genesis batch ran before any coin state existed).
      await marketSimulator.updateAllPrices({ nowMs: Date.now() });
      const before = await request(app).get('/api/persistent/runtime').expect(200);
      const withEvents = before.body.data.coins.find((c) =>
        c.events.positive.length + c.events.negative.length > 0
      );
      expect(withEvents).toBeDefined();
      await db.query(
        'DELETE FROM persistent_coin_events WHERE coin_id = $1',
        [withEvents.coinId]
      );
      const res = await request(app).get('/api/persistent/runtime').expect(200);
      const coin = res.body.data.coins.find((c) => c.coinId === withEvents.coinId);
      expect(coin).toBeDefined();
      expect(coin.events).toEqual({ positive: [], negative: [] });
      expect(coin.activeNetModifierPct).toBe(0);
    });

    test('event active/future/expired boundaries at the DB snapshot timestamp', async () => {
      const world = await persistentWorld.resolveActiveWorld(db);
      const coinId = 1;
      await db.query('DELETE FROM persistent_coin_events WHERE coin_id = $1', [coinId]);
      const insert = (seq, name, direction, modifier, startSql, endSql) =>
        db.query(
          `INSERT INTO persistent_coin_events
             (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, $5, 'NORMAL', $6, ${startSql}, ${endSql})`,
          [world.worldId, coinId, seq, name, direction, modifier]
        );
      await insert(90, 'Active Pos', 'POSITIVE', 0.02, "now() - interval '1 minute'", "now() + interval '9 minutes'");
      await insert(91, 'Active Neg', 'NEGATIVE', -0.03, "now() - interval '2 minutes'", "now() + interval '8 minutes'");
      await insert(92, 'Expired', 'POSITIVE', 0.04, "now() - interval '10 minutes'", "now() - interval '1 minute'");
      await insert(93, 'Future', 'NEGATIVE', -0.01, "now() + interval '2 minutes'", "now() + interval '11 minutes'");

      const res = await request(app).get('/api/persistent/runtime').expect(200);
      const coin = res.body.data.coins.find((c) => c.coinId === coinId);
      expect(coin).toBeDefined();
      expect(coin.events.positive.map((e) => e.name)).toEqual(['Active Pos']);
      expect(coin.events.negative.map((e) => e.name)).toEqual(['Active Neg']);
      // Signed fraction * 100, public 4dp rounding.
      expect(coin.events.positive[0].modifierPct).toBe(2);
      expect(coin.events.negative[0].modifierPct).toBe(-3);
      // Net = 0.02 - 0.03 = -0.01 -> -1% (within the canonical cap).
      expect(coin.activeNetModifierPct).toBe(-1);
      // Window boundaries agree with the response serverTime snapshot.
      const snapMs = new Date(res.body.data.serverTime).getTime();
      for (const e of [...coin.events.positive, ...coin.events.negative]) {
        expect(new Date(e.startsAt).getTime()).toBeLessThanOrEqual(snapMs);
        expect(new Date(e.endsAt).getTime()).toBeGreaterThan(snapMs);
      }
    });

    test('activeNetModifierPct uses the canonical stack cap (never the raw sum)', async () => {
      const world = await persistentWorld.resolveActiveWorld(db);
      const config = resolveSimulationConfig();
      const coinId = 2;
      await db.query('DELETE FROM persistent_coin_events WHERE coin_id = $1', [coinId]);
      // Four +0.04 events: raw net 0.16, far beyond the 0.06 canonical cap.
      for (let seq = 90; seq < 94; seq += 1) {
        await db.query(
          `INSERT INTO persistent_coin_events
             (world_id, coin_id, event_seq, name, direction, source, modifier, starts_at, ends_at)
           VALUES ($1, $2, $3, $4, 'POSITIVE', 'NORMAL', 0.04, now() - interval '1 minute', now() + interval '9 minutes')`,
          [world.worldId, coinId, seq, `Stack ${seq}`]
        );
      }
      const res = await request(app).get('/api/persistent/runtime').expect(200);
      const coin = res.body.data.coins.find((c) => c.coinId === coinId);
      const activeEvents = [...coin.events.positive, ...coin.events.negative];
      expect(activeEvents).toHaveLength(4);
      expect(activeEvents.every((e) => e.modifierPct === 4)).toBe(true);
      expect(coin.activeNetModifierPct).toBe(roundTo(config.persistentEvents.maxNetModifier * 100, 4));
      // And it matches the canonical helper over the same active set.
      const domain = persistentCoinEventDomain.netActiveModifierCapped(
        activeEvents.map((e) => ({ modifier: e.modifierPct / 100, startsAt: e.startsAt, endsAt: e.endsAt, coinId, eventSeq: 1 })),
        res.body.data.serverTime,
        config
      );
      expect(coin.activeNetModifierPct).toBe(roundTo(domain * 100, 4));
    });

    test('real death: the DEAD coin leaves the runtime roster entirely (events never leak)', async () => {
      const deadId = 3;
      await forceWriterDeath(deadId, Date.now());
      const res = await request(app).get('/api/persistent/runtime').expect(200);
      const data = res.body.data;
      expect(data.coins.find((c) => c.coinId === deadId)).toBeUndefined();
      expect(data.coins.length).toBeGreaterThan(0);
      assertExactRuntimeKeys(data);
      assertNoProhibitedFields(res.body);
    });

    test('real replacement: retired predecessor excluded, replacement joins the roster', async () => {
      // Death and replacement at/after the committed batch instant (the
      // writer never runs backwards).
      await forceWriterDeath(1, Date.now() + 1000);
      const diedAtMs = Date.now() + 1000;
      const delayMs = 6 * 60 * 60 * 1000;
      const introduced = await replacementRuntime.reconcilePersistentReplacements({
        nowMs: diedAtMs + delayMs
      });
      expect(introduced.inserted.length).toBeGreaterThan(0);
      const repl = introduced.inserted[0];

      const res = await request(app).get('/api/persistent/runtime').expect(200);
      const data = res.body.data;
      expect(data.coins.find((c) => c.coinId === 1)).toBeUndefined();
      const r = data.coins.find((c) => c.coinId === repl.coinId);
      expect(r).toBeDefined();
      expect([...r.events.positive, ...r.events.negative].every((e) => typeof e.eventId === 'number')).toBe(true);
      assertExactRuntimeKeys(data);
    });

    test('GET never mutates: DB fingerprint identical before/after', async () => {
      const before = await snapshotFingerprint();
      await request(app).get('/api/persistent/runtime').expect(200);
      await request(app).get('/api/persistent/runtime').expect(200);
      const after = await snapshotFingerprint();
      expect(after).toEqual(before);
    });

    test('snapshot discipline: one REPEATABLE READ READ ONLY transaction, no mutating statements', async () => {
      const statements = [];
      const originalGetClient = db.getClient.bind(db);
      // Wrap WITHOUT tampering with the pooled client: the service only
      // uses query/release, so a duck-typed wrapper records statements
      // while the real pooled client stays pristine.
      const spy = jest.spyOn(db, 'getClient').mockImplementation(async () => {
        const real = await originalGetClient();
        return {
          query: (text, params) => {
            statements.push(typeof text === 'string' ? text : String(text && text.text));
            return real.query(text, params);
          },
          release: () => real.release()
        };
      });
      try {
        await request(app).get('/api/persistent/runtime').expect(200);
      } finally {
        spy.mockRestore();
      }
      expect(statements.length).toBeGreaterThan(0);
      expect(statements[0]).toMatch(/BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY/);
      expect(statements[statements.length - 1]).toMatch(/^(COMMIT|ROLLBACK)/);
      const mutating = statements.filter((s) => /^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)/i.test(s));
      expect(mutating).toEqual([]);
      const forUpdate = statements.filter((s) => /FOR\s+UPDATE/i.test(s));
      expect(forUpdate).toEqual([]);
    });

    test('GET /api/persistent/signals contract is unchanged', async () => {
      const res = await request(app).get('/api/persistent/signals').expect(200);
      expect(res.body.status).toBe('success');
      const data = res.body.data;
      expect(Object.keys(data).sort()).toEqual(['coins', 'director', 'serverTime', 'worldId'].sort());
      if (data.director !== null) {
        expect(Object.keys(data.director).sort()).toEqual(['intensity', 'regime'].sort());
      }
      const coinKeys = ['archetype', 'coinId', 'currentPrice', 'dead', 'momentum', 'name', 'recentChangePct', 'status', 'symbol'].sort();
      expect(data.coins.length).toBeGreaterThan(0);
      for (const c of data.coins) {
        expect(Object.keys(c).sort()).toEqual(coinKeys);
      }
    });
  });
});
