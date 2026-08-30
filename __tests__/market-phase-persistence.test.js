// SIM-05: market phase persistence/recovery against the disposable test
// database (guard-enforced; jest.setup.js reseeds before each test).
//
// Covered:
//   * the primary phase chain is created deterministically at cycle start
//     and extended lazily as `now` advances, inside the Core 1
//     advisory-locked transaction shape;
//   * one primary phase at a time, at every instant, across repeated
//     reconciliations (the no-overlap invariant);
//   * idempotency: repeated coverage calls are no-ops; persisted rows are
//     never rerolled, mutated or resurrected;
//   * restart-equivalent state: persisted rows are byte-identical to the
//     pure chain recomputed from the cycle's persisted seed;
//   * the chain never extends past the cycle end;
//   * no cross-cycle leakage;
//   * the full Core 1 reconcileCycle path creates/extends phase state.

const db = require('../db/connection');
const {
  drawPhaseAt,
  buildPhaseChain,
  getCycleMarketPhases,
  ensureMarketPhaseCoverage,
  getCurrentMarketPhase
} = require('../game/marketPhaseEngine');
const { reconcileCycle } = require('../game/gameCycleService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const LOCK_KEY = 727001; // the Core 1 game-lifecycle advisory lock

const START = new Date('2026-08-20T10:00:00.000Z');
const END = new Date('2026-08-20T10:30:00.000Z');
const SEED = 'sim05-persistence-seed';

async function withLifecycleTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function insertCycle({ apocalypseId, seed, status = 'ACTIVE', start = START, end = END }) {
  const { rows } = await db.query(
    `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [apocalypseId, seed, start.toISOString(), end.toISOString(), end.getTime() - start.getTime(), status]
  );
  return rows[0];
}

// Canonical comparison shape: DB rows carry numerics as strings and extra
// bookkeeping columns; compare the gameplay fields exactly.
function canonical(rows) {
  return rows.map((r) => ({
    phase_seq: Number(r.phase_seq),
    phase: r.phase,
    lifecycle_state: r.lifecycle_state,
    modifier: parseFloat(r.modifier),
    starts_at_ms: new Date(r.starts_at).getTime(),
    ends_at_ms: new Date(r.ends_at).getTime()
  }));
}

function canonicalPure(rows) {
  return rows.map((r) => ({
    phase_seq: r.phase_seq,
    phase: r.phase,
    lifecycle_state: r.lifecycle_state,
    modifier: r.modifier,
    starts_at_ms: r.starts_at.getTime(),
    ends_at_ms: r.ends_at.getTime()
  }));
}

// The one-primary invariant over the persisted rows: at every sampled
// instant inside the cycle window, exactly one phase row covers it.
async function assertOnePrimary(cycleId) {
  const phases = await getCycleMarketPhases(db, cycleId);
  for (let t = START.getTime(); t < END.getTime(); t += 30000) {
    const covering = phases.filter(
      (p) => new Date(p.starts_at).getTime() <= t && t < new Date(p.ends_at).getTime()
    );
    expect(covering).toHaveLength(1);
  }
  return phases;
}

describe('SIM-05: market phase persistence and recovery', () => {
  beforeEach(() => {
    assertDisposableTestDatabase();
  });

  test('cycle start persists phase 1 at the cycle start, matching the pure draw', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date(START.getTime() + 60000);
    const { phases, current, created } = await withLifecycleTransaction(
      (client) => ensureMarketPhaseCoverage(client, cycle, now)
    );
    expect(created).toEqual([1]);
    expect(phases).toHaveLength(1);
    const drawn = drawPhaseAt({ seed: SEED, phaseSeq: 1, lifecycleState: 'GROWTH' });
    expect(phases[0].phase).toBe(drawn.phase);
    expect(phases[0].lifecycle_state).toBe('GROWTH');
    expect(parseFloat(phases[0].modifier)).toBe(drawn.modifier);
    expect(new Date(phases[0].starts_at).getTime()).toBe(START.getTime());
    expect(new Date(phases[0].ends_at).getTime()).toBe(START.getTime() + drawn.durationMs);
    expect(current.phase_id).toBe(phases[0].phase_id);
  });

  test('repeated coverage at the same instant is a pure no-op', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date(START.getTime() + 60000);
    const first = await withLifecycleTransaction((client) => ensureMarketPhaseCoverage(client, cycle, now));
    const second = await withLifecycleTransaction((client) => ensureMarketPhaseCoverage(client, cycle, now));
    expect(second.created).toEqual([]);
    expect(second.phases).toEqual(first.phases);
    const { rows } = await db.query('SELECT count(*)::int AS n FROM apocalypse_market_phases WHERE cycle_id = $1', [cycle.cycle_id]);
    expect(rows[0].n).toBe(first.phases.length);
  });

  test('advancing time extends the chain deterministically — a prefix of the pure chain', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    // Walk `now` across the whole window in one-minute steps.
    for (let t = START.getTime() + 60000; t <= END.getTime(); t += 60000) {
      await withLifecycleTransaction((client) => ensureMarketPhaseCoverage(client, cycle, new Date(t)));
    }
    const phases = await getCycleMarketPhases(db, cycle.cycle_id);
    const pure = buildPhaseChain({ seed: SEED, startTime: START, endTime: END, lifecycleState: 'GROWTH' });
    expect(canonical(phases)).toEqual(canonicalPure(pure));
    // Contiguity + one primary at every instant.
    for (let i = 1; i < phases.length; i++) {
      expect(new Date(phases[i].starts_at).getTime()).toBe(new Date(phases[i - 1].ends_at).getTime());
    }
    await assertOnePrimary(cycle.cycle_id);
  });

  test('the one-primary invariant holds across many repeated reconciliations', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    // Repeatedly reconcile at shuffled-but-deterministic instants, including
    // repeated ones: no reconciliation may ever create overlapping phases.
    const instants = [];
    for (let t = START.getTime() + 90000; t < END.getTime(); t += 90000) instants.push(t, t);
    for (const t of instants) {
      await withLifecycleTransaction((client) => ensureMarketPhaseCoverage(client, cycle, new Date(t)));
      const covering = await db.query(
        `SELECT count(*)::int AS n FROM apocalypse_market_phases
         WHERE cycle_id = $1 AND starts_at <= $2 AND ends_at > $2`,
        [cycle.cycle_id, new Date(t).toISOString()]
      );
      expect(covering.rows[0].n).toBe(1);
    }
    await assertOnePrimary(cycle.cycle_id);
  });

  test('expired phases are retained and never resurrected; the current phase advances', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    await withLifecycleTransaction((client) => ensureMarketPhaseCoverage(client, cycle, new Date(START.getTime() + 60000)));
    const firstChain = await getCycleMarketPhases(db, cycle.cycle_id);
    const first = firstChain[0];

    // Jump past the first phase's end: the chain extends, the old row is
    // untouched, and the current phase is a later one.
    const pastFirstEnd = new Date(new Date(first.ends_at).getTime() + 30000);
    await withLifecycleTransaction((client) => ensureMarketPhaseCoverage(client, cycle, pastFirstEnd));
    const laterChain = await getCycleMarketPhases(db, cycle.cycle_id);
    expect(laterChain.length).toBeGreaterThan(1);
    expect(laterChain[0]).toEqual(first); // expired row: identical, not rerolled
    const current = await getCurrentMarketPhase(db, cycle.cycle_id, pastFirstEnd);
    expect(current.phase_seq).toBeGreaterThan(1);
    // The expired phase is not returned as current even though it persists.
    expect(current.phase_id).not.toBe(first.phase_id);
  });

  test('restart-equivalent state: a fresh transaction observes the persisted chain unchanged', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    const now = new Date('2026-08-20T10:12:00.000Z');
    const first = await withLifecycleTransaction((client) => ensureMarketPhaseCoverage(client, cycle, now));
    // Simulate a process restart: new transaction, cycle re-read from the DB.
    const recovered = await withLifecycleTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM apocalypse_cycles WHERE cycle_id = $1', [cycle.cycle_id]);
      return ensureMarketPhaseCoverage(client, rows[0], now);
    });
    expect(recovered.created).toEqual([]);
    expect(recovered.phases).toEqual(first.phases);
    // And the observed chain still equals a pure recomputation from the seed.
    const pure = buildPhaseChain({ seed: SEED, startTime: START, endTime: END, lifecycleState: 'GROWTH' });
    const pureCovered = pure.filter((p) => p.starts_at.getTime() <= now.getTime());
    expect(canonical(recovered.phases)).toEqual(canonicalPure(pureCovered));
  });

  test('the chain never extends past the cycle end', async () => {
    const cycle = await insertCycle({ apocalypseId: 'APOC-0001', seed: SEED });
    // Reconcile long after the cycle ended: coverage fills to the end and stops.
    await withLifecycleTransaction(
      (client) => ensureMarketPhaseCoverage(client, cycle, new Date(END.getTime() + 60 * 60000))
    );
    const phases = await getCycleMarketPhases(db, cycle.cycle_id);
    expect(phases.length).toBeGreaterThan(0);
    for (const p of phases) {
      expect(new Date(p.starts_at).getTime()).toBeLessThan(END.getTime());
    }
    expect(new Date(phases[phases.length - 1].ends_at).getTime()).toBeGreaterThanOrEqual(END.getTime());
  });

  test('no cross-cycle leakage: each cycle has its own seeded chain', async () => {
    const cycleA = await insertCycle({ apocalypseId: 'APOC-0001', seed: 'phase-cycle-a' });
    await withLifecycleTransaction(
      (client) => ensureMarketPhaseCoverage(client, cycleA, new Date(END.getTime() + 60000))
    );
    const cycleB = await insertCycle({
      apocalypseId: 'APOC-0002',
      seed: 'phase-cycle-b',
      status: 'COMPLETED',
      start: END,
      end: new Date(END.getTime() + 30 * 60000)
    });
    await withLifecycleTransaction(
      (client) => ensureMarketPhaseCoverage(client, cycleB, new Date(END.getTime() + 10 * 60000))
    );
    const phasesA = await getCycleMarketPhases(db, cycleA.cycle_id);
    const phasesB = await getCycleMarketPhases(db, cycleB.cycle_id);
    expect(phasesA.length).toBeGreaterThan(0);
    expect(phasesB.length).toBeGreaterThan(0);
    expect(new Set(phasesA.map((r) => r.cycle_id))).toEqual(new Set([cycleA.cycle_id]));
    expect(new Set(phasesB.map((r) => r.cycle_id))).toEqual(new Set([cycleB.cycle_id]));
    const idsA = new Set(phasesA.map((r) => r.phase_id));
    expect(phasesB.some((r) => idsA.has(r.phase_id))).toBe(false);
  });

  test('the Core 1 reconcile path creates and extends phase state for the live cycle', async () => {
    const generateSeed = () => SEED;
    const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:05:00.000Z'), generateSeed });
    expect(cycle.status).toBe('ACTIVE');
    const startMs = new Date(cycle.start_time).getTime();
    const endMs = new Date(cycle.end_time).getTime();

    const afterFirst = await getCycleMarketPhases(db, cycle.cycle_id);
    expect(afterFirst.length).toBeGreaterThan(0);
    expect(new Date(afterFirst[0].starts_at).getTime()).toBe(startMs);
    const current = await getCurrentMarketPhase(db, cycle.cycle_id, new Date('2026-08-20T10:05:00.000Z'));
    expect(current).not.toBeNull();

    // Reconcile again late in the same live window: the chain covers it.
    const later = await reconcileCycle({ now: new Date('2026-08-20T10:29:00.000Z'), generateSeed });
    expect(later.cycle_id).toBe(cycle.cycle_id);
    const afterSecond = await getCycleMarketPhases(db, cycle.cycle_id);
    expect(afterSecond.length).toBeGreaterThanOrEqual(afterFirst.length);
    expect(afterSecond.slice(0, afterFirst.length)).toEqual(afterFirst);
    const pure = buildPhaseChain({
      seed: SEED, startTime: new Date(startMs), endTime: new Date(endMs), lifecycleState: 'GROWTH'
    });
    expect(canonical(afterSecond)).toEqual(canonicalPure(pure));
    const currentLate = await getCurrentMarketPhase(db, cycle.cycle_id, new Date('2026-08-20T10:29:00.000Z'));
    expect(currentLate).not.toBeNull();
    // One primary phase at every sampled instant of the live cycle.
    const phases = await getCycleMarketPhases(db, cycle.cycle_id);
    for (let t = startMs; t < endMs; t += 30000) {
      const covering = phases.filter(
        (p) => new Date(p.starts_at).getTime() <= t && t < new Date(p.ends_at).getTime()
      );
      expect(covering).toHaveLength(1);
    }
  });
});
