#!/usr/bin/env node
/**
 * export-legacy.mjs — repeatable, read-only export of the legacy Coins DB.
 *
 * - Runs inside a REPEATABLE READ READ ONLY transaction (consistent snapshot).
 * - Exports JSONL (one row per line) + manifest.json with counts, timestamp
 *   bounds and SHA-256 checksums.
 * - NEVER exports password hashes or any secret. Emails are included because
 *   identity mapping needs them; treat the output directory as sensitive,
 *   store it encrypted, and never commit it.
 *
 * Usage:
 *   COINS_SOURCE_DATABASE_URL=postgresql://… node export-legacy.mjs <outdir>
 *   PGDATABASE=coins_test node export-legacy.mjs <outdir>   (local socket)
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const outdir = process.argv[2];
if (!outdir) { console.error('usage: export-legacy.mjs <outdir>'); process.exit(2); }
mkdirSync(outdir, { recursive: true });

const config = process.env.COINS_SOURCE_DATABASE_URL
  ? { connectionString: process.env.COINS_SOURCE_DATABASE_URL }
  : { host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE,
      user: process.env.PGUSER, port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432 };
if (!config.connectionString && !config.database) {
  console.error('set COINS_SOURCE_DATABASE_URL or PGDATABASE');
  process.exit(2);
}

const client = new pg.Client(config);
await client.connect();

const manifest = {
  exported_at_utc: null,
  source_database: null,
  tables: {},
};

async function exportTable(name, query) {
  const file = join(outdir, `${name}.jsonl`);
  const hash = createHash('sha256');
  const stream = createWriteStream(file);
  let count = 0;
  const { rows } = await client.query(query);
  for (const row of rows) {
    const line = JSON.stringify(row) + '\n';
    hash.update(line);
    stream.write(line);
    count += 1;
  }
  await new Promise((resolve) => stream.end(resolve));
  manifest.tables[name] = { rows: count, file: `${name}.jsonl`, sha256: hash.digest('hex') };
  console.log(`exported ${name}: ${count} rows`);
}

try {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const { rows: [info] } = await client.query('SELECT current_database() db, now() ts');
  manifest.exported_at_utc = info.ts;
  manifest.source_database = info.db;

  // Identities: NO password_hash. bcrypt format was validated in place by the
  // inventory script; hashes are never exported.
  await exportTable('users',
    `SELECT user_id AS legacy_user_id, username, lower(trim(email)) AS email,
            funds AS cash_balance, created_at, updated_at
       FROM users ORDER BY user_id`);
  await exportTable('coins',
    `SELECT coin_id AS legacy_coin_id, name, symbol, current_price, market_cap,
            circulating_supply, price_change_24h, founder, date_added AS listed_at
       FROM coins ORDER BY coin_id`);
  await exportTable('portfolios',
    `SELECT portfolio_id AS legacy_portfolio_id, user_id AS legacy_user_id,
            coin_id AS legacy_coin_id, quantity, average_purchase_price,
            created_at, updated_at
       FROM portfolios ORDER BY portfolio_id`);
  await exportTable('transactions',
    `SELECT transaction_id AS legacy_transaction_id, user_id AS legacy_user_id,
            coin_id AS legacy_coin_id, type, quantity, price, total_amount, created_at
       FROM transactions ORDER BY transaction_id`);
  await exportTable('price_history',
    `SELECT price_history_id AS legacy_id, coin_id AS legacy_coin_id, price, created_at
       FROM price_history ORDER BY coin_id, created_at, price_history_id`);
  await exportTable('market_history',
    `SELECT id AS legacy_id, total_value, market_trend, created_at
       FROM market_history ORDER BY created_at, id`);
  await exportTable('coin_statistics',
    `SELECT coin_id AS legacy_coin_id, all_time_high AS ath_price,
            all_time_high_date AS ath_date, all_time_low AS atl_price,
            all_time_low_date AS atl_date
       FROM coin_statistics ORDER BY coin_id`);

  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await client.end();
}

writeFileSync(join(outdir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`manifest written to ${join(outdir, 'manifest.json')}`);
