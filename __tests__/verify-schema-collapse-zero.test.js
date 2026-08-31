// Milestone 1 hardening: the schema verifier must recognise EXECUTED
// zero-price collapses in the authoritative ACTIVE **or SETTLING** cycle as
// legitimate (a coin collapsed at the end of a round stays £0 through the
// whole settlement window — there is no ACTIVE cycle while a SETTLING cycle
// exists, so an ACTIVE-only rule falsely condemned every mid-settlement £0),
// while still rejecting any zero price with NO executed collapse behind it.
//
// jest.setup.js reseeds the disposable test database before every test.

const db = require('../db/connection');
const { verifyGameSchema } = require('../db/verify-game-schema');

const COIN_ID = 1;

async function insertCycle(status) {
  const settlingStamp = status === 'SETTLING' ? ', now()' : '';
  const { rows } = await db.query(
    `INSERT INTO apocalypse_cycles
       (apocalypse_id, seed, start_time, end_time, duration_ms, status${status === 'SETTLING' ? ', settlement_started_at' : ''})
     VALUES ('APOC-0001', 'verifier-test-seed', now() - interval '30 minutes', now(), 1800000, '${status}'${settlingStamp})
     RETURNING cycle_id`
  );
  return rows[0].cycle_id;
}

async function executeCollapse(cycleId, coinId) {
  await db.query(
    `INSERT INTO apocalypse_coin_collapses
       (cycle_id, coin_id, collapse_rank, collapsed_at)
     VALUES ($1, $2, 0, now())`,
    [cycleId, coinId]
  );
}

async function zeroPriceProblems({ ok, problems }) {
  return {
    ok,
    zeroProblems: problems.filter((p) => /zero-priced|non-zero live price/.test(p)),
    all: problems
  };
}

describe('verify-game-schema: executed zero-price collapses in ACTIVE or SETTLING cycles', () => {
  test('legitimate: executed collapse in the ACTIVE cycle with a £0 live price verifies clean', async () => {
    const cycleId = await insertCycle('ACTIVE');
    await executeCollapse(cycleId, COIN_ID);
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [COIN_ID]);

    const result = await zeroPriceProblems(await verifyGameSchema());
    expect(result.all).toEqual([]);
  });

  test('legitimate: executed collapse in the SETTLING cycle with a £0 live price verifies clean', async () => {
    // Mid-settlement there is no ACTIVE cycle; the collapsed coins of the
    // settling round are legitimately £0 until the successor restores the
    // baseline.
    const cycleId = await insertCycle('SETTLING');
    await executeCollapse(cycleId, COIN_ID);
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [COIN_ID]);

    const result = await zeroPriceProblems(await verifyGameSchema());
    expect(result.all).toEqual([]);
  });

  test('invalid: a zero live price with NO executed collapse is still rejected', async () => {
    await insertCycle('ACTIVE'); // authoritative cycle exists but collapsed nothing
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = $1', [COIN_ID]);

    const result = await zeroPriceProblems(await verifyGameSchema());
    expect(result.zeroProblems).toHaveLength(1);
    expect(result.zeroProblems[0]).toMatch(/zero-priced coins have no executed collapse/);
  });

  test('invalid: an executed collapse in the SETTLING cycle with a non-zero live price is rejected', async () => {
    // Death must hold through settlement: a revived price mid-settlement is
    // exactly as corrupt as one mid-round.
    const cycleId = await insertCycle('SETTLING');
    await executeCollapse(cycleId, COIN_ID);
    // coin stays at its seeded non-zero price — a "revival"

    const result = await zeroPriceProblems(await verifyGameSchema());
    expect(result.zeroProblems).toHaveLength(1);
    expect(result.zeroProblems[0]).toMatch(/non-zero live price/);
  });
});
