#!/usr/bin/env node
/**
 * restore-legacy-delta.mjs — replay a Supabase reverse-delta into a RESTORED
 * LEGACY STAGING database (plan §14B). Dry-run/rehearsal tooling only;
 * applying a reverse delta to production requires explicit approval after
 * reconciliation.
 *
 * The legacy target has integer user/coin IDs; the delta carries legacy IDs.
 *
 * Usage:
 *   LEGACY_TARGET_DATABASE_URL=… node restore-legacy-delta.mjs <deltadir> [--apply]
 * Default (no --apply): transaction rolls back after printing the plan.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const [deltadir] = args.filter((a) => !a.startsWith('--'));
if (!deltadir) {
  console.error('usage: restore-legacy-delta.mjs <deltadir> [--apply]');
  process.exit(2);
}

const readJsonl = (name) =>
  readFileSync(join(deltadir, `${name}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const config = process.env.LEGACY_TARGET_DATABASE_URL
  ? { connectionString: process.env.LEGACY_TARGET_DATABASE_URL }
  : { host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE,
      user: process.env.PGUSER, port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432 };

const client = new pg.Client(config);
await client.connect();

const trades = readJsonl('trades_delta');
const wallets = readJsonl('wallets_final');
const holdings = readJsonl('holdings_final');
const assets = readJsonl('assets_final');

try {
  await client.query('BEGIN');

  for (const t of trades) {
    await client.query(
      `INSERT INTO transactions
         (user_id, coin_id, type, quantity, price, total_amount, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [t.legacy_user_id, t.legacy_coin_id, t.side, t.quantity, t.unit_price,
       t.total_amount, t.executed_at],
    );
  }
  console.log(`transactions delta: ${trades.length} rows staged`);

  for (const w of wallets) {
    await client.query(
      `UPDATE users SET funds = $1, updated_at = now() WHERE user_id = $2`,
      [w.cash_balance, w.legacy_user_id],
    );
  }
  console.log(`wallets: ${wallets.length} balances staged`);

  for (const h of holdings) {
    await client.query(
      `INSERT INTO portfolios (user_id, coin_id, quantity, average_purchase_price, created_at, updated_at)
       VALUES ($1, $2, $3,
               CASE WHEN $3::numeric > 0 THEN $4::numeric / $3::numeric ELSE 0 END,
               now(), now())
       ON CONFLICT (user_id, coin_id) DO UPDATE
         SET quantity = EXCLUDED.quantity,
             average_purchase_price = EXCLUDED.average_purchase_price,
             updated_at = now()`,
      [h.legacy_user_id, h.legacy_coin_id, h.quantity, h.cost_basis],
    );
  }
  console.log(`holdings: ${holdings.length} rows staged`);

  for (const a of assets) {
    await client.query(
      `UPDATE coins SET current_price = $1, market_cap = $2 WHERE coin_id = $3`,
      [a.current_price, a.market_cap, a.legacy_coin_id],
    );
  }
  console.log(`assets: ${assets.length} prices staged`);

  if (apply) {
    await client.query('COMMIT');
    console.log('APPLIED (approved rehearsal target only)');
  } else {
    await client.query('ROLLBACK');
    console.log('dry-run: rolled back (pass --apply to commit on a rehearsal DB)');
  }
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('delta restore failed, rolled back:', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
