const db = require('../db/connection');
const { verifyGameSchema } = require('../db/verify-game-schema');

jest.setTimeout(30000);

async function createCycle() {
  const { rows } = await db.query(
    `INSERT INTO apocalypse_cycles
       (apocalypse_id, seed, start_time, end_time, duration_ms, status)
     VALUES ('APOC-9901', 'provenance-verifier-seed', now() - interval '1 minute', now() + interval '1 minute', 120000, 'ACTIVE')
     RETURNING cycle_id`
  );
  return rows[0].cycle_id;
}

async function insertHistory({ coinId = 1, price = 10, source = null, cycleId = null }) {
  await db.query(
    `INSERT INTO price_history (coin_id, cycle_id, price, source)
     VALUES ($1, $2, $3, $4)`,
    [coinId, cycleId, price, source]
  );
}

describe('verify-game-schema: current price_history provenance model', () => {
  test('accepts multiple persistent MARKET_TICK rows with NULL cycle_id and legacy NULL provenance', async () => {
    await insertHistory({ price: 10, source: 'MARKET_TICK' });
    await insertHistory({ price: 11, source: 'MARKET_TICK' });
    await insertHistory({ price: 12, source: null, cycleId: null });

    const result = await verifyGameSchema();
    expect(result.problems).not.toContainEqual(expect.stringContaining('source tag but NULL cycle_id'));
    expect(result.problems).toEqual([]);
  });

  test('accepts Apocalypse MARKET_TICK and COLLAPSE rows with valid cycle provenance', async () => {
    const cycleId = await createCycle();
    await insertHistory({ price: 10, source: 'MARKET_TICK', cycleId });
    await insertHistory({ price: 0, source: 'COLLAPSE', cycleId });

    const result = await verifyGameSchema();
    expect(result.problems).toEqual([]);
  });

  test('rejects COLLAPSE with NULL cycle_id when no persistent writer uses it', async () => {
    await insertHistory({ price: 0, source: 'COLLAPSE', cycleId: null });

    const result = await verifyGameSchema();
    expect(result.ok).toBe(false);
    expect(result.problems).toEqual(expect.arrayContaining([
      expect.stringContaining('COLLAPSE provenance requires a non-NULL cycle_id')
    ]));
  });

  test('the existing source CHECK constraint rejects invalid provenance values', async () => {
    await expect(insertHistory({ price: 10, source: 'NOT_A_SOURCE' }))
      .rejects.toMatchObject({ code: '23514' });
  });
});
