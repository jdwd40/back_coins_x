const db = require('../db/connection');
const gameCycleWorker = require('../game/gameCycleWorker');

describe('Core 1: game cycle worker lifecycle', () => {
  beforeEach(() => {
    gameCycleWorker.stop();
  });

  afterEach(() => {
    gameCycleWorker.stop();
  });

  test('does not start timers at import time', () => {
    jest.isolateModules(() => {
      const fresh = require('../game/gameCycleWorker');
      expect(fresh.isRunning()).toBe(false);
    });
  });

  test('importing the Express application never starts the game worker', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const worker = { start: jest.fn(), stop: jest.fn(), isRunning: jest.fn(() => false) };

    try {
      process.env.NODE_ENV = 'production';
      jest.isolateModules(() => {
        jest.doMock('../game/gameCycleWorker', () => worker);
        jest.doMock('../models/market-simulator', () => ({ start: jest.fn(), stop: jest.fn() }));
        require('../app');
      });
      expect(worker.start).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      jest.dontMock('../game/gameCycleWorker');
      jest.dontMock('../models/market-simulator');
    }
  });

  test('start() performs initial maintenance that creates the global cycle', async () => {
    gameCycleWorker.start();
    await gameCycleWorker.lastMaintenance;

    const { rows } = await db.query("SELECT * FROM apocalypse_cycles WHERE status = 'ACTIVE'");
    expect(rows).toHaveLength(1);
    expect(rows[0].apocalypse_id).toBe('APOC-0001');
  });

  test('duplicate in-process start() calls do not create duplicate timers', async () => {
    jest.useFakeTimers();
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    try {
      gameCycleWorker.start();
      gameCycleWorker.start();
      gameCycleWorker.start();
      expect(gameCycleWorker.isRunning()).toBe(true);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      gameCycleWorker.stop();
      jest.useRealTimers();
    }
    expect(gameCycleWorker.isRunning()).toBe(false);
  });

  test('timer wakeup recovers an expired cycle via the database authority', async () => {
    // Controlled stored state: an active cycle that expired 2 minutes ago.
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'controlled-seed', now() - interval '62 minutes', now() - interval '2 minutes', 3600000, 'ACTIVE')`
    );

    gameCycleWorker.intervalMs = 50;
    gameCycleWorker.start();

    // Poll the database until the worker's timer maintenance rolls the cycle over.
    const deadline = Date.now() + 5000;
    let rows = [];
    while (Date.now() < deadline) {
      const result = await db.query('SELECT * FROM apocalypse_cycles ORDER BY cycle_id');
      rows = result.rows;
      const active = rows.filter(r => r.status === 'ACTIVE');
      if (active.length === 1 && new Date(active[0].end_time).getTime() > Date.now()) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }

    const active = rows.filter(r => r.status === 'ACTIVE');
    expect(active).toHaveLength(1);
    expect(new Date(active[0].end_time).getTime()).toBeGreaterThan(Date.now());
    expect(rows[0].status).toBe('COMPLETED');
    expect(rows.some(r => r.apocalypse_id === 'APOC-0002')).toBe(true);
  });
});
