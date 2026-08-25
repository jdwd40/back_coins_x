// Migration runner + schema verification coverage for Crypto Chaos Core 4.
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins schema
// and data (via jest.setup.js beforeEach) that migration 009 must preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_009 = '009_create_apocalypse_round_state.sql';
const MIGRATION_011 = '011_create_apocalypse_results.sql';
const MIGRATION_012 = '012_fractional_round_quantities.sql';

// Simulate the pre-Core-4 production state: Coins schema + data + Core 1/3
// game tables, but no round-state tables. The Core 6 results table and the
// issue #18 cash-event ledger carry composite FKs into
// apocalypse_participants, so dropping participants CASCADE would silently
// strip those FKs; the simulation removes the dependent objects explicitly
// first, and re-running applies 009, 011 AND 016 in order. Migration
// 012 only ALTERS the two quantity columns (no new tables), so no schema
// drop is needed for it — its tracking row is removed so the rerun re-applies
// the DECIMAL(18,2) -> DECIMAL(18,8) widening on the freshly recreated tables.
async function dropCore4Schema() {
  await db.query('DROP TABLE IF EXISTS apocalypse_results CASCADE');
  await db.query('DROP FUNCTION IF EXISTS apocalypse_results_immutable()');
  await db.query('DROP TABLE IF EXISTS apocalypse_cash_events CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_transactions CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_holdings CASCADE');
  await db.query('DROP TABLE IF EXISTS apocalypse_participants CASCADE');
}

// Migration 015 (leaderboard_eligible) alters apocalypse_results, which
// dropCore4Schema drops — its tracking row must be cleared too so
// runMigrations restores the canonical post-#19 schema. Migration 016
// (issue #18 economy) recreates apocalypse_cash_events; its other tables
// (apocalypse_economy_ticks/events) survive and are shape-verified no-ops.
const MIGRATION_015 = '015_leaderboard_eligible.sql';
const MIGRATION_016 = '016_create_apocalypse_economy.sql';
// Migration 017 (V2-1 price precision) widens apocalypse_transactions.price,
// which 009 recreates at 2dp — its tracking row must be cleared alongside
// Core 4's so the simulated pre-Core-4 state converges to the canonical
// post-V2 schema.
const MIGRATION_017 = '017_v2_price_precision.sql';

async function dropCore4Tracking() {
  await db.query('DELETE FROM schema_migrations WHERE migration = ANY($1)', [[MIGRATION_009, MIGRATION_011, MIGRATION_012, MIGRATION_015, MIGRATION_016, MIGRATION_017]]);
}

