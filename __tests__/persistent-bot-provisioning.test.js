// Persistent bot provisioning helpers — deterministic RNG + idempotent roster.

const db = require('../db/connection');
const { createBotRandom, ensureBotsProvisioned } = require('../game/persistentBotProvisioning');
const { BOT_ROSTER } = require('../game/botConfig');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(30000);

describe('persistentBotProvisioning', () => {
  test('createBotRandom is deterministic for identical inputs', () => {
    const a = createBotRandom({ seed: 's', botKey: 'conservative-carl', tickId: 3 });
    const b = createBotRandom({ seed: 's', botKey: 'conservative-carl', tickId: 3 });
    const seq = (rng) => Array.from({ length: 8 }, () => rng());
    expect(seq(a)).toEqual(seq(b));
  });

  test('createBotRandom diverges across botKey or tickId', () => {
    const base = createBotRandom({ seed: 's', botKey: 'conservative-carl', tickId: 3 })();
    const otherBot = createBotRandom({ seed: 's', botKey: 'momentum-mike', tickId: 3 })();
    const otherTick = createBotRandom({ seed: 's', botKey: 'conservative-carl', tickId: 4 })();
    expect(base).not.toBe(otherBot);
    expect(base).not.toBe(otherTick);
  });

  test('ensureBotsProvisioned is idempotent and returns the roster', async () => {
    assertDisposableTestDatabase();
    const first = await ensureBotsProvisioned({ queryable: db });
    const second = await ensureBotsProvisioned({ queryable: db });
    expect(first).toHaveLength(BOT_ROSTER.length);
    expect(second.map((b) => b.userId)).toEqual(first.map((b) => b.userId));
    expect(first.map((b) => b.botKey).sort()).toEqual(
      BOT_ROSTER.map((b) => b.botKey).sort()
    );
  });

  test('botService re-exports the same helpers (compat for retained cycle tests)', () => {
    const botService = require('../game/botService');
    expect(botService.createBotRandom).toBe(createBotRandom);
    expect(botService.ensureBotsProvisioned).toBe(ensureBotsProvisioned);
  });
});
