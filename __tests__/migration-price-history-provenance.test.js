// Migration runner + schema verification coverage for the Apocalypse Monitor
// persistence foundation (migration 019: nullable price_history.cycle_id FK to
// apocalypse_cycles, nullable price_history.source provenance tag, and the
// (cycle_id, coin_id, created_at) index).
//
// Runs the REAL migration runner (db/migrate.js) and the REAL verification
// (db/verify-game-schema.js) against the disposable test database. The guard
// refuses any non-test target. db/seed.js only provides the pre-existing
// Coins schema and data (via jest.setup.js beforeEach) that migration 019
// must preserve; it is never the production migration mechanism.

const db = require('../db/connection');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const MIGRATION_019 = '019_price_history_cycle_provenance.sql';
const INDEX_NAME = 'idx_price_history_cycle_coin_created';

async function columnOf(table, column) {
  const { rows } = await db.query(
    `SELECT data_type, is_nullable, character_maximum_length
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
    [table, column]
  );
  return rows[0] || null;
}

// Simulate the pre-019 production state: drop the provenance objects (column
// drops carry their constraints with them) and remove the tracking row.
async function revert019() {
  await db.query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
  await db.query('ALTER TABLE price_history DROP COLUMN IF EXISTS source');
  await db.query('ALTER TABLE price_history DROP COLUMN IF EXISTS cycle_id');
  await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_019]);
}

describe('Apocalypse Monitor foundation: tracked production migration 019 (price_history provenance)', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} }); // tracked, fully migrated baseline
  });

  test('the migrated schema has nullable cycle_id/source, the index, and verifies clean', async () => {
    const cycleId = await columnOf('price_history', 'cycle_id');
    expect(cycleId).not.toBeNull();
    expect(cycleId.data_type).toBe('integer');
    expect(cycleId.is_nullable).toBe('YES'); // legacy rows stay NULL forever

    const source = await columnOf('price_history', 'source');
    expect(source).not.toBeNull();
    expect(source.data_type).toBe('character varying');
    expect(source.is_nullable).toBe('YES');

    const { rows: indexes } = await db.query(
      `SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'price_history' AND indexname = $1`,
      [INDEX_NAME]
    );
    expect(indexes).toHaveLength(1);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect(verification.ok).toBe(true);
  });

  test('applies 019 to an existing database without backfilling legacy rows', async () => {
    // Legacy rows as production has them today: no cycle relation, no source.
    await db.query(
      `INSERT INTO price_history (coin_id, price, created_at)
       VALUES (1, 12.34, '2026-08-01T00:00:00.000Z'), (2, 0.10, '2026-08-02T00:00:00.000Z')`
    );
    await revert019();
    expect(await columnOf('price_history', 'cycle_id')).toBeNull();
    expect(await columnOf('price_history', 'source')).toBeNull();

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toContain(MIGRATION_019);

    // The migration is additive/data-preserving: legacy rows keep NULL
    // cycle_id/source (no timestamp- or cycle-backfill is ever attempted).
    const { rows: legacy } = await db.query(
      `SELECT cycle_id, source FROM price_history ORDER BY price_history_id`
    );
    expect(legacy).toHaveLength(2);
    for (const row of legacy) {
      expect(row.cycle_id).toBeNull();
      expect(row.source).toBeNull();
    }

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('cycle_id enforces the FK to apocalypse_cycles; NULL stays valid', async () => {
    await expect(
      db.query(`INSERT INTO price_history (coin_id, cycle_id, price, source) VALUES (1, 999999, 1.00, 'MARKET_TICK')`)
    ).rejects.toThrow(/foreign key/i);

    // A real cycle id is accepted.
    const { reconcileCycle } = require('../game/gameCycleService');
    const cycle = await reconcileCycle({ now: new Date('2026-08-25T10:07:00.000Z') });
    await db.query(
      `INSERT INTO price_history (coin_id, cycle_id, price, source) VALUES (1, $1, 1.00, 'MARKET_TICK')`,
      [cycle.cycle_id]
    );
    // Legacy shape (both NULL) remains valid.
    await db.query(`INSERT INTO price_history (coin_id, price) VALUES (1, 2.00)`);
  });

  test('source admits exactly MARKET_TICK/COLLAPSE/NULL and rejects anything else', async () => {
    await expect(
      db.query(`INSERT INTO price_history (coin_id, price, source) VALUES (1, 1.00, 'GLITCH')`)
    ).rejects.toThrow(/check/i);

    for (const source of ['MARKET_TICK', 'COLLAPSE']) {
      await db.query(`INSERT INTO price_history (coin_id, price, source) VALUES (1, 1.00, $1)`, [source]);
    }
    await db.query(`INSERT INTO price_history (coin_id, price, source) VALUES (1, 1.00, NULL)`);
  });

  test('a rerun after losing only the tracking row is a safe no-op', async () => {
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_019]);
    const rerun = await runMigrations({ log: () => {} });
    expect(rerun.applied).toContain(MIGRATION_019);

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('an incompatible pre-existing column aborts the migration and records nothing', async () => {
    await revert019();
    // A same-named column with the wrong shape must be refused, not altered.
    await db.query('ALTER TABLE price_history ADD COLUMN source INTEGER');

    await expect(runMigrations({ log: () => {} })).rejects.toThrow(/migration 019/);

    const { rows } = await db.query('SELECT migration FROM schema_migrations WHERE migration = $1', [MIGRATION_019]);
    expect(rows).toHaveLength(0);
    const source = await columnOf('price_history', 'source');
    expect(source.data_type).toBe('integer'); // untouched
  });
});
