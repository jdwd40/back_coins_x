#!/usr/bin/env node
/**
 * import-coins.mjs — idempotent staging import of a legacy export into the
 * coins schema (plan §7.2 steps 4–6).
 *
 * Prerequisites on the target DB:
 *   1. migrations applied (coins schema exists)
 *   2. identity mapping produced (create-auth-users.mjs → identity-map.json:
 *      { "<legacy_user_id>": "<auth_uuid>", ... }) and the corresponding
 *      auth.users rows already exist (Admin API, or the local test stub).
 *
 * Legacy `timestamp without time zone` values are interpreted as UTC
 * (convention confirmed by inventory: market_history min/max match the
 * timestamptz price_history span exactly).
 *
 * Usage:
 *   COINS_STAGING_DATABASE_URL=postgresql://… \
 *     node import-coins.mjs <exportdir> <identity-map.json>
 *   PGDATABASE=coins_staging node import-coins.mjs <exportdir> <identity-map.json>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

// timestamp without time zone (1114): treat source bytes as UTC.
pg.types.setTypeParser(1114, (s) => `${s}+00`);

const [exportdir, mapFile] = process.argv.slice(2);
if (!exportdir || !mapFile) {
  console.error('usage: import-coins.mjs <exportdir> <identity-map.json>');
  process.exit(2);
}
const identityMap = JSON.parse(readFileSync(mapFile, 'utf8'));

const config = process.env.COINS_STAGING_DATABASE_URL
  ? { connectionString: process.env.COINS_STAGING_DATABASE_URL }
  : { host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE,
      user: process.env.PGUSER, port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432 };

const client = new pg.Client(config);
await client.connect();

const readJsonl = (name) =>
  readFileSync(join(exportdir, `${name}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

async function batchInsert(label, rows, buildSql, buildParams, batchSize = 500) {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    const params = [];
    const values = batch.map((row) => buildSql(row, params));
    await client.query(
      `INSERT INTO ${label} VALUES ${values.join(', ')} ON CONFLICT DO NOTHING`,
      params,
    );
    inserted += batch.length;
  }
  console.log(`${label}: processed ${inserted} rows`);
  return inserted;
}

try {
  await client.query('BEGIN');
  await client.query(`SELECT set_config('coins.allow_ledger_mutation', 'on', true)`);

  // 1. assets (explicit legacy IDs; sequence reset below)
  const coins = readJsonl('coins');
  await batchInsert(
    'coins.assets (id, legacy_coin_id, name, symbol, current_price, market_cap, circulating_supply, price_change_24h, founder, listed_at)',
    coins,
    (row, params) => {
      const b = params.length;
      params.push(row.legacy_coin_id, row.legacy_coin_id, row.name, row.symbol,
        row.current_price, row.market_cap, row.circulating_supply,
        row.price_change_24h, row.founder, row.listed_at);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`;
    },
  );
  await client.query(
    `SELECT setval(pg_get_serial_sequence('coins.assets', 'id'),
                   COALESCE((SELECT max(id) FROM coins.assets), 1))`,
  );

  // 2. profiles + wallets (exact legacy cash)
  const users = readJsonl('users');
  const missing = users.filter((u) => !identityMap[String(u.legacy_user_id)]);
  if (missing.length) {
    throw new Error(`identity map missing ${missing.length} legacy users: ` +
      missing.map((u) => u.legacy_user_id).join(','));
  }
  await batchInsert(
    'coins.profiles (id, legacy_user_id, username, legacy_email, created_at, updated_at)',
    users,
    (row, params) => {
      const b = params.length;
      params.push(identityMap[String(row.legacy_user_id)], row.legacy_user_id,
        row.username, row.email, row.created_at, row.updated_at ?? row.created_at);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    },
  );
  await batchInsert(
    'coins.wallets (user_id, cash_balance, created_at, updated_at)',
    users,
    (row, params) => {
      const b = params.length;
      params.push(identityMap[String(row.legacy_user_id)], row.cash_balance,
        row.created_at, row.updated_at ?? row.created_at);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
    },
  );

  // 3. identity map (deterministic reruns)
  await batchInsert(
    'coins.legacy_identity_map (legacy_user_id, auth_user_id, migration_batch, status)',
    users,
    (row, params) => {
      const b = params.length;
      params.push(row.legacy_user_id, identityMap[String(row.legacy_user_id)],
        process.env.MIGRATION_BATCH || 'staging', 'created');
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4})`;
    },
  );

  // 4. holdings (opening state; cost basis = qty × legacy average price)
  const portfolios = readJsonl('portfolios');
  await batchInsert(
    'coins.holdings (user_id, asset_id, quantity, cost_basis, created_at, updated_at)',
    portfolios,
    (row, params) => {
      const b = params.length;
      const qty = Number(row.quantity ?? 0);
      const costBasis = Math.round(qty * Number(row.average_purchase_price ?? 0) * 100) / 100;
      params.push(identityMap[String(row.legacy_user_id)], row.legacy_coin_id,
        qty, costBasis, row.created_at, row.updated_at ?? row.created_at);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6})`;
    },
  );

  // 5. trades (immutable legacy history)
  const transactions = readJsonl('transactions');
  await batchInsert(
    `coins.trades (legacy_transaction_id, user_id, asset_id, side, quantity,
                   unit_price, total_amount, executed_at, source)`,
    transactions,
    (row, params) => {
      const b = params.length;
      params.push(row.legacy_transaction_id, identityMap[String(row.legacy_user_id)],
        row.legacy_coin_id, String(row.type).toUpperCase(), row.quantity,
        row.price, row.total_amount, row.created_at, 'legacy_import');
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}::coins.trade_side, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9})`;
    },
  );

  // 6. price ticks — per-asset sequence from source order (deterministic)
  const priceHistory = readJsonl('price_history');
  const seqByAsset = new Map();
  await batchInsert(
    'coins.price_ticks (asset_id, price, captured_at, tick_sequence, source)',
    priceHistory,
    (row, params) => {
      const b = params.length;
      const seq = (seqByAsset.get(row.legacy_coin_id) ?? 0) + 1;
      seqByAsset.set(row.legacy_coin_id, seq);
      params.push(row.legacy_coin_id, row.price, row.created_at, seq, 'legacy_import');
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
    },
    1000,
  );

  // 7. market snapshots
  const marketHistory = readJsonl('market_history');
  let snapSeq = 0;
  await batchInsert(
    'coins.market_snapshots (tick_sequence, total_value, cycle, captured_at)',
    marketHistory,
    (row, params) => {
      const b = params.length;
      snapSeq += 1;
      params.push(snapSeq, row.total_value, 'STABLE', row.created_at);
      return `($${b + 1}, $${b + 2}, $${b + 3}::coins.market_cycle, $${b + 4})`;
    },
    1000,
  );
  await client.query(
    `UPDATE coins.market_state SET tick_sequence = GREATEST(tick_sequence, $1) WHERE id`,
    [snapSeq],
  );

  // 8. coin statistics (imported ATH/ATL)
  const stats = readJsonl('coin_statistics');
  await batchInsert(
    'coins.coin_statistics (asset_id, ath_price, ath_date, atl_price, atl_date)',
    stats,
    (row, params) => {
      const b = params.length;
      params.push(row.legacy_coin_id, row.ath_price, row.ath_date,
        row.atl_price, row.atl_date);
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
    },
  );

  // 9. simulation baselines for imported assets
  await client.query(
    `INSERT INTO coins.asset_simulation_state (asset_id, baseline_price, volatility)
     SELECT id, current_price, 0.01 FROM coins.assets
     ON CONFLICT (asset_id) DO NOTHING`,
  );

  await client.query('COMMIT');
  console.log('import committed');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('import rolled back:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
