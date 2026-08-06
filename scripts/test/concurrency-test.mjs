#!/usr/bin/env node
/**
 * concurrency-test.mjs — proves concurrent trades cannot overspend or
 * oversell (plan §15.2). Runs against the disposable DB created by
 * run-sql-tests.sh (COINS_TEST_DB env). Uses 8 parallel clients.
 *
 * Scenario A: 8 concurrent buys of £250 each against a £1,000 wallet
 *   → at most 4 may succeed; cash never goes negative; trades count matches.
 * Scenario B: after buying 10 units, 8 concurrent sells of 2 units
 *   → at most 5 succeed; holdings never go negative.
 */
import pg from 'pg';

const DB = process.env.COINS_TEST_DB;
if (!DB) { console.error('COINS_TEST_DB not set'); process.exit(2); }

// Connects over the local unix socket as postgres (peer auth). The runner
// executes this script via `sudo -u postgres node ...` so peer auth maps
// correctly and fixture surgery is possible in the disposable DB.
const ALICE = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const pool = new pg.Pool({ host: '/var/run/postgresql', database: DB, max: 10 });

let failures = 0;
const ok = (msg) => console.log(`ok: ${msg}`);
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`); };

async function tradeAsAlice(fn, args) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Emulate the PostgREST browser role so EXECUTE grants are really exercised.
    await client.query(`SET LOCAL ROLE authenticated`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [ALICE]);
    const { rows } = await client.query(`SELECT coins.${fn}($1, $2, $3) AS r`, args);
    await client.query('COMMIT');
    return { ok: true, result: rows[0].r };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
}

const { rows: [asset] } = await pool.query(`SELECT id FROM coins.assets WHERE symbol = 'TCB'`);
const { rows: [ms] } = await pool.query(`SELECT is_running FROM coins.market_state WHERE id`);
if (!ms.is_running) await pool.query(`SELECT coins.set_market_running(true)`);

// Reset alice to a clean known state (fixture surgery on a disposable DB).
{
  const c = await pool.connect();
  try {
    await c.query(`SELECT set_config('coins.allow_ledger_mutation', 'on', false)`);
    await c.query(`DELETE FROM coins.trades WHERE user_id = $1`, [ALICE]);
    await c.query(`DELETE FROM coins.holdings WHERE user_id = $1`, [ALICE]);
    await c.query(`UPDATE coins.wallets SET cash_balance = 1000.00 WHERE user_id = $1`, [ALICE]);
  } finally {
    c.release();
  }
}

// Price moves during tick tests, so derive quantities from the live price.
const { rows: [a] } = await pool.query(`SELECT current_price FROM coins.assets WHERE id = $1`, [asset.id]);
const price = Number(a.current_price);
// Each attempted buy costs ≈60% of the £1,000 wallet → at most ONE may succeed.
const buyQty = (600 / price).toFixed(12);
const buyCost = Math.round(Number(buyQty) * price * 100) / 100;  // round(q*p, 2)

const buys = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    tradeAsAlice('buy_coin', [asset.id, buyQty, `c0000000-0000-0000-0000-00000000000${i}`]))
);
const buyOk = buys.filter((b) => b.ok);
const buyFunds = buys.filter((b) => !b.ok && b.error === 'INSUFFICIENT_FUNDS');
if (buyOk.length !== 1) fail(`expected exactly 1 successful buy, got ${buyOk.length}`);
else ok('concurrent buys: exactly 1 succeeded (no overspend)');
if (buyOk.length + buyFunds.length !== 8) fail('unexpected buy errors: ' +
  JSON.stringify(buys.filter((b) => !b.ok && b.error !== 'INSUFFICIENT_FUNDS')));
else ok('all failed buys were INSUFFICIENT_FUNDS');

const { rows: [w] } = await pool.query(`SELECT cash_balance FROM coins.wallets WHERE user_id = $1`, [ALICE]);
const expectedCash = Math.round((1000 - buyCost) * 100) / 100;
if (Number(w.cash_balance) !== expectedCash)
  fail(`cash after buys = ${w.cash_balance}, expected ${expectedCash}`);
else ok('cash exactly matches single committed buy (never negative)');

const { rows: [h] } = await pool.query(
  `SELECT quantity FROM coins.holdings WHERE user_id = $1 AND asset_id = $2`, [ALICE, asset.id]);
if (Math.abs(Number(h.quantity) - Number(buyQty)) > 1e-9)
  fail(`holding = ${h.quantity}, expected ${buyQty}`);
else ok('holding matches the one successful buy');

// Known holding for the oversell race: surgically set 100 units.
{
  const c = await pool.connect();
  try {
    await c.query(`UPDATE coins.holdings SET quantity = 100, cost_basis = 250
                    WHERE user_id = $1 AND asset_id = $2`, [ALICE, asset.id]);
  } finally { c.release(); }
}
// 8 concurrent sells of 30 units against 100 held → exactly 3 succeed.
const sells = await Promise.all(
  Array.from({ length: 8 }, (_, i) =>
    tradeAsAlice('sell_coin', [asset.id, 30, `d0000000-0000-0000-0000-00000000000${i}`]))
);
const sellOk = sells.filter((s) => s.ok);
const sellBad = sells.filter((s) => !s.ok && s.error === 'INSUFFICIENT_HOLDINGS');
if (sellOk.length !== 3) fail(`expected exactly 3 successful sells, got ${sellOk.length}`);
else ok('concurrent sells: exactly 3 succeeded (no oversell)');
if (sellOk.length + sellBad.length !== 8) fail('unexpected sell errors');
else ok('all failed sells were INSUFFICIENT_HOLDINGS');

const { rows: [h2] } = await pool.query(
  `SELECT quantity FROM coins.holdings WHERE user_id = $1 AND asset_id = $2`,
  [ALICE, asset.id]);
if (Number(h2.quantity) !== 10)
  fail(`residual qty=${h2.quantity}, expected 10`);
else ok('holdings exactly 10 after 3×30 sells (never negative)');

const { rows: [t] } = await pool.query(
  `SELECT count(*)::int n FROM coins.trades WHERE user_id = $1`, [ALICE]);
if (t.n !== 4) fail(`trade count ${t.n}, expected 4 (1 buy + 3 sells)`);
else ok('ledger has exactly one row per successful trade');

await pool.end();
if (failures) { console.error(`${failures} concurrency assertion(s) failed`); process.exit(1); }
console.log('concurrency tests passed');
