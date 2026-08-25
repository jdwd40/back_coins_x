// Migration runner + schema verification coverage for Crypto Chaos V2-2
// Power + cost basis (migration 018: apocalypse_participants.power /
// power_updated_at, apocalypse_holdings.cost_basis with the deterministic
// ledger backfill).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { reconcileCycle } = require('../game/gameCycleService');
const { joinRound, buyRoundTrade, sellRoundTrade } = require('../game/gameRoundService');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_018 = '018_v2_power_and_cost_basis.sql';
const LONG_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

function round2(value) {
  return Math.round(value * 100) / 100;
}

// Simulate the pre-V2-2 schema on top of existing data: the three V2-2
// columns (and their CHECK constraints, which drop with the columns) plus
// the tracking row removed.
async function revert018() {
  await db.query('ALTER TABLE apocalypse_participants DROP COLUMN IF EXISTS power, DROP COLUMN IF EXISTS power_updated_at');
  await db.query('ALTER TABLE apocalypse_holdings DROP COLUMN IF EXISTS cost_basis');
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_018]);
}

async function columnShape(table, column) {
  const { rows } = await db.query(
    `SELECT data_type, numeric_precision, numeric_scale, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows[0] || null;
}

async function buildLedgerScenario() {
  const now = new Date();
  const cycle = await reconcileCycle({ now, durationMs: LONG_DURATION_MS });
  const participant = await joinRound({ userId: 1, now });
  await db.query('UPDATE coins SET current_price = 10 WHERE coin_id = 1');
  await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 10, now }); // £100
  await db.query('UPDATE coins SET current_price = 20 WHERE coin_id = 1');
  await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 10, now }); // £200
  await sellRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 5, now });  // basis 300 -> 225
  await db.query('UPDATE coins SET current_price = 5 WHERE coin_id = 2');
  await buyRoundTrade({ userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 2, quantity: 7.12345678, now });
  return { cycle, participant };
}

describe('V2-2: tracked production migration 018 (Power + cost basis)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('the seeded test schema carries the V2-2 columns with the exact expected shapes and verifies clean', async () => {
    const power = await columnShape('apocalypse_participants', 'power');
    expect(power.data_type).toBe('integer');
    expect(power.is_nullable).toBe('NO');
    const stamp = await columnShape('apocalypse_participants', 'power_updated_at');
    expect(stamp.data_type).toBe('timestamp with time zone');
    expect(stamp.is_nullable).toBe('NO');
    const basis = await columnShape('apocalypse_holdings', 'cost_basis');
    expect(basis.data_type).toBe('numeric');
    expect(Number(basis.numeric_precision)).toBe(18);
    expect(Number(basis.numeric_scale)).toBe(2);
    expect(basis.is_nullable).toBe('NO');

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });

  test('applies 018 to an existing database, preserving all data and backfilling cost basis deterministically from the ledger', async () => {
    const { participant } = await buildLedgerScenario();

    // Snapshot the live-maintained values the backfill must reproduce.
    const holdingsBefore = (await db.query(
      'SELECT holding_id, coin_id, quantity, cost_basis FROM apocalypse_holdings WHERE participant_id = $1 ORDER BY coin_id',
      [participant.participantId]
    )).rows;
    expect(holdingsBefore).toHaveLength(2);
    expect(parseFloat(holdingsBefore[0].cost_basis)).toBe(225); // 300 * 15/20

    const participantsBefore = (await db.query(
      'SELECT participant_id, cycle_id, user_id, starting_cash, current_cash, peak_wealth, status FROM apocalypse_participants ORDER BY participant_id'
    )).rows;
    const txBefore = (await db.query('SELECT * FROM apocalypse_transactions ORDER BY round_transaction_id')).rows;

    await revert018();
    expect(await columnShape('apocalypse_holdings', 'cost_basis')).toBeNull();
    expect(await columnShape('apocalypse_participants', 'power')).toBeNull();

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_018);

    // Backfill reproduced the exact live-maintained cost basis by replaying
    // the immutable ledger (BUY adds rounded totals; SELL removes the
    // proportionate share).
    const holdingsAfter = (await db.query(
      'SELECT holding_id, coin_id, quantity, cost_basis FROM apocalypse_holdings WHERE participant_id = $1 ORDER BY coin_id',
      [participant.participantId]
    )).rows;
    expect(holdingsAfter).toEqual(holdingsBefore);

    // Power backfill: every pre-existing participant at the full game-design
    // maximum with a fresh stamp.
    const { rows: powers } = await db.query('SELECT power, power_updated_at FROM apocalypse_participants');
    expect(powers.length).toBeGreaterThan(0);
    for (const row of powers) {
      expect(Number(row.power)).toBe(100);
      expect(row.power_updated_at).toBeTruthy();
    }

    // Existing participant/ledger data untouched.
    const participantsAfter = (await db.query(
      'SELECT participant_id, cycle_id, user_id, starting_cash, current_cash, peak_wealth, status FROM apocalypse_participants ORDER BY participant_id'
    )).rows;
    expect(participantsAfter).toEqual(participantsBefore);
    const txAfter = (await db.query('SELECT * FROM apocalypse_transactions ORDER BY round_transaction_id')).rows;
    expect(txAfter).toEqual(txBefore);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('a rerun after losing only the tracking row is a safe no-op and never re-backfills live values', async () => {
    const { participant } = await buildLedgerScenario();
    // Live trades have moved the basis since any backfill would have run.
    await db.query('UPDATE apocalypse_holdings SET cost_basis = 111.11 WHERE participant_id = $1 AND coin_id = 1', [participant.participantId]);
    await db.query('UPDATE apocalypse_participants SET power = 42 WHERE participant_id = $1', [participant.participantId]);

    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_018]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_018);

    // Correctly-shaped pre-existing columns are left exactly as found.
    const { rows: h } = await db.query('SELECT cost_basis FROM apocalypse_holdings WHERE participant_id = $1 AND coin_id = 1', [participant.participantId]);
    expect(parseFloat(h[0].cost_basis)).toBe(111.11);
    const { rows: p } = await db.query('SELECT power FROM apocalypse_participants WHERE participant_id = $1', [participant.participantId]);
    expect(Number(p[0].power)).toBe(42);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('an incompatible pre-existing column aborts the migration and records nothing', async () => {
    await revert018();
    await db.query('ALTER TABLE apocalypse_holdings ADD COLUMN cost_basis DECIMAL(18, 4) NOT NULL DEFAULT 0');

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/migration 018/);

    const { rows } = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_018]);
    expect(rows).toHaveLength(0);
    const shape = await columnShape('apocalypse_holdings', 'cost_basis');
    expect(Number(shape.numeric_scale)).toBe(4); // untouched
    expect(await columnShape('apocalypse_participants', 'power')).toBeNull(); // whole file rolled back
  });

  test('a ledger anomaly aborts the backfill instead of guessing a cost basis', async () => {
    const { cycle, participant } = await buildLedgerScenario();
    // Corrupt the replay: an extra SELL the holding quantity does not cover.
    await db.query(
      `INSERT INTO apocalypse_transactions (participant_id, cycle_id, user_id, coin_id, type, quantity, price, total_amount)
       VALUES ($1, $2, 1, 1, 'SELL', 999, 1, 999)`,
      [participant.participantId, cycle.cycle_id]
    );
    await revert018();

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/migration 018: ledger anomaly/);
    const { rows } = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_018]);
    expect(rows).toHaveLength(0);
    expect(await columnShape('apocalypse_holdings', 'cost_basis')).toBeNull();
  });
});
