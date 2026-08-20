// Tracked, non-destructive migration runner for the Coins database.
//
// Design rules:
//   * NEVER invokes db/seed.js, never drops or recreates existing tables.
//   * Applied migrations are recorded in the schema_migrations table and are
//     safely skipped on subsequent runs.
//   * Legacy migrations (numeric prefix below MANAGED_FROM, i.e. 001..006)
//     predate this runner. On an existing Coins database they are recorded as
//     a baseline WITHOUT being executed, because that schema is already
//     present and the legacy files are not guaranteed to be re-runnable.
//     Fresh databases are built by the environment setup scripts
//     (setup-dbs.js / setup-dev.js), not by this runner.
//   * Managed migrations (007+) each run inside their own transaction, so a
//     failure rolls back cleanly and is never recorded as applied.
//   * A session-level advisory lock serialises concurrent runner invocations.
//
// Usage: node db/migrate.js            (uses db/connection env configuration)

const fs = require('fs');
const path = require('path');
const db = require('./connection');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const MANAGED_FROM = 7; // migrations with numeric prefix >= 7 are executed; older ones are baselined
const MIGRATION_LOCK_KEY = 727000;

async function ensureTrackingTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration  VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

// List migration files in deterministic numeric order. Only canonical
// NNN_description.sql files (exactly three digits + underscore) are managed;
// backups, two-digit legacy files, and ad-hoc dated files are never executed
// or recorded by this runner.
function listMigrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((name) => /^\d{3}_.*\.sql$/.test(name))
    .map((name) => ({ name, num: Number(name.slice(0, 3)) }))
    .sort((a, b) => a.num - b.num || a.name.localeCompare(b.name));
}

async function appliedMigrations(client) {
  const { rows } = await client.query('SELECT migration FROM schema_migrations');
  return new Set(rows.map((r) => r.migration));
}

// Run all pending managed migrations. Returns { applied, skipped, baselined }
// arrays of migration file names. Throws (after rollback) on any failure.
async function runMigrations({ log = console.log } = {}) {
  const client = await db.getClient();
  const applied = [];
  const skipped = [];
  const baselined = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await ensureTrackingTable(client);
    const already = await appliedMigrations(client);

    for (const { name, num } of listMigrationFiles()) {
      if (already.has(name)) {
        skipped.push(name);
        continue;
      }
      if (num < MANAGED_FROM) {
        // Legacy schema predates the runner: record as baseline, do not execute.
        await client.query('INSERT INTO schema_migrations (migration) VALUES ($1)', [name]);
        baselined.push(name);
        log(`baseline (recorded, not executed): ${name}`);
        continue;
      }
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
      log(`applying ${name} ...`);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (migration) VALUES ($1)', [name]);
        await client.query('COMMIT');
        applied.push(name);
        log(`applied ${name}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} FAILED and was rolled back: ${err.message}`);
      }
    }
    return { applied, skipped, baselined };
  } finally {
    try {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    } catch (_) {
      // Ignore: the lock is released when the session ends regardless.
    }
    client.release();
  }
}

if (require.main === module) {
  runMigrations()
    .then(async ({ applied, skipped, baselined }) => {
      console.log(
        `Migrations complete: ${applied.length} applied, ${skipped.length} already applied, ${baselined.length} baselined.`
      );
      await db.end();
    })
    .catch(async (err) => {
      console.error(err.message);
      await db.end();
      process.exit(1);
    });
}

module.exports = { runMigrations, listMigrationFiles, MIGRATIONS_DIR, MANAGED_FROM };
