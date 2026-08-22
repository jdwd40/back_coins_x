// Canonical coin catalogue coverage (migration 013 / issue #13).
//
// Pins the player-facing Crypto Chaos catalogue: exactly 10 canonical coins,
// the 10 required names and symbols, JD Coin visibility, symbol uniqueness,
// fresh-seed behaviour, API exposure, and the absence of every legacy
// player-facing name/symbol. Rename-in-place safety (stable ids, preserved
// prices/history/schedules/holdings/transactions) is covered by
// migration-coin-catalogue.test.js.

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');

const CANONICAL = [
  { coin_id: 1, name: 'FutureCoin', symbol: 'FTR' },
  { coin_id: 2, name: 'NovaCash', symbol: 'NVC' },
  { coin_id: 3, name: 'Byteon', symbol: 'BYT' },
  { coin_id: 4, name: 'DigitalVault', symbol: 'DGV' },
  { coin_id: 5, name: 'Cybercore', symbol: 'CYB' },
  { coin_id: 6, name: 'BlockNation', symbol: 'BLN' },
  { coin_id: 7, name: 'StellaFortune', symbol: 'STF' },
  { coin_id: 8, name: 'JD Coin', symbol: 'JDC' },
  { coin_id: 9, name: 'MeteorCoin', symbol: 'MTC' },
  { coin_id: 10, name: 'CryptoZen', symbol: 'CZN' }
];

const LEGACY_NAMES = [
  'BitBerto', 'GedCoin', 'Mr B Block', 'BartoSatashi', 'PeteChain',
  'DeanNode', 'DeanSpark', 'SlateBit', 'JarLedger', 'WolliWarden',
  'HashAd', 'ChrisByte', 'HodlWayne'
];
const LEGACY_SYMBOLS = [
  'BTB', 'GED', 'MBB', 'BTS', 'PTC', 'DNO', 'DSP', 'SLB', 'JRL', 'WLW',
  'HAD', 'CBT', 'HDW'
];

describe('canonical coin catalogue', () => {
  test('1. exactly 10 canonical coins exist in the freshly seeded test database', async () => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM coins');
    expect(rows[0].n).toBe(10);
  });

  test('2+3. all 10 required names and symbols exist at their stable coin_ids', async () => {
    const { rows } = await db.query('SELECT coin_id, name, symbol FROM coins ORDER BY coin_id');
    expect(rows).toEqual(CANONICAL);
  });

  test('4. JD Coin exists with symbol JDC and is player-visible via the coin APIs', async () => {
    const list = await request(app).get('/api/coins').expect(200);
    const jd = list.body.coins.find((coin) => coin.symbol === 'JDC');
    expect(jd).toMatchObject({ coin_id: 8, name: 'JD Coin', symbol: 'JDC' });

    const detail = await request(app).get('/api/coins/8').expect(200);
    expect(detail.body.coin).toMatchObject({ coin_id: 8, name: 'JD Coin', symbol: 'JDC' });
  });

  test('5. symbols are unique', async () => {
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM (SELECT symbol FROM coins GROUP BY symbol HAVING count(*) > 1) d'
    );
    expect(rows[0].n).toBe(0);
  });

  test('14. the market list API exposes the new names/symbols for the whole catalogue', async () => {
    const { body } = await request(app).get('/api/coins').expect(200);
    expect(body.coins).toHaveLength(10);
    for (const expected of CANONICAL) {
      const coin = body.coins.find((c) => c.coin_id === expected.coin_id);
      expect(coin).toMatchObject({ name: expected.name, symbol: expected.symbol });
    }
  });

  test('14. the price history API joins against the renamed catalogue', async () => {
    const { body } = await request(app).get('/api/coins/8/price-history').expect(200);
    // Whatever the exact envelope, no legacy identity may appear and the
    // endpoint must serve the renamed coin.
    expect(JSON.stringify(body)).not.toMatch(/SlateBit|SLB/);
  });

  test('16. no legacy player-facing canonical names or symbols remain anywhere in the catalogue', async () => {
    const { rows } = await db.query('SELECT name, symbol FROM coins');
    for (const row of rows) {
      expect(LEGACY_NAMES).not.toContain(row.name);
      expect(LEGACY_SYMBOLS).not.toContain(row.symbol);
    }

    // And none leak through the public market list either.
    const { body } = await request(app).get('/api/coins').expect(200);
    const payload = JSON.stringify(body);
    for (const legacy of [...LEGACY_NAMES, ...LEGACY_SYMBOLS]) {
      expect(payload).not.toContain(legacy);
    }
  });
});
