const path = require('path');
const db = require('../db/connection');
const {
  reconcileCycle,
  getGameState,
  deriveProgress,
  validateGameCycleDurationMs,
  DEFAULT_GAME_CYCLE_DURATION_MS,
  MIN_GAME_CYCLE_DURATION_MS,
  MAX_GAME_CYCLE_DURATION_MS
} = require('../game/gameCycleService');

describe('Core 1: global apocalypse cycle service', () => {
  test('creates the initial active cycle with public id, persisted seed and default 30 minute duration', async () => {
    const now = new Date('2026-08-20T10:07:00.000Z');
    const cycle = await reconcileCycle({ now });

    expect(cycle.apocalypse_id).toBe('APOC-0001');
    expect(cycle.status).toBe('ACTIVE');
    expect(Number(cycle.duration_ms)).toBe(30 * 60 * 1000);
    expect(typeof cycle.seed).toBe('string');
    expect(cycle.seed.length).toBeGreaterThan(0);

    // Row is actually persisted
    const { rows } = await db.query('SELECT * FROM apocalypse_cycles');
    expect(rows).toHaveLength(1);
    expect(rows[0].apocalypse_id).toBe('APOC-0001');
    expect(rows[0].seed).toBe(cycle.seed);
  });

  test('aligns a newly created default-duration cycle to the containing half-hour UTC boundary', async () => {
    const now = new Date('2026-08-20T10:07:23.456Z');
    const cycle = await reconcileCycle({ now });

    expect(new Date(cycle.start_time).toISOString()).toBe('2026-08-20T10:00:00.000Z');
    expect(new Date(cycle.end_time).toISOString()).toBe('2026-08-20T10:30:00.000Z');
  });

  test('does not align custom-duration cycles to half-hour boundaries', async () => {
    const now = new Date('2026-08-20T10:07:23.456Z');
    const cycle = await reconcileCycle({ now, durationMs: 10 * 60 * 1000 });

    expect(new Date(cycle.start_time).toISOString()).toBe('2026-08-20T10:07:23.456Z');
    expect(new Date(cycle.end_time).toISOString()).toBe('2026-08-20T10:17:23.456Z');
  });

  describe('configurable duration', () => {
    const ORIGINAL_ENV = process.env.GAME_CYCLE_DURATION_MS;
    afterEach(() => {
      if (ORIGINAL_ENV === undefined) delete process.env.GAME_CYCLE_DURATION_MS;
      else process.env.GAME_CYCLE_DURATION_MS = ORIGINAL_ENV;
    });

    test('uses GAME_CYCLE_DURATION_MS when set to a valid positive number', async () => {
      process.env.GAME_CYCLE_DURATION_MS = String(10 * 60 * 1000);
      const now = new Date('2026-08-20T10:07:23.456Z');
      const cycle = await reconcileCycle({ now });

      expect(Number(cycle.duration_ms)).toBe(10 * 60 * 1000);
      expect(new Date(cycle.end_time).getTime() - new Date(cycle.start_time).getTime())
        .toBe(10 * 60 * 1000);
    });

    test.each([
      ['absent', undefined],
      ['empty string', '   ']
    ])('uses the 30 minute default when GAME_CYCLE_DURATION_MS is %s', async (_label, value) => {
      if (value === undefined) delete process.env.GAME_CYCLE_DURATION_MS;
      else process.env.GAME_CYCLE_DURATION_MS = value;

      const cycle = await reconcileCycle({ now: new Date('2026-08-20T10:07:23.456Z') });
      expect(Number(cycle.duration_ms)).toBe(30 * 60 * 1000);
    });

    test.each([
      ['non-numeric', 'not-a-number'],
      ['fractional string', '60000.5'],
      ['exponent notation', '6e4'],
      ['zero', '0'],
      ['negative', '-5000'],
      ['NaN', 'NaN'],
      ['Infinity', 'Infinity'],
      ['-Infinity', '-Infinity'],
      ['below minimum', String(MIN_GAME_CYCLE_DURATION_MS - 1)],
      ['above maximum', String(MAX_GAME_CYCLE_DURATION_MS + 1)]
    ])('throws a clear error and creates no row when GAME_CYCLE_DURATION_MS is %s', async (_label, value) => {
      process.env.GAME_CYCLE_DURATION_MS = value;

      await expect(reconcileCycle({ now: new Date('2026-08-20T10:07:23.456Z') }))
        .rejects.toThrow(/GAME_CYCLE_DURATION_MS/);

      const { rows } = await db.query('SELECT * FROM apocalypse_cycles');
      expect(rows).toHaveLength(0);
    });

    test('invalid configured duration also aborts rollover before a successor row is created', async () => {
      await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

      process.env.GAME_CYCLE_DURATION_MS = '0';
      await expect(reconcileCycle({ now: new Date('2026-08-20T10:45:00.000Z') }))
        .rejects.toThrow(/GAME_CYCLE_DURATION_MS/);

      // Predecessor is untouched: still ACTIVE, no successor created.
      const { rows } = await db.query('SELECT * FROM apocalypse_cycles');
      expect(rows).toHaveLength(1);
      expect(rows[0].status).toBe('ACTIVE');
    });

    test('validateGameCycleDurationMs accepts the exact min/max boundaries and plain integers', () => {
      expect(validateGameCycleDurationMs(undefined)).toBe(DEFAULT_GAME_CYCLE_DURATION_MS);
      expect(validateGameCycleDurationMs(String(MIN_GAME_CYCLE_DURATION_MS))).toBe(MIN_GAME_CYCLE_DURATION_MS);
      expect(validateGameCycleDurationMs(String(MAX_GAME_CYCLE_DURATION_MS))).toBe(MAX_GAME_CYCLE_DURATION_MS);
      expect(validateGameCycleDurationMs(MIN_GAME_CYCLE_DURATION_MS)).toBe(MIN_GAME_CYCLE_DURATION_MS);
      expect(validateGameCycleDurationMs(10 * 60 * 1000)).toBe(10 * 60 * 1000);
    });

    test.each([
      ['fractional number', 60000.5],
      ['NaN number', NaN],
      ['Infinity number', Infinity],
      ['boolean', true],
      ['object', {}],
      ['zero number', 0],
      ['negative number', -1]
    ])('validateGameCycleDurationMs rejects %s without coercion', (_label, value) => {
      expect(() => validateGameCycleDurationMs(value)).toThrow(/GAME_CYCLE_DURATION_MS/);
    });

    test('uses the currently configured duration for a successor after rollover', async () => {
      process.env.GAME_CYCLE_DURATION_MS = String(10 * 60 * 1000);
      await reconcileCycle({ now: new Date('2026-08-20T10:00:00.000Z') });

      process.env.GAME_CYCLE_DURATION_MS = String(20 * 60 * 1000);
      const successor = await reconcileCycle({ now: new Date('2026-08-20T10:10:00.000Z') });

      expect(successor.apocalypse_id).toBe('APOC-0002');
      expect(Number(successor.duration_ms)).toBe(20 * 60 * 1000);
      expect(new Date(successor.start_time).toISOString()).toBe('2026-08-20T10:10:00.000Z');
      expect(new Date(successor.end_time).toISOString()).toBe('2026-08-20T10:30:00.000Z');
    });
  });

  describe('derived state', () => {
    test('getGameState derives remainingMs and apocalypsePercent from the persisted window', async () => {
      await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

      const state = await getGameState({ now: new Date('2026-08-20T10:15:00.000Z') });

      expect(state.apocalypseId).toBe('APOC-0001');
      expect(state.status).toBe('ACTIVE');
      expect(state.startTime).toBe('2026-08-20T10:00:00.000Z');
      expect(state.endTime).toBe('2026-08-20T10:30:00.000Z');
      expect(state.durationMs).toBe(30 * 60 * 1000);
      expect(state.remainingMs).toBe(15 * 60 * 1000);
      expect(state.apocalypsePercent).toBe(50);
      // Milestone 1: the public state contract no longer carries the seed.
      expect(state).not.toHaveProperty('seed');
      expect(state.serverTime).toBe('2026-08-20T10:15:00.000Z');
    });

    test('reports zero percent and full remaining time at the exact cycle start', async () => {
      await reconcileCycle({ now: new Date('2026-08-20T10:00:00.000Z') });
      const state = await getGameState({ now: new Date('2026-08-20T10:00:00.000Z') });

      expect(state.apocalypsePercent).toBe(0);
      expect(state.remainingMs).toBe(30 * 60 * 1000);
    });

    test('deriveProgress clamps apocalypsePercent to 0..100 and remainingMs to >= 0', () => {
      const startTime = '2026-08-20T10:00:00.000Z';
      const endTime = '2026-08-20T10:30:00.000Z';
      const durationMs = 30 * 60 * 1000;

      // Before start: 0%, full duration remaining.
      expect(deriveProgress({ startTime, endTime, durationMs, now: new Date('2026-08-20T09:50:00.000Z') }))
        .toEqual({ remainingMs: 40 * 60 * 1000, apocalypsePercent: 0 });

      // Beyond the nominal duration: percent clamps to 100, remaining clamps at 0.
      expect(deriveProgress({ startTime, endTime, durationMs, now: new Date('2026-08-20T10:45:00.000Z') }))
        .toEqual({ remainingMs: 0, apocalypsePercent: 100 });

      // Mid-cycle: exact proportional progress.
      expect(deriveProgress({ startTime, endTime, durationMs, now: new Date('2026-08-20T10:07:30.000Z') }))
        .toEqual({ remainingMs: 22.5 * 60 * 1000, apocalypsePercent: 25 });
    });
  });

  describe('recovery and rollover', () => {
    test('restart-style recovery returns the same persisted active cycle instead of resetting it', async () => {
      const first = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
      const second = await reconcileCycle({ now: new Date('2026-08-20T10:12:00.000Z') });

      expect(second.cycle_id).toBe(first.cycle_id);
      expect(second.apocalypse_id).toBe('APOC-0001');
      expect(second.seed).toBe(first.seed);

      const { rows } = await db.query('SELECT * FROM apocalypse_cycles');
      expect(rows).toHaveLength(1);
    });

    test('a second process instance recovers the same persisted active cycle', async () => {
      const first = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });
      const projectRoot = path.resolve(__dirname, '..');
      const gameCycleService = JSON.stringify(path.join(projectRoot, 'game', 'gameCycleService'));
      const dbConnection = JSON.stringify(path.join(projectRoot, 'db', 'connection'));

      const script = `
        const { getGameState } = require(${gameCycleService});
        const db = require(${dbConnection});
        getGameState({ now: new Date('2026-08-20T10:12:00.000Z') }).then(async (state) => {
          console.log(JSON.stringify(state));
          await db.end();
        }).catch((err) => { console.error(err.message); process.exit(1); });
      `;
      const { spawnSync } = require('child_process');
      const result = spawnSync(process.execPath, ['-e', script], {
        env: { ...process.env, NODE_ENV: 'test' },
        encoding: 'utf8',
        cwd: projectRoot
      });

      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split(String.fromCharCode(10));
      const state = JSON.parse(lines[lines.length - 1]);
      expect(state.apocalypseId).toBe(first.apocalypse_id);
      // Public state carries no seed; the second process recovered the same
      // persisted cycle, whose seed remains internal and unchanged.
      expect(state).not.toHaveProperty('seed');
      const { rows: seedRows } = await db.query(
        'SELECT seed FROM apocalypse_cycles WHERE cycle_id = $1',
        [first.cycle_id]
      );
      expect(seedRows[0].seed).toBe(first.seed);

      const { rows } = await db.query('SELECT * FROM apocalypse_cycles');
      expect(rows).toHaveLength(1);
    });

    test('completes an expired cycle and rolls into exactly one chained successor', async () => {
      const first = await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

      const state = await getGameState({ now: new Date('2026-08-20T10:31:00.000Z') });

      expect(state.apocalypseId).toBe('APOC-0002');
      expect(state.status).toBe('ACTIVE');
      // Successor chains from the predecessor's end: no gap, no overlap.
      expect(state.startTime).toBe('2026-08-20T10:30:00.000Z');
      expect(state.endTime).toBe('2026-08-20T11:00:00.000Z');

      const { rows } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
      expect(rows).toHaveLength(2);
      expect(rows[0].cycle_id).toBe(first.cycle_id);
      expect(rows[0].status).toBe('COMPLETED');
      expect(rows[1].status).toBe('ACTIVE');
      // The expired round keeps its original window.
      expect(new Date(rows[0].end_time).toISOString()).toBe('2026-08-20T10:30:00.000Z');
    });

    test('recovers correctly after downtime spanning multiple cycles', async () => {
      await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

      // 2h38m later: five 30-minute cycles have fully elapsed.
      const state = await getGameState({ now: new Date('2026-08-20T12:45:00.000Z') });

      expect(state.status).toBe('ACTIVE');
      expect(state.startTime).toBe('2026-08-20T12:30:00.000Z');
      expect(state.endTime).toBe('2026-08-20T13:00:00.000Z');

      const { rows } = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
      expect(rows).toHaveLength(6);
      expect(rows.filter(r => r.status === 'ACTIVE')).toHaveLength(1);
      expect(rows.slice(0, 5).every(r => r.status === 'COMPLETED')).toBe(true);
      // Contiguous half-hour chain with sequential public ids.
      for (let i = 0; i < rows.length; i++) {
        expect(rows[i].apocalypse_id).toBe(`APOC-000${i + 1}`);
        if (i > 0) {
          expect(new Date(rows[i].start_time).getTime())
            .toBe(new Date(rows[i - 1].end_time).getTime());
        }
      }
    });

    test('database enforces the single-active-cycle invariant', async () => {
      await reconcileCycle({ now: new Date('2026-08-20T10:07:00.000Z') });

      await expect(
        db.query(
          `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
           VALUES ('APOC-9999', 'rogue-seed', now(), now() + interval '30 minutes', 1800000, 'ACTIVE')`
        )
      ).rejects.toMatchObject({ code: '23505' });

      const { rows } = await db.query("SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE'");
      expect(rows).toHaveLength(1);
    });

    test('concurrent startup callers cannot create overlapping active cycles', async () => {
      const now = new Date('2026-08-20T10:07:00.000Z');
      const results = await Promise.all(
        Array.from({ length: 8 }, () => reconcileCycle({ now }))
      );

      const ids = new Set(results.map(r => r.cycle_id));
      expect(ids.size).toBe(1);
      expect(results.every(r => r.apocalypse_id === 'APOC-0001')).toBe(true);

      const { rows } = await db.query('SELECT * FROM apocalypse_cycles');
      expect(rows).toHaveLength(1);
    });
  });
});