describe('Core 4: tracked production migration 009', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 009 to an existing Coins database, preserving all legacy and Core 1/3 data', async () => {
    // Give the "existing" database observable legacy data that must survive.
    await db.query(`INSERT INTO portfolios (user_id, coin_id, quantity) VALUES (1, 1, 12.50)`);
    await db.query(
      `INSERT INTO transactions (user_id, coin_id, type, quantity, price, total_amount)
       VALUES (1, 1, 'BUY', 12.50, 10.00, 125.00)`
    );
    const usersBefore = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsBefore = await db.query('SELECT count(*)::int AS n FROM coins');
    const cyclesBefore = await db.query('SELECT count(*)::int AS n FROM apocalypse_cycles');

    await dropCore4Schema();
    await dropCore4Tracking();

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toEqual([MIGRATION_009, MIGRATION_011, MIGRATION_012, MIGRATION_015, MIGRATION_016, MIGRATION_017]); // Core 4, Core 6, 012 widening, #19 eligibility column, #18 economy ledger, V2-1 price precision

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);

    // Legacy data fully preserved.
    const usersAfter = await db.query('SELECT count(*)::int AS n FROM users');
    const coinsAfter = await db.query('SELECT count(*)::int AS n FROM coins');
    const cyclesAfter = await db.query('SELECT count(*)::int AS n FROM apocalypse_cycles');
    expect(usersAfter.rows[0].n).toBe(usersBefore.rows[0].n);
    expect(coinsAfter.rows[0].n).toBe(coinsBefore.rows[0].n);
    expect(cyclesAfter.rows[0].n).toBe(cyclesBefore.rows[0].n);
    const { rows: pf } = await db.query('SELECT quantity FROM portfolios WHERE user_id = 1 AND coin_id = 1');
    expect(parseFloat(pf[0].quantity)).toBe(12.5);
    const { rows: tx } = await db.query('SELECT total_amount FROM transactions WHERE user_id = 1');
    expect(parseFloat(tx[0].total_amount)).toBe(125);
    const { rows: funds } = await db.query('SELECT funds FROM users WHERE user_id = 1');
    expect(parseFloat(funds[0].funds)).toBe(1000);

    // Round-state tables start empty — no participant state is fabricated.
    for (const t of ['apocalypse_participants', 'apocalypse_holdings', 'apocalypse_transactions', 'apocalypse_results']) {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${t}`);
      expect(rows[0].n).toBe(0);
    }
  });

  test('database uniqueness blocks duplicate participants and duplicate logical holdings', async () => {
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'm009-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 1000, 1000, 1000, 'ACTIVE')`
    );
    // Duplicate (cycle_id, user_id) participant is rejected by the database.
    await expect(
      db.query(
        `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
         VALUES (1, 1, 1000, 1000, 1000, 'ACTIVE')`
      )
    ).rejects.toThrow(/duplicate key/);

    await db.query(
      `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity)
       VALUES (1, 1, 1, 1, 5)`
    );
    // Duplicate logical (participant_id, coin_id) holding is rejected.
    await expect(
      db.query(
        `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity)
         VALUES (1, 1, 1, 1, 3)`
      )
    ).rejects.toThrow(/duplicate key/);

    // Denormalised cycle/user mismatch against the participant is rejected
    // by the composite foreign key.
    await expect(
      db.query(
        `INSERT INTO apocalypse_holdings (participant_id, cycle_id, user_id, coin_id, quantity)
         VALUES (1, 1, 2, 2, 3)`
      )
    ).rejects.toThrow(/violates foreign key/);
    await expect(
      db.query(
        `INSERT INTO apocalypse_transactions
           (participant_id, cycle_id, user_id, coin_id, type, quantity, price, total_amount)
         VALUES (1, 1, 2, 1, 'BUY', 1, 10, 10)`
      )
    ).rejects.toThrow(/violates foreign key/);
  });

  test('safe rerun: tracked migration is skipped entirely', async () => {
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toEqual([]);
    expect(rerun.skipped).toContain(MIGRATION_009);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('SQL-level rerun on compatible existing objects is a verified no-op that preserves rows', async () => {
    // Persist round-state rows, then lose only the tracking row: the runner
    // re-executes 009 against the existing compatible tables, detects
    // compatibility, and records it again without touching data.
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'm009-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'ACTIVE')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 1000, 750, 1250, 'ACTIVE')`
    );
    await dropCore4Tracking();

    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_009);

    const { rows } = await db.query('SELECT current_cash, peak_wealth FROM apocalypse_participants');
    expect(rows).toHaveLength(1);
    expect(parseFloat(rows[0].current_cash)).toBe(750);
    expect(parseFloat(rows[0].peak_wealth)).toBe(1250);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(true);
  });

  test('fails clearly on an incompatible pre-existing apocalypse_participants table and records nothing', async () => {
    await dropCore4Schema();
    await dropCore4Tracking();
    await db.query('CREATE TABLE apocalypse_participants (participant_id integer)');

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);

    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_009]);
    expect(tracked.rows).toHaveLength(0);

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.length).toBeGreaterThan(0);
  });

  test('fails clearly on an incompatible pre-existing apocalypse_transactions table', async () => {
    await dropCore4Schema();
    await dropCore4Tracking();
    await db.query('CREATE TABLE apocalypse_transactions (round_transaction_id integer)');

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);

    const tracked = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_009]);
    expect(tracked.rows).toHaveLength(0);
  });

  test('verification fails clearly when Core 4 objects are absent', async () => {
    await dropCore4Schema();
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toContain('table public.apocalypse_participants does not exist');
    expect(verification.problems).toContain('table public.apocalypse_holdings does not exist');
    expect(verification.problems).toContain('table public.apocalypse_transactions does not exist');
  });

  test('verification catches a live invariant violation: ACTIVE participant on a COMPLETED cycle', async () => {
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status)
       VALUES ('APOC-0001', 'm009-seed', '2026-08-20T10:00:00Z', '2026-08-20T10:30:00Z', 1800000, 'COMPLETED')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status)
       VALUES (1, 1, 1000, 1000, 1000, 'ACTIVE')`
    );

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems.join(' ')).toMatch(/ACTIVE participants on COMPLETED cycles/);
  });
});
