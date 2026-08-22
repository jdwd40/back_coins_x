// Core 5: bot worker lifecycle.
//
// One lifecycle-owned worker, started/stopped explicitly by the application
// bootstrap (production only, mirroring the game cycle worker). No timers at
// import time, duplicate starts are a no-op, stop is idempotent, and a
// disabled config keeps the worker stopped. Timer wakeups compute a single
// deterministic tick id and delegate to the pg-backed tick authority.

const db = require('../db/connection');
const botWorker = require('../game/botWorker');
const botConfig = require('../game/botConfig');

const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

describe('Core 5: bot worker lifecycle', () => {
  const ENV_KEYS = [
    'GAME_BOTS_ENABLED',
    'GAME_BOT_TICK_INTERVAL_MS',
    'GAME_BOT_MAX_TRADE_SIZE',
    'GAME_BOT_COOLDOWN_MS',
    'GAME_BOT_MAX_ACTIONS_PER_TICK'
  ];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
    botWorker.stop();
  });
  afterEach(async () => {
    botWorker.stop();
    // A tick kicked off by a fake-timers test is real asynchronous database
    // work: drain it BEFORE the next test's seed, so an in-flight tick can
    // never interleave with DROP TABLE (deadlock) or mutate a fresh seed.
    if (botWorker.inFlight) await botWorker.inFlight;
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('does not start timers at import time', () => {
    jest.isolateModules(() => {
      const fresh = require('../game/botWorker');
      expect(fresh.isRunning()).toBe(false);
    });
  });

  test('start() runs an immediate tick that provisions and autojoins the roster', async () => {
    const { reconcileCycle } = require('../game/gameCycleService');
    await reconcileCycle({ now: new Date(), durationMs: LONG_DURATION_MS });

    botWorker.start();
    await botWorker.lastTick;

    const { rows: bots } = await db.query('SELECT count(*)::int AS n FROM users WHERE is_bot = true');
    expect(bots[0].n).toBe(4);
    const { rows: participants } = await db.query(
      `SELECT count(*)::int AS n FROM apocalypse_participants p
       JOIN users u ON u.user_id = p.user_id WHERE u.is_bot = true`
    );
    expect(participants[0].n).toBe(4); // #17: human participants also exist
  });

  test('duplicate in-process start() calls do not create duplicate timers', () => {
    // Only the scheduling primitives are faked: setImmediate/nextTick must
    // stay real, or the pg driver's internals stall mid-query and the
    // immediate tick's in-flight database work never settles (the afterEach
    // drain would then time out).
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick'] });
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    try {
      botWorker.start();
      botWorker.start();
      botWorker.start();
      expect(botWorker.isRunning()).toBe(true);
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    } finally {
      botWorker.stop();
      jest.useRealTimers();
    }
    expect(botWorker.isRunning()).toBe(false);
  });

  test('a disabled config keeps the worker stopped', () => {
    process.env.GAME_BOTS_ENABLED = 'false';
    botWorker.start();
    expect(botWorker.isRunning()).toBe(false);
  });

  test('the worker computes the deterministic tick id from the shared interval quantum', () => {
    const interval = botConfig.DEFAULT_BOT_TICK_INTERVAL_MS;
    expect(botWorker.tickIdFor(new Date(3 * interval + 123))).toBe(3);
    expect(botWorker.tickIdFor(new Date(0))).toBe(0);
  });
});
