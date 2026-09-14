// Verifier: the persistent market is the SECOND legitimate death authority
// alongside Apocalypse-cycle collapse rows. A zero live price is valid when
// explained by EITHER authority; a persistent-world DEAD coin must be
// soft-retired and priced at exactly £0; the Stage 9 replacement lifecycle
// (retired canonical dead coin + active non-canonical ALIVE replacement) is
// a valid catalogue state. Unexplained zero prices, unexplained retirements
// and unexplained active extras must still fail, and only the ACTIVE world
// counts — inactive-world records can never satisfy the invariant.
//
// jest.setup.js reseeds the disposable test database before every test.

const db = require('../db/connection');
const { verifyGameSchema } = require('../db/verify-game-schema');

async function insertWorld(active) {
  const { rows } = await db.query(
    `INSERT INTO market_worlds (version, seed, epoch_started_at, active)
     VALUES (1, 'verifier-death-authority-test', now(), $1)
     RETURNING world_id`,
    [active]
  );
  return rows[0].world_id;
}

async function insertState(coinId, worldId, status) {
  const diedAt = status === 'DEAD' ? ', now()' : '';
  await db.query(
    `INSERT INTO market_coin_state
       (coin_id, world_id, archetype, condition, structural_reference, peak_reference, status${status === 'DEAD' ? ', died_at' : ''})
     VALUES ($1, $2, 'ZIP', 0, 1, 1, '${status}'${diedAt})`,
    [coinId, worldId]
  );
}

async function insertActiveCycleWithCollapse(coinId) {
  const { rows } = await db.query(
    `INSERT INTO apocalypse_cycles
       (apocalypse_id, seed, start_time, end_time, duration_ms, status)
     VALUES ('APOC-VD-1', 'verifier-death-authority-test', now() - interval '5 minutes', now() + interval '25 minutes', 1800000, 'ACTIVE')
     RETURNING cycle_id`
  );
  await db.query(
    `INSERT INTO apocalypse_coin_collapses (cycle_id, coin_id, collapse_rank, collapsed_at)
     VALUES ($1, $2, 0, now())`,
    [rows[0].cycle_id, coinId]
  );
}

async function insertExtraCoin() {
  const { rows } = await db.query(
    `INSERT INTO coins (name, symbol, current_price, market_cap, circulating_supply, founder, cycle_baseline_price)
     VALUES ('Verifier Replacement', 'VRX', 1.00, 1000, 1000, 'verifier-test', 1.00)
     RETURNING coin_id`
  );
  return rows[0].coin_id;
}

const problemsMatching = (verification, pattern) => verification.problems.filter((p) => pattern.test(p));

describe('verify-game-schema: dual death authority (Apocalypse collapse OR persistent DEAD)', () => {
  test('existing authority preserved: an Apocalypse-collapsed zero-price coin verifies clean', async () => {
    await insertActiveCycleWithCollapse(1);
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = 1');

    const verification = await verifyGameSchema();
    expect(problemsMatching(verification, /zero-priced coins/)).toEqual([]);
  });

  test('persistent authority: a DEAD coin in the active world with a £0 price verifies clean', async () => {
    const worldId = await insertWorld(true);
    await insertState(7, worldId, 'DEAD');
    await db.query('UPDATE coins SET retired = TRUE, current_price = 0 WHERE coin_id = 7');

    const verification = await verifyGameSchema();
    expect(verification.problems).toEqual([]);
  });

  test('a zero price explained by NEITHER authority still fails', async () => {
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = 1');

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(
      problemsMatching(verification, /zero-priced coins have no executed collapse row in the ACTIVE\/SETTLING cycle and no persistent-world DEAD record/)
    ).toHaveLength(1);
  });

  test('a zero price explained only by an INACTIVE world still fails', async () => {
    const inactiveWorldId = await insertWorld(false);
    await insertState(1, inactiveWorldId, 'DEAD');
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = 1');

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(problemsMatching(verification, /zero-priced coins/)).toHaveLength(1);
  });

  test('a persistently DEAD coin that is not retired fails the death-consistency invariant', async () => {
    const worldId = await insertWorld(true);
    await insertState(7, worldId, 'DEAD');
    await db.query('UPDATE coins SET current_price = 0 WHERE coin_id = 7');

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(
      problemsMatching(verification, /persistently DEAD coin\(s\) in the active world are not retired/)
    ).toHaveLength(1);
  });

  test('a persistently DEAD coin with a non-zero live price fails the death-consistency invariant', async () => {
    const worldId = await insertWorld(true);
    await insertState(7, worldId, 'DEAD');
    await db.query('UPDATE coins SET retired = TRUE WHERE coin_id = 7');

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(
      problemsMatching(verification, /persistently DEAD coin\(s\) in the active world have a non-zero live price/)
    ).toHaveLength(1);
    // The retirement itself is legitimately explained by the persisted death.
    expect(problemsMatching(verification, /canonical coin_id 7 .* is retired/)).toEqual([]);
  });
});

describe('verify-game-schema: replacement lifecycle catalogue rules', () => {
  test('a retired canonical coin that is DEAD in the active world passes the catalogue check', async () => {
    const worldId = await insertWorld(true);
    await insertState(7, worldId, 'DEAD');
    await db.query('UPDATE coins SET retired = TRUE, current_price = 0 WHERE coin_id = 7');

    const verification = await verifyGameSchema();
    expect(problemsMatching(verification, /canonical coin_id 7 .* is retired/)).toEqual([]);
  });

  test('an active non-canonical coin with an ALIVE state in the active world passes (replacement)', async () => {
    const worldId = await insertWorld(true);
    const replacementId = await insertExtraCoin();
    await insertState(replacementId, worldId, 'ALIVE');

    const verification = await verifyGameSchema();
    expect(problemsMatching(verification, /non-canonical coin row\(s\) are not retired/)).toEqual([]);
  });

  test('an active non-canonical coin with NO active-world ALIVE state still fails', async () => {
    await insertWorld(true);
    await insertExtraCoin();

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(problemsMatching(verification, /non-canonical coin row\(s\) are not retired/)).toHaveLength(1);
  });

  test('an active non-canonical coin whose ALIVE state is only in an INACTIVE world still fails', async () => {
    const inactiveWorldId = await insertWorld(false);
    const replacementId = await insertExtraCoin();
    await insertState(replacementId, inactiveWorldId, 'ALIVE');

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(problemsMatching(verification, /non-canonical coin row\(s\) are not retired/)).toHaveLength(1);
  });

  test('a canonical coin retired with NO persisted death explanation still fails', async () => {
    await insertWorld(true);
    await db.query('UPDATE coins SET retired = TRUE WHERE coin_id = 7');

    const verification = await verifyGameSchema();
    expect(verification.ok).toBe(false);
    expect(problemsMatching(verification, /canonical coin_id 7 .* is retired/)).toHaveLength(1);
  });
});
