#!/usr/bin/env node
/**
 * verify-migration.mjs — reconciliation gates (plan §7.4).
 * Compares a legacy export directory against the imported staging schema.
 * Exit 0 only when every gate passes. No PII in output (legacy IDs only).
 *
 * Usage:
 *   PGDATABASE=coins_staging node verify-migration.mjs <exportdir>
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import pg from 'pg';

pg.types.setTypeParser(1114, (s) => `${s}+00`);

const exportdir = process.argv[2];
if (!exportdir) { console.error('usage: verify-migration.mjs <exportdir>'); process.exit(2); }

const readJsonl = (name) =>
  readFileSync(join(exportdir, `${name}.jsonl`), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

const config = process.env.COINS_STAGING_DATABASE_URL
  ? { connectionString: process.env.COINS_STAGING_DATABASE_URL }
  : { host: process.env.PGHOST || '/var/run/postgresql', database: process.env.PGDATABASE,
      user: process.env.PGUSER, port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432 };

const client = new pg.Client(config);
await client.connect();

let failures = 0;
const gate = (ok, label, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const users = readJsonl('users');
const coins = readJsonl('coins');
const portfolios = readJsonl('portfolios');
const transactions = readJsonl('transactions');
const priceHistory = readJsonl('price_history');
const marketHistory = readJsonl('market_history');

const q = async (sql, params = []) => (await client.query(sql, params)).rows;

// 1. Row counts
const counts = await q(`SELECT
  (SELECT count(*) FROM coins.profiles) AS profiles,
  (SELECT count(*) FROM coins.wallets) AS wallets,
  (SELECT count(*) FROM coins.assets) AS assets,
  (SELECT count(*) FROM coins.holdings) AS holdings,
  (SELECT count(*) FROM coins.trades) AS trades,
  (SELECT count(*) FROM coins.price_ticks) AS ticks,
  (SELECT count(*) FROM coins.market_snapshots) AS snapshots,
  (SELECT count(*) FROM coins.legacy_identity_map) AS map`);
const c = counts[0];
const exceptionsEarly = await q(
  `SELECT legacy_id FROM coins.migration_exceptions WHERE legacy_table = 'transactions'`)
  .catch(() => []);
const exSet = new Set(exceptionsEarly.map((e) => Number(e.legacy_id)));
gate(Number(c.profiles) === users.length, 'profiles count', `${c.profiles}/${users.length}`);
gate(Number(c.wallets) === users.length, 'wallets count', `${c.wallets}/${users.length}`);
gate(Number(c.assets) === coins.length, 'assets count', `${c.assets}/${coins.length}`);
gate(Number(c.holdings) === portfolios.length, 'holdings count', `${c.holdings}/${portfolios.length}`);
gate(Number(c.trades) + exSet.size === transactions.length, 'trades count (+quarantine)',
  `${c.trades}+${exSet.size}/${transactions.length}`);
gate(Number(c.ticks) === priceHistory.length, 'price_ticks count', `${c.ticks}/${priceHistory.length}`);
gate(Number(c.snapshots) === marketHistory.length, 'market_snapshots count', `${c.snapshots}/${marketHistory.length}`);
gate(Number(c.map) === users.length, 'identity map count', `${c.map}/${users.length}`);

// 2. Exact per-user cash equality
const wallets = await q(
  `SELECT p.legacy_user_id, w.cash_balance FROM coins.wallets w
   JOIN coins.profiles p ON p.id = w.user_id`);
const cashByLegacy = new Map(wallets.map((w) => [Number(w.legacy_user_id), Number(w.cash_balance)]));
const cashMismatch = users.filter(
  (u) => cashByLegacy.get(u.legacy_user_id) !== Number(u.cash_balance));
gate(cashMismatch.length === 0, 'exact per-user cash equality',
  cashMismatch.length ? `legacy ids: ${cashMismatch.map((u) => u.legacy_user_id)}` : '');

// 3. Exact per-user/per-asset quantity equality
const holdings = await q(
  `SELECT p.legacy_user_id, h.asset_id, h.quantity FROM coins.holdings h
   JOIN coins.profiles p ON p.id = h.user_id`);
const qtyKey = (u, a) => `${u}:${a}`;
const qtyMap = new Map(holdings.map((h) => [qtyKey(h.legacy_user_id, h.asset_id), Number(h.quantity)]));
const qtyMismatch = portfolios.filter(
  (p) => qtyMap.get(qtyKey(p.legacy_user_id, p.legacy_coin_id)) !== Number(p.quantity));
gate(qtyMismatch.length === 0, 'exact per-user/per-asset quantities',
  qtyMismatch.length ? `${qtyMismatch.length} mismatches` : '');

// 4. Legacy transaction ID coverage + totals (quarantined rows count as
//    covered — they are preserved in migration_exceptions)
const tradeIds = await q(
  `SELECT legacy_transaction_id FROM coins.trades WHERE legacy_transaction_id IS NOT NULL`);
const idSet = new Set(tradeIds.map((t) => Number(t.legacy_transaction_id)));
const missingTx = transactions.filter((t) => !idSet.has(t.legacy_transaction_id) && !exSet.has(t.legacy_transaction_id));
gate(missingTx.length === 0, 'legacy transaction ID coverage',
  missingTx.length ? `missing: ${missingTx.map((t) => t.legacy_transaction_id)}` :
    (exSet.size ? `${exSet.size} quarantined in migration_exceptions` : ''));
if (exSet.size) {
  console.log(`NOTE: ${exSet.size} legacy transactions quarantined (require adjudication before prod cutover)`);
}

// 5. Asset metadata / current price equality
const assets = await q(`SELECT legacy_coin_id, current_price, symbol FROM coins.assets`);
const priceByLegacy = new Map(assets.map((a) => [Number(a.legacy_coin_id), a]));
const priceMismatch = coins.filter(
  (coin) => Number(priceByLegacy.get(coin.legacy_coin_id)?.current_price) !== Number(coin.current_price));
gate(priceMismatch.length === 0, 'asset current-price equality',
  priceMismatch.length ? `legacy ids: ${priceMismatch.map((x) => x.legacy_coin_id)}` : '');

// 6. History bounds (UTC) and per-asset counts
const bounds = await q(
  `SELECT min(captured_at) mn, max(captured_at) mx FROM coins.price_ticks`);
if (priceHistory.length) {
  const ts = (s) => {
    const str = String(s);
    return new Date(str.endsWith('Z') || /[+-][0-9][0-9](:?[0-9][0-9])?$/.test(str)
      ? str : `${str.replace(' ', 'T')}Z`).getTime();
  };
  let srcMn = Infinity; let srcMx = -Infinity;
  for (const p of priceHistory) {
    const v = ts(p.created_at);
    if (v < srcMn) srcMn = v;
    if (v > srcMx) srcMx = v;
  }
  gate(new Date(bounds[0].mn).getTime() === srcMn, 'price history min timestamp');
  gate(new Date(bounds[0].mx).getTime() === srcMx, 'price history max timestamp');
}
const perAsset = await q(
  `SELECT a.legacy_coin_id, count(*)::int n FROM coins.price_ticks t
   JOIN coins.assets a ON a.id = t.asset_id GROUP BY 1`);
const countByLegacy = new Map(perAsset.map((r) => [Number(r.legacy_coin_id), r.n]));
const srcCounts = new Map();
for (const p of priceHistory) srcCounts.set(p.legacy_coin_id, (srcCounts.get(p.legacy_coin_id) ?? 0) + 1);
const countMismatch = [...srcCounts.entries()].filter(([id, n]) => countByLegacy.get(id) !== n);
gate(countMismatch.length === 0, 'per-asset tick counts');

// 7. Integrity invariants
const inv = await q(`SELECT
  (SELECT count(*) FROM coins.wallets WHERE cash_balance < 0) AS neg_cash,
  (SELECT count(*) FROM coins.holdings WHERE quantity < 0) AS neg_qty,
  (SELECT count(*) FROM coins.holdings h LEFT JOIN coins.profiles p ON p.id = h.user_id WHERE p.id IS NULL) AS orphan_holdings,
  (SELECT count(*) FROM coins.trades t LEFT JOIN coins.profiles p ON p.id = t.user_id WHERE p.id IS NULL) AS orphan_trades,
  (SELECT count(*) FROM (SELECT lower(username) u FROM coins.profiles GROUP BY 1 HAVING count(*) > 1) d) AS dup_usernames`);
gate(Number(inv[0].neg_cash) === 0, 'no negative cash');
gate(Number(inv[0].neg_qty) === 0, 'no negative holdings');
gate(Number(inv[0].orphan_holdings) === 0, 'no orphan holdings');
gate(Number(inv[0].orphan_trades) === 0, 'no orphan trades');
gate(Number(inv[0].dup_usernames) === 0, 'no duplicate usernames');

// 8. Sequence above imported max
const seq = await q(`SELECT last_value FROM pg_sequences
  WHERE schemaname = 'coins' AND sequencename = 'assets_id_seq'`);
const maxAsset = Math.max(...coins.map((x) => x.legacy_coin_id));
gate(Number(seq[0].last_value) >= maxAsset, 'assets sequence above imported max',
  `${seq[0].last_value} >= ${maxAsset}`);

await client.end();
console.log(failures ? `\n${failures} gate(s) FAILED` : '\nall verification gates passed');
process.exit(failures ? 1 : 0);
