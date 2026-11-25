describe('persistent replacement worker reserve alerts', () => {
  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  test('warns before the reserve is depleted and reports an exhausted reserve with visible pending work', async () => {
    const reconcilePersistentReplacements = jest.fn()
      .mockResolvedValueOnce({
        stateReady: true,
        retiredCoinIds: [],
        inserted: [],
        activeAfter: 10,
        reserveLow: true,
        reserveRemaining: 5,
        reserveExhausted: false,
        pendingEligibleDeathsAfter: 0
      })
      .mockResolvedValueOnce({
        stateReady: true,
        retiredCoinIds: [117],
        inserted: [],
        activeAfter: 9,
        reserveLow: true,
        reserveRemaining: 0,
        reserveExhausted: true,
        pendingEligibleDeathsAfter: 1
      });
    const logger = { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    jest.isolateModules(() => {
      jest.doMock('../game/persistentReplacementRuntime', () => ({ reconcilePersistentReplacements }));
      jest.doMock('../utils/logger', () => logger);
      const worker = require('../game/persistentReplacementWorker');
      worker.runTick(new Date('2026-01-01T00:00:00.000Z'));
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/reserve low.*5/i));

    jest.isolateModules(() => {
      jest.doMock('../game/persistentReplacementRuntime', () => ({ reconcilePersistentReplacements }));
      jest.doMock('../utils/logger', () => logger);
      const worker = require('../game/persistentReplacementWorker');
      worker.runTick(new Date('2026-01-01T00:01:00.000Z'));
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/reserve exhausted.*1 eligible death/i));
  });

  test('does not report a reserve shortage before persistent state is initialized', async () => {
    const reconcilePersistentReplacements = jest.fn().mockResolvedValue({
      stateReady: false,
      retiredCoinIds: [],
      inserted: [],
      activeAfter: 0,
      reserveLow: false,
      reserveExhausted: false
    });
    const logger = { log: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };

    jest.isolateModules(() => {
      jest.doMock('../game/persistentReplacementRuntime', () => ({ reconcilePersistentReplacements }));
      jest.doMock('../utils/logger', () => logger);
      require('../game/persistentReplacementWorker').runTick(new Date('2026-01-01T00:00:00.000Z'));
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
