// Migration runner + schema verification coverage for Crypto Chaos
// issue #19 (profitable-only leaderboard qualification).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js is never used as a migration or
// verification mechanism here; it only provides the pre-existing Coins
// schema and data (via jest.setup.js beforeEach) that migration 015 must
// preserve.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_015 = '015_leaderboard_eligible.sql';

async function drop015() {
  await db.query('ALTER TABLE apocalypse_results DROP COLUMN IF EXISTS leaderboard_eligible');
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_015]);
}

describe('issue #19: tracked production migration 015', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('applies 015 to an existing results table and backfills eligibility with identical threshold semantics', async () => {
    // "Existing production data": a completed cycle with a full Core 6
    // snapshot captured BEFORE the column existed (legacy £1,000 rounds).
    await db.query(
      `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status, settled_at, settlement_started_at)
       VALUES ('APOC-0001', 'mig015-seed', now() - interval '2 hours', now() - interval '90 minutes', 1800000, 'COMPLETED', now() - interval '90 minutes', now() - interval '91 minutes')`
    );
    await db.query(
      `INSERT INTO apocalypse_participants (cycle_id, user_id, starting_cash, current_cash, peak_wealth, status, final_cash)
       VALUES (1, 1, 1000.00, 1250.00, 1250.00, 'FINALIZED', 1250.00),
              (1, 2, 1000.00, 750.00, 1000.00, 'FINALIZED', 750.00)`
    );
    await drop015(); // simulate the pre-#19 schema on top of existing data
    await db.query(
      `INSERT INTO apocalypse_results
        (cycle_id, participant_id, user_id, apocalypse_id, username, is_bot, bot_personality, rank, final_cash, peak_wealth, starting_cash, net_profit, joined_at, trade_count, buy_count, sell_count)
       SELECT p.cycle_id, p.participant_id, p.user_id, 'APOC-0001',
              CASE WHEN p.user_id = 1 THEN 'john_doe' ELSE 'jane_smith' END,
              false, NULL, p.user_id, p.final_cash, p.peak_wealth, p.starting_cash,
              p.final_cash - p.starting_cash, now() - interval '2 hours', 0, 0, 0
       FROM apocalypse_participants p
       WHERE p.cycle_id = 1`
    );

    await runMigrations({ log: () => {} });

    // Existing rows backfilled by the generated column with per-row
    // authoritative starting_cash semantics — no historical rewrite.
    const { rows } = await db.query(
      'SELECT user_id, final_cash, starting_cash, leaderboard_eligible FROM apocalypse_results ORDER BY user_id'
    );
    expect(rows.map((r) => [r.user_id, r.leaderboard_eligible])).toEqual([[1, true], [2, false]]);
    expect(parseFloat(rows[0].final_cash)).toBe(1250);
    expect(parseFloat(rows[0].starting_cash)).toBe(1000);

    // Verification is clean on the migrated schema + data.
    const { problems } = await verifyGameSchema({ log: () => {} });
    expect(problems).toEqual([]);
  });

  test('is idempotent: re-running leaves schema and data untouched', async () => {
    await runMigrations({ log: () => {} });
    await runMigrations({ log: () => {} });
    const { problems } = await verifyGameSchema({ log: () => {} });
    expect(problems).toEqual([]);
    const { rows } = await db.query(
      `SELECT is_generated, generation_expression FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'apocalypse_results' AND column_name = 'leaderboard_eligible'`
    );
    expect(rows[0].is_generated).toBe('ALWAYS');
    expect(rows[0].generation_expression).toMatch(/final_cash > starting_cash/);
  });

  test('an incompatible pre-existing leaderboard_eligible column fails loudly', async () => {
    await drop015();
    await db.query(`ALTER TABLE apocalypse_results ADD COLUMN leaderboard_eligible TEXT`);
    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/INCOMPATIBLE/);
  });

  test('the column cannot be written directly and immutability triggers still rule the table', async () => {
    await expect(
      db.query(`INSERT INTO apocalypse_results (leaderboard_eligible) VALUES (true)`)
    ).rejects.toThrow();
    // PostgreSQL itself refuses writes to a generated column.
    await expect(
      db.query(`UPDATE apocalypse_results SET leaderboard_eligible = false`)
    ).rejects.toThrow(/can only be updated to DEFAULT/);
    // (Ordinary-column immutability — UPDATE/DELETE/TRUNCATE raising — is
    // covered end-to-end in game-settlement.test.js on populated tables.)
  });
});
