#!/usr/bin/env node
/**
 * game-cycle-concurrency-test.mjs — Crypto Chaos Core 1.
 * Proves concurrent invocations cannot create duplicate active apocalypse
 * rounds. Runs against the disposable DB created by run-sql-tests.sh
 * (COINS_TEST_DB env). Uses 8 parallel clients on the public read path
 * (coins.get_game_state as the authenticated browser role), which internally
 * serialises cycle creation through coins.ensure_active_cycle().
 *
 * Scenario A: no cycles exist; 8 concurrent get_game_state calls
 *   → exactly one active round; exactly one caller observes created=true.
 * Scenario B: the active round has just expired; 8 concurrent calls
 *   → exactly one new active round; the expired round is completed once.
 */
import pg from 'pg';

const DB = process.env.COINS_TEST_DB;
if (!DB) { console.error('COINS_TEST_DB not set'); process.exit(2); }

const pool = new pg.Pool({ host: '/var/run/postgresql', database: DB, max: 10 });

let failures = 0;
const ok = (msg) => console.log(`ok: ${msg}`);
const fail = (msg) => { failures++; console.error(`FAIL: ${msg}`); };

// Public path only: emulate the PostgREST browser role so the real EXECUTE
// grant chain (get_game_state → ensure_active_cycle) is exercised.
async function callGetGameState() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE authenticated');
    const { rows } = await client.query('SELECT coins.get_game_state() AS g');
    await client.query('COMMIT');
    return rows[0].g;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    return { error: e.message };
  } finally {
    client.release();
  }
}

// --- Scenario A: cold start race -------------------------------------------
await pool.query('DELETE FROM coins.game_cycles');

const coldResults = await Promise.all(Array.from({ length: 8 }, callGetGameState));
if (coldResults.some((r) => r.error)) {
  fail('cold-start errors: ' + JSON.stringify(coldResults.filter((r) => r.error)));
}

const { rows: [a] } = await pool.query(
  `SELECT count(*)::int AS active, count(DISTINCT apocalypse_id)::int AS ids
     FROM coins.game_cycles WHERE status = 'active'`);
if (a.active !== 1 || a.ids !== 1) {
  fail(`cold start produced ${a.active} active rounds / ${a.ids} ids`);
} else {
  ok('cold start race: exactly 1 active round from 8 concurrent callers');
}
const coldIds = new Set(coldResults.map((r) => r.apocalypse_id));
if (coldIds.size !== 1) fail(`callers saw ${coldIds.size} different rounds`);
else ok('all 8 concurrent callers observe the same apocalypse_id');

// --- Scenario B: expiry race -------------------------------------------------
const { rows: [beforeRaw] } = await pool.query(
  `SELECT id, cycle_number FROM coins.game_cycles WHERE status = 'active'`);
const before = { id: beforeRaw.id, cycle_number: Number(beforeRaw.cycle_number) };
await pool.query(
  `UPDATE coins.game_cycles SET ends_at = now() - interval '1 second' WHERE id = $1`,
  [before.id]);

const expiryResults = await Promise.all(Array.from({ length: 8 }, callGetGameState));
if (expiryResults.some((r) => r.error)) {
  fail('expiry-race errors: ' + JSON.stringify(expiryResults.filter((r) => r.error)));
}

const { rows: [b] } = await pool.query(
  `SELECT
     (SELECT count(*) FROM coins.game_cycles WHERE status = 'active')::int AS active,
     (SELECT count(*) FROM coins.game_cycles
       WHERE status = 'completed' AND cycle_number = $1)::int AS old_completed`,
  [before.cycle_number]);
if (b.active !== 1) fail(`expiry race produced ${b.active} active rounds`);
else ok('expiry race: exactly 1 active round after 8 concurrent callers');
if (b.old_completed !== 1) fail(`expired round completed ${b.old_completed} times`);
else ok('expired round completed exactly once (no duplicate history)');

const expiryIds = new Set(expiryResults.map((r) => r.apocalypse_id));
const { rows: [curRaw] } = await pool.query(
  `SELECT apocalypse_id, cycle_number FROM coins.game_cycles WHERE status = 'active'`);
const cur = { apocalypse_id: curRaw.apocalypse_id, cycle_number: Number(curRaw.cycle_number) };
if (expiryIds.size !== 1 || !expiryIds.has(cur.apocalypse_id)) {
  fail('callers disagree on the post-expiry round');
} else if (cur.cycle_number !== before.cycle_number + 1) {
  fail(`cycle_number jumped to ${cur.cycle_number}, expected ${before.cycle_number + 1}`);
} else {
  ok('all callers converge on the next sequential round');
}

await pool.end();
if (failures) { console.error(`${failures} game-cycle concurrency assertion(s) failed`); process.exit(1); }
console.log('game-cycle concurrency tests passed');
