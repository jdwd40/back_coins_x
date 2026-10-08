// Issue #56: migration 033 — persistent_bot_heartbeat. Runs the REAL
// runMigrations + verifyGameSchema against the reseeded disposable DB
// (migration-core4 pattern).

const db = require('../db/connection');
const fs = require('fs');
const path = require('path');
const { runMigrations } = require('../db/migrate');
const { verifyGameSchema } = require('../db/verify-game-schema');
const persistentWorld = require('../game/persistentWorld');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

jest.setTimeout(60000);

const MIGRATION_033 = '033_create_persistent_bot_heartbeat.sql';
const MIGRATION_SQL = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', MIGRATION_033), 'utf8');

describe('migration 033: persistent_bot_heartbeat', () => {
  beforeEach(async () => {
    assertDisposableTestDatabase();
    await runMigrations({ log: () => {} });
  });

  test('applies to an existing database as a tracked migration, verifies clean, and re-runs as a no-op', async () => {
    await db.query('DROP TABLE IF EXISTS persistent_bot_heartbeat');
    await db.query('DELETE FROM schema_migrations WHERE migration = $1', [MIGRATION_033]);
    const missing = await verifyGameSchema();
    expect(missing.problems).toContain('table public.persistent_bot_heartbeat does not exist');

    const result = await runMigrations({ log: () => {} });
    expect(result.applied).toEqual([MIGRATION_033]);
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
    expect((await db.query('SELECT count(*)::int AS n FROM persistent_bot_heartbeat')).rows[0].n).toBe(0);

    const again = await runMigrations({ log: () => {} });
    expect(again.applied).not.toContain(MIGRATION_033);
  });

  test('a correctly-shaped pre-existing table is accepted unchanged (rows preserved)', async () => {
    await persistentWorld.provisionWorld(db, { seed: 'm033', epochStartedAt: new Date('2026-09-01T00:00:00Z') });
    const world = await persistentWorld.resolveActiveWorld(db);
    await db.query(
      `INSERT INTO persistent_bot_heartbeat (world_id, last_claimed_tick_id, last_claimed_at) VALUES ($1, 5, now())`,
      [world.worldId]
    );
    await db.query(MIGRATION_SQL); // replay the DO block against the existing table
    const { rows } = await db.query('SELECT last_claimed_tick_id FROM persistent_bot_heartbeat');
    expect(rows.map((r) => Number(r.last_claimed_tick_id))).toEqual([5]);
  });

  test('an incompatible pre-existing table aborts with a clear error and is left untouched', async () => {
    await db.query('DROP TABLE persistent_bot_heartbeat');
    await db.query('CREATE TABLE persistent_bot_heartbeat (world_id INTEGER PRIMARY KEY, note TEXT)');
    await expect(db.query(MIGRATION_SQL)).rejects.toThrow(/persistent_bot_heartbeat table is INCOMPATIBLE/);
    const { rows } = await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'persistent_bot_heartbeat' ORDER BY column_name`
    );
    expect(rows.map((r) => r.column_name)).toEqual(['note', 'world_id']);
  });

  // Review R4: a same-named CHECK containing the expected vocabulary but
  // weakened with OR TRUE must be rejected by BOTH the migration and the
  // standalone verifier (it would let raw error text reach the public DTO).
  test('a same-named but weakened outcome CHECK (OR TRUE) is rejected by the migration and the verifier', async () => {
    await db.query('ALTER TABLE persistent_bot_heartbeat DROP CONSTRAINT persistent_bot_heartbeat_outcome_known');
    await db.query(
      `ALTER TABLE persistent_bot_heartbeat ADD CONSTRAINT persistent_bot_heartbeat_outcome_known
         CHECK (last_outcome IS NULL OR last_outcome IN ('SUCCESS', 'SIGNALS_FAILED', 'TIMEOUT', 'ERROR') OR TRUE)`
    );
    await expect(db.query(MIGRATION_SQL)).rejects.toThrow(
      /INCOMPATIBLE — constraint mismatch: persistent_bot_heartbeat_outcome_known does not enforce the intended expression/
    );
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toEqual([
      expect.stringMatching(/^constraint persistent_bot_heartbeat\.persistent_bot_heartbeat_outcome_known does not enforce the intended expression \(found CHECK .* OR true\)+$/)
    ]);
  });

  test('extra/NOT VALID constraints, extra columns, wrong defaults and wrong FK actions are all incompatible', async () => {
    const cases = [
      ['ALTER TABLE persistent_bot_heartbeat ADD CONSTRAINT extra_cap CHECK (consecutive_failures < 5) NOT VALID',
        /constraint mismatch: extra_cap is unexpected/, /^unexpected constraint on persistent_bot_heartbeat: extra_cap/],
      ['ALTER TABLE persistent_bot_heartbeat ADD COLUMN raw_error TEXT',
        /column mismatch: raw_error/, /^unexpected column: persistent_bot_heartbeat\.raw_error$/],
      ['ALTER TABLE persistent_bot_heartbeat ALTER COLUMN consecutive_failures SET DEFAULT 1',
        /column mismatch: consecutive_failures/, /^column persistent_bot_heartbeat\.consecutive_failures: default 1, expected 0$/],
      [`ALTER TABLE persistent_bot_heartbeat DROP CONSTRAINT persistent_bot_heartbeat_world_id_fkey;
        ALTER TABLE persistent_bot_heartbeat ADD FOREIGN KEY (world_id) REFERENCES market_worlds (world_id) ON DELETE CASCADE`,
        /foreign key world_id -> market_worlds does not enforce the intended expression/, /ON DELETE CASCADE/]
    ];
    // Each case is transaction-scoped DDL on ONE dedicated client, rolled back.
    const client = await db.getClient();
    try {
      for (const [ddl, migrationError, verifierProblem] of cases) {
        await client.query('BEGIN');
        try {
          await client.query(ddl);
          await client.query('SAVEPOINT replay');
          await expect(client.query(MIGRATION_SQL)).rejects.toThrow(migrationError);
          await client.query('ROLLBACK TO SAVEPOINT replay');
          const verification = await verifyGameSchema({ query: (...args) => client.query(...args) });
          expect(verification.problems).toEqual(expect.arrayContaining([expect.stringMatching(verifierProblem)]));
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
  });

  // Review R4b: the compatibility checks must never alter material inside
  // quoted SQL literals. Each same-named outcome CHECK below differs from
  // the canonical vocabulary ONLY inside its string literals (a schema-
  // prefix-looking, a cast-looking and a whitespace-changing variant) — a
  // text normalisation that strips "public.", "::text" or whitespace
  // globally would wrongly approve it. Each must be rejected by BOTH the
  // migration and the verifier, and the table is proven unusable for a
  // canonical outcome write (why approval would be wrong). Transaction-
  // scoped on one client, rolled back.
  test('outcome CHECKs differing only inside quoted literals (prefix/cast/whitespace) are rejected by migration and verifier', async () => {
    const variants = {
      schemaPrefixLiteral: "'public.SUCCESS', 'public.SIGNALS_FAILED', 'public.TIMEOUT', 'public.ERROR'",
      castLookingLiteral: "'SUCCESS::text', 'SIGNALS_FAILED::character varying', 'TIMEOUT::integer', 'ERROR::bigint'",
      whitespaceLiteral: "'SUCC ESS', ' SIGNALS_FAILED', 'TIMEOUT ', 'ERR\tOR'"
    };
    const client = await db.getClient();
    try {
      for (const [name, list] of Object.entries(variants)) {
        await client.query('BEGIN');
        try {
          await client.query('DELETE FROM persistent_bot_heartbeat');
          await client.query('ALTER TABLE persistent_bot_heartbeat DROP CONSTRAINT persistent_bot_heartbeat_outcome_known');
          await client.query(
            `ALTER TABLE persistent_bot_heartbeat ADD CONSTRAINT persistent_bot_heartbeat_outcome_known
               CHECK (last_outcome IS NULL OR last_outcome IN (${list}))`
          );

          await client.query('SAVEPOINT replay');
          let migrationError = null;
          try { await client.query(MIGRATION_SQL); } catch (err) { migrationError = err; }
          await client.query('ROLLBACK TO SAVEPOINT replay');
          expect({ name, migrationError: migrationError && migrationError.message }).toEqual({
            name,
            migrationError: expect.stringMatching(
              /INCOMPATIBLE — constraint mismatch: persistent_bot_heartbeat_outcome_known does not enforce the intended expression/
            )
          });

          const verification = await verifyGameSchema({ query: (...args) => client.query(...args) });
          expect({ name, ok: verification.ok, problems: verification.problems }).toEqual({
            name,
            ok: false,
            problems: [expect.stringMatching(
              /^constraint persistent_bot_heartbeat\.persistent_bot_heartbeat_outcome_known does not enforce the intended expression \(found CHECK /
            )]
          });

          // The approved-by-normalisation table cannot record a canonical outcome.
          await persistentWorld.provisionWorld(client, { seed: `m033-r4b-${name}`, epochStartedAt: new Date('2026-09-01T00:00:00Z') });
          const world = await persistentWorld.resolveActiveWorld(client);
          await client.query('SAVEPOINT canonical');
          await expect(client.query(
            "INSERT INTO persistent_bot_heartbeat (world_id, last_outcome) VALUES ($1, 'SUCCESS')", [world.worldId]
          )).rejects.toThrow(/persistent_bot_heartbeat_outcome_known/);
          await client.query('ROLLBACK TO SAVEPOINT canonical');
        } finally {
          await client.query('ROLLBACK');
        }
      }
    } finally {
      client.release();
    }
    // Rollback left the canonical schema intact.
    expect((await verifyGameSchema()).problems).toEqual([]);
  });

  // Review R4b: the canonical table accepts every canonical outcome, the
  // migration replays on it as a no-op (idempotent), and the verifier stays
  // clean — so exact comparison is not over-strict for the real object.
  test('the canonical table records every canonical outcome and the migration replay stays idempotent', async () => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      try {
        await persistentWorld.provisionWorld(client, { seed: 'm033-r4b-canonical', epochStartedAt: new Date('2026-09-01T00:00:00Z') });
        const world = await persistentWorld.resolveActiveWorld(client);
        await client.query('DELETE FROM persistent_bot_heartbeat WHERE world_id = $1', [world.worldId]);
        await client.query('INSERT INTO persistent_bot_heartbeat (world_id) VALUES ($1)', [world.worldId]);
        for (const outcome of ['SUCCESS', 'SIGNALS_FAILED', 'TIMEOUT', 'ERROR', null]) {
          await client.query('UPDATE persistent_bot_heartbeat SET last_outcome = $2 WHERE world_id = $1', [world.worldId, outcome]);
        }
        await client.query(MIGRATION_SQL);
        await client.query(MIGRATION_SQL);
        const verification = await verifyGameSchema({ query: (...args) => client.query(...args) });
        expect(verification.problems).toEqual([]);
        const { rows } = await client.query('SELECT count(*)::int AS n FROM persistent_bot_heartbeat WHERE world_id = $1', [world.worldId]);
        expect(rows[0].n).toBe(1);
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  // PK/FK are compared structurally: an FK to a same-named table in another
  // schema (whose deparse could differ only by a schema prefix) is rejected.
  test('a foreign key to a same-named market_worlds in another schema is incompatible', async () => {
    const client = await db.getClient();
    try {
      await client.query('BEGIN');
      try {
        await client.query('DELETE FROM persistent_bot_heartbeat');
        await client.query('CREATE SCHEMA m033_shadow');
        await client.query('CREATE TABLE m033_shadow.market_worlds (world_id INTEGER PRIMARY KEY)');
        await client.query('ALTER TABLE persistent_bot_heartbeat DROP CONSTRAINT persistent_bot_heartbeat_world_id_fkey');
        await client.query('ALTER TABLE persistent_bot_heartbeat ADD FOREIGN KEY (world_id) REFERENCES m033_shadow.market_worlds (world_id)');
        await client.query('SAVEPOINT replay');
        await expect(client.query(MIGRATION_SQL)).rejects.toThrow(
          /constraint mismatch: foreign key world_id -> market_worlds does not enforce the intended expression/
        );
        await client.query('ROLLBACK TO SAVEPOINT replay');
        const verification = await verifyGameSchema({ query: (...args) => client.query(...args) });
        expect(verification.problems).toEqual(expect.arrayContaining([
          expect.stringMatching(/^constraint persistent_bot_heartbeat\.persistent_bot_heartbeat_world_id_fkey does not enforce the intended expression \(found FOREIGN KEY \(world_id\) REFERENCES m033_shadow\.market_worlds\(world_id\)\)$/)
        ]));
      } finally {
        await client.query('ROLLBACK');
      }
    } finally {
      client.release();
    }
  });

  test('a missing column is reported as structured problems; the verifier never throws on the invariant query', async () => {
    await db.query('ALTER TABLE persistent_bot_heartbeat DROP COLUMN last_success_tick_id CASCADE');
    await expect(db.query(MIGRATION_SQL)).rejects.toThrow(/column mismatch: last_success_tick_id/);
    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(verification.problems).toEqual(expect.arrayContaining([
      'missing column: persistent_bot_heartbeat.last_success_tick_id',
      'missing constraint on persistent_bot_heartbeat: CHECK persistent_bot_heartbeat_success_pair'
    ]));
  });

  test('constraints: claim/success pairs, outcome vocabulary, non-negative values, and the success<=claim invariant', async () => {
    await persistentWorld.provisionWorld(db, { seed: 'm033b', epochStartedAt: new Date('2026-09-01T00:00:00Z') });
    const world = await persistentWorld.resolveActiveWorld(db);
    await expect(db.query('INSERT INTO persistent_bot_heartbeat (world_id, last_claimed_tick_id) VALUES ($1, 1)', [world.worldId]))
      .rejects.toThrow(/persistent_bot_heartbeat_claim_pair/);
    await expect(db.query('INSERT INTO persistent_bot_heartbeat (world_id, last_success_at) VALUES ($1, now())', [world.worldId]))
      .rejects.toThrow(/persistent_bot_heartbeat_success_pair/);
    await expect(db.query("INSERT INTO persistent_bot_heartbeat (world_id, last_outcome) VALUES ($1, 'OK')", [world.worldId]))
      .rejects.toThrow(/persistent_bot_heartbeat_outcome_known/);
    await expect(db.query('INSERT INTO persistent_bot_heartbeat (world_id, consecutive_failures) VALUES ($1, -1)', [world.worldId]))
      .rejects.toThrow(/persistent_bot_heartbeat_failures_nonneg/);
    await expect(db.query('INSERT INTO persistent_bot_heartbeat (world_id, last_skip_count) VALUES ($1, -1)', [world.worldId]))
      .rejects.toThrow(/persistent_bot_heartbeat_values_nonneg/);
    await expect(db.query('INSERT INTO persistent_bot_heartbeat (world_id) VALUES (999999)'))
      .rejects.toThrow(/foreign key/);

    // Live-data invariant in the verifier: a success newer than the newest claim.
    await db.query(
      `INSERT INTO persistent_bot_heartbeat (world_id, last_claimed_tick_id, last_claimed_at, last_success_tick_id, last_success_at)
       VALUES ($1, 5, now(), 6, now())`,
      [world.worldId]
    );
    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([
      'INVARIANT VIOLATION: 1 persistent bot heartbeat rows record a successful tick newer than the newest claimed tick'
    ]);
  });
});
