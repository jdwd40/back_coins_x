#!/usr/bin/env node
/**
 * export-supabase-delta.mjs — reverse-delta export for post-cutover rollback
 * (plan §14). DRY-RUN PREPARED TOOLING: exports coins-schema state changed
 * after a cutover watermark so it can be replayed into a restored legacy DB
 * (restore-legacy-delta.mjs). Never run against production without approval.
 *
 * Usage:
 *   COINS_STAGING_DATABASE_URL=… node export-supabase-delta.mjs <watermarkISO> <outdir>
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const [watermark, outdir] = process.argv.slice(2);
if (!watermark || !outdir || Number.isNaN(Date.parse(watermark))) {
  console.error('usage: export-supabase-delta.mjs <watermarkISO> <outdir>');
  process.exit(2);
}
mkdirSync(outdir, { recursive: true });

const config = process.env.COINS_STAGING_DATABASE_URL
  ? { connectionString: process.env.COINS_STAGING_DATABASE_URL }
  : { host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE,
      user: process.env.PGUSER, port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432 };

const client = new pg.Client(config);
await client.connect();

const manifest = { watermark, exported_at_utc: new Date().toISOString(), tables: {} };

async function dump(name, query, params) {
  const file = join(outdir, `${name}.jsonl`);
  const hash = createHash('sha256');
  const stream = createWriteStream(file);
  const { rows } = await client.query(query, params);
  for (const row of rows) {
    const line = JSON.stringify(row) + '\n';
    hash.update(line);
    stream.write(line);
  }
  await new Promise((r) => stream.end(r));
  manifest.tables[name] = { rows: rows.length, sha256: hash.digest('hex') };
  console.log(`${name}: ${rows.length} rows`);
}

try {
  await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await dump('trades_delta',
    `SELECT t.*, p.legacy_user_id, a.legacy_coin_id
       FROM coins.trades t
       JOIN coins.profiles p ON p.id = t.user_id
       JOIN coins.assets a ON a.id = t.asset_id
      WHERE t.executed_at > $1 AND t.source = 'supabase_rpc'
      ORDER BY t.id`, [watermark]);
  await dump('wallets_final',
    `SELECT w.cash_balance, w.version, p.legacy_user_id
       FROM coins.wallets w JOIN coins.profiles p ON p.id = w.user_id`, []);
  await dump('holdings_final',
    `SELECT h.quantity, h.cost_basis, p.legacy_user_id, a.legacy_coin_id
       FROM coins.holdings h
       JOIN coins.profiles p ON p.id = h.user_id
       JOIN coins.assets a ON a.id = h.asset_id`, []);
  await dump('assets_final',
    `SELECT legacy_coin_id, current_price, market_cap FROM coins.assets`, []);
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  throw err;
} finally {
  await client.end();
}

writeFileSync(join(outdir, 'delta-manifest.json'), JSON.stringify(manifest, null, 2));
console.log('delta manifest written');
