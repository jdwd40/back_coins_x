// Issue #21: read-only operator/game diagnostics API.
//
// Proves the acceptance surface against the disposable test database:
//   * BUY/SELL normalization from apocalypse_transactions;
//   * FEE/TAX/EVENT normalization from the #18 apocalypse_cash_events ledger;
//   * participant summary with HUMAN/BOT distinction, authoritative Cash,
//     BUY/SELL counts and passive debit count/total;
//   * bot aggregate counts from apocalypse_bot_ticks (executed BUY/SELL,
//     HOLD/skipped with reasons, rejected);
//   * clean empty results for a cycle with no participants/activity/ticks;
//   * pagination/limit/offset/order validation (400s, never coercion);
//   * access-control rejection (401 missing/wrong/player-JWT token, 404 when
//     GAME_DIAGNOSTICS_TOKEN is unset — fail closed);
//   * no hidden fields (no seed, no future schedule, no auth data, no
//     internal ledger keys);
//   * diagnostic reads cause NO writes (whole-table fingerprints are
//     byte-identical before and after every endpoint).

const request = require('supertest');
const app = require('../app');
const db = require('../db/connection');
const { reconcileCycle } = require('../game/gameCycleService');
const gameRoundService = require('../game/gameRoundService');
const { ensureBotsProvisioned } = require('../game/botService');

jest.setTimeout(45000);

const T0 = new Date('2026-02-02T00:00:00.000Z'); // aligned 30-min boundary
const MIN = 60 * 1000;
const at = (minutes) => new Date(T0.getTime() + minutes * MIN);

const DIAG_TOKEN = 'test-diagnostics-token';
const authHeader = () => ({ Authorization: `Bearer ${DIAG_TOKEN}` });

beforeEach(() => {
  process.env.GAME_DIAGNOSTICS_TOKEN = DIAG_TOKEN;
});

afterEach(() => {
  delete process.env.GAME_DIAGNOSTICS_TOKEN;
});

async function startCycle(now = T0) {
  return reconcileCycle({ now });
}

async function participantFor(cycleId, userId) {
  const { rows } = await db.query(
    'SELECT * FROM apocalypse_participants WHERE cycle_id = $1 AND user_id = $2',
    [cycleId, userId]
  );
  return rows[0];
}

// Insert one #18 ledger row directly (consistent balance chain), exactly as
// the economy engine's atomic debit path would persist it.
async function insertCashEvent({ cycleId, participant, type, amount, description, eventKey, createdAt }) {
  const before = parseFloat(participant.current_cash);
  const after = Math.round((before - amount) * 100) / 100;
  await db.query(
    `INSERT INTO apocalypse_cash_events
       (participant_id, cycle_id, user_id, type, amount, balance_before, balance_after, description, event_key, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [participant.participant_id, cycleId, participant.user_id, type, amount, before, after, description, eventKey, createdAt]
  );
  await db.query(
    'UPDATE apocalypse_participants SET current_cash = $2 WHERE participant_id = $1',
    [participant.participant_id, after]
  );
  return participantFor(cycleId, participant.user_id);
}

async function insertBotTick(cycleId, tickId, actions, executedAt) {
  await db.query(
    `INSERT INTO apocalypse_bot_ticks (cycle_id, tick_id, actions, executed_at)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [cycleId, tickId, JSON.stringify(actions), executedAt]
  );
}

// Whole-table content fingerprints: count + content hash. Any INSERT,
// UPDATE or DELETE — including a diagnostic-triggered reconcile/rollover —
// changes at least one fingerprint.
const FINGERPRINT_TABLES = [
  'apocalypse_cycles',
  'apocalypse_participants',
  'apocalypse_holdings',
  'apocalypse_transactions',
  'apocalypse_cash_events',
  'apocalypse_bot_ticks',
  'apocalypse_economy_events',
  'apocalypse_economy_ticks',
  'apocalypse_results',
  'apocalypse_bots',
  'users',
  'coins'
];

async function fingerprintDatabase() {
  const fingerprint = {};
  for (const table of FINGERPRINT_TABLES) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n,
              md5(coalesce(string_agg(j, '' ORDER BY j), '')) AS h
       FROM (SELECT row_to_json(x)::text AS j FROM ${table} x) s`
    );
    fingerprint[table] = rows[0];
  }
  return fingerprint;
}

// Builds one ACTIVE cycle with: user 1 BUY + SELL, one bot joined with a
// BUY, FEE/TAX/EVENT ledger rows for user 1, and two bot tick rows covering
// executed/skipped(hold+cooldown)/rejected actions.
async function buildScenario() {
  const cycle = await startCycle();

  // Human: user 1 buys then sells part of the position.
  await gameRoundService.buyRoundTrade({
    userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 2, now: at(1)
  });
  await gameRoundService.sellRoundTrade({
    userId: 1, apocalypseId: cycle.apocalypse_id, coinId: 1, quantity: 1, now: at(2)
  });

  // Bot: provision the Core 5 roster, join one bot, one executed buy.
  const roster = await ensureBotsProvisioned();
  const bot = roster[0];
  await gameRoundService.joinRound({ userId: bot.userId, now: at(1) });
  await gameRoundService.buyRoundTrade({
    userId: bot.userId, apocalypseId: cycle.apocalypse_id, coinId: 2, quantity: 1, now: at(3)
  });

  // #18 ledger: one FEE, one TAX, one EVENT for user 1.
  let participant = await participantFor(cycle.cycle_id, 1);
  participant = await insertCashEvent({
    cycleId: cycle.cycle_id, participant, type: 'FEE', amount: 10,
    description: 'Hourly platform fee', eventKey: 'FEE-1', createdAt: at(4)
  });
  participant = await insertCashEvent({
    cycleId: cycle.cycle_id, participant, type: 'TAX', amount: 5,
    description: 'Transaction tax', eventKey: 'TAX-1', createdAt: at(5)
  });
  participant = await insertCashEvent({
    cycleId: cycle.cycle_id, participant, type: 'EVENT', amount: 25,
    description: 'Solar flare disrupts mining rigs', eventKey: 'EV-1', createdAt: at(6)
  });

  // Bot ticks: tick 1 has an executed BUY + a HOLD skip; tick 2 has a
  // cooldown skip + a domain rejection.
  await insertBotTick(cycle.cycle_id, 1, [
    { botKey: bot.botKey, action: { type: 'BUY', coinId: 2, quantity: 1 }, result: 'executed', reason: null },
    { botKey: 'conservative', action: { type: 'HOLD' }, result: 'skipped', reason: 'hold' }
  ], at(3));
  await insertBotTick(cycle.cycle_id, 2, [
    { botKey: bot.botKey, action: null, result: 'skipped', reason: 'cooldown' },
    { botKey: 'reckless', action: { type: 'SELL', coinId: 3, quantity: 4 }, result: 'rejected', reason: 'Insufficient round holdings.' }
  ], at(7));

  return { cycle, bot };
}

describe('issue #21: operator/game diagnostics', () => {
  describe('GET /api/game/diagnostics/participants', () => {
    test('summarises humans and bots with authoritative cash and counts', async () => {
      const { cycle, bot } = await buildScenario();

      const res = await request(app)
        .get('/api/game/diagnostics/participants')
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
      const data = res.body.data;
      expect(data.cycleId).toBe(cycle.apocalypse_id);
      expect(data.status).toBe('ACTIVE');
      // 2 seeded humans + all 4 provisioned roster bots (joining/trading
      // reconciles, and #17 auto-participation then covers every registered
      // user, including the freshly provisioned bot users).
      expect(data.participantCount).toBe(6);

      const human = data.participants.find((p) => p.userId === 1);
      expect(human.kind).toBe('HUMAN');
      expect(human.personality).toBeNull();
      expect(human.username).toBe('john_doe');
      expect(human.startingCash).toBe(10000);
      expect(human.buyCount).toBe(1);
      expect(human.sellCount).toBe(1);
      expect(human.passiveDebitCount).toBe(3);
      expect(human.passiveDebitTotal).toBe(40);
      expect(human.status).toBe('ACTIVE');
      expect(human.finalCash).toBeNull();
      // Holdings summary: user 1 holds 1 of coin 1 after buy 2 / sell 1.
      expect(human.holdings).toHaveLength(1);
      expect(human.holdings[0].coinId).toBe(1);
      expect(human.holdings[0].quantity).toBe(1);
      // Cash is the authoritative participant row, not a replay: matches the DB.
      const dbParticipant = await participantFor(cycle.cycle_id, 1);
      expect(human.currentCash).toBe(parseFloat(dbParticipant.current_cash));

      const botEntry = data.participants.find((p) => p.userId === bot.userId);
      expect(botEntry.kind).toBe('BOT');
      expect(botEntry.personality).toBe(bot.strategy);
      expect(botEntry.buyCount).toBe(1);
      expect(botEntry.sellCount).toBe(0);
      expect(botEntry.passiveDebitCount).toBe(0);
      expect(botEntry.passiveDebitTotal).toBe(0);

      // User 2 (auto-joined, idle): clean zeroes.
      const idle = data.participants.find((p) => p.userId === 2);
      expect(idle.buyCount).toBe(0);
      expect(idle.sellCount).toBe(0);
      expect(idle.holdings).toEqual([]);
      expect(idle.currentCash).toBe(10000);

      // The three roster bots that never traded: auto-joined, clean zeroes.
      const idleBots = data.participants.filter((p) => p.kind === 'BOT' && p.userId !== bot.userId);
      expect(idleBots).toHaveLength(3);
      for (const idleBot of idleBots) {
        expect(idleBot.buyCount).toBe(0);
        expect(idleBot.sellCount).toBe(0);
        expect(idleBot.personality).toBeTruthy();
      }
    });

    test('accepts an explicit cycleId and rejects bad ones', async () => {
      const { cycle } = await buildScenario();

      const ok = await request(app)
        .get(`/api/game/diagnostics/participants?cycleId=${cycle.apocalypse_id}`)
        .set(authHeader());
      expect(ok.status).toBe(200);
      expect(ok.body.data.cycleId).toBe(cycle.apocalypse_id);

      const malformed = await request(app)
        .get('/api/game/diagnostics/participants?cycleId=banana')
        .set(authHeader());
      expect(malformed.status).toBe(400);

      const unknown = await request(app)
        .get('/api/game/diagnostics/participants?cycleId=APOC-9999')
        .set(authHeader());
      expect(unknown.status).toBe(404);
    });
  });

  describe('GET /api/game/diagnostics/activity', () => {
    test('normalizes BUY/SELL trades and FEE/TAX/EVENT ledger rows', async () => {
      const { cycle } = await buildScenario();

      const res = await request(app)
        .get(`/api/game/diagnostics/activity?cycleId=${cycle.apocalypse_id}&order=asc&limit=50`)
        .set(authHeader());
      expect(res.status).toBe(200);
      const data = res.body.data;
      // 2 human trades + 1 bot trade + 3 ledger rows.
      expect(data.total).toBe(6);
      expect(data.returned).toBe(6);
      expect(data.activities).toHaveLength(6);

      const buy = data.activities.find((a) => a.source === 'TRADE' && a.type === 'BUY' && a.userId === 1);
      expect(buy.coinId).toBe(1);
      expect(typeof buy.symbol).toBe('string');
      expect(buy.quantity).toBe(2);
      expect(buy.price).toBeGreaterThan(0);
      expect(buy.amount).toBeCloseTo(buy.quantity * buy.price, 2);
      expect(buy.username).toBe('john_doe');
      expect(buy.kind).toBe('HUMAN');
      expect(buy.description).toMatch(/^BUY 2 .+ @ £/);
      expect(new Date(buy.occurredAt).toISOString()).toBe(buy.occurredAt);

      const sell = data.activities.find((a) => a.source === 'TRADE' && a.type === 'SELL');
      expect(sell.description).toMatch(/^SELL 1 .+ @ £/);
      expect(sell.quantity).toBe(1);

      const botBuy = data.activities.find((a) => a.source === 'TRADE' && a.type === 'BUY' && a.kind === 'BOT');
      expect(botBuy).toBeDefined();

      for (const type of ['FEE', 'TAX', 'EVENT']) {
        const row = data.activities.find((a) => a.source === 'LEDGER' && a.type === type);
        expect(row).toBeDefined();
        expect(row.userId).toBe(1);
        expect(row.amount).toBeGreaterThan(0);
        expect(typeof row.description).toBe('string');
        expect(row.coinId).toBeUndefined(); // ledger rows carry no coin fields
      }

      // Ascending order respected.
      const times = data.activities.map((a) => new Date(a.occurredAt).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
    });

    test('defaults to reverse-chronological order', async () => {
      const { cycle } = await buildScenario();
      const res = await request(app)
        .get(`/api/game/diagnostics/activity?cycleId=${cycle.apocalypse_id}`)
        .set(authHeader());
      expect(res.status).toBe(200);
      expect(res.body.data.order).toBe('desc');
      const times = res.body.data.activities.map((a) => new Date(a.occurredAt).getTime());
      expect([...times].sort((a, b) => b - a)).toEqual(times);
    });

    test('bounds and paginates with validated limit/offset', async () => {
      const { cycle } = await buildScenario();
      const base = `/api/game/diagnostics/activity?cycleId=${cycle.apocalypse_id}&order=asc`;

      const page1 = await request(app).get(`${base}&limit=2&offset=0`).set(authHeader());
      expect(page1.status).toBe(200);
      expect(page1.body.data.returned).toBe(2);
      expect(page1.body.data.total).toBe(6);

      const page3 = await request(app).get(`${base}&limit=2&offset=4`).set(authHeader());
      expect(page3.status).toBe(200);
      expect(page3.body.data.returned).toBe(2);

      const beyond = await request(app).get(`${base}&limit=2&offset=6`).set(authHeader());
      expect(beyond.status).toBe(200);
      expect(beyond.body.data.returned).toBe(0);
      expect(beyond.body.data.activities).toEqual([]);

      // Pages are disjoint.
      const page2 = await request(app).get(`${base}&limit=2&offset=2`).set(authHeader());
      const seen = new Set();
      for (const page of [page1, page2, page3]) {
        for (const row of page.body.data.activities) {
          const key = `${row.source}:${row.type}:${row.occurredAt}:${row.participantId}:${row.amount}`;
          expect(seen.has(key)).toBe(false);
          seen.add(key);
        }
      }
    });

    test('rejects invalid limit/offset/order with 400', async () => {
      const { cycle } = await buildScenario();
      const base = `/api/game/diagnostics/activity?cycleId=${cycle.apocalypse_id}`;
      for (const query of ['limit=0', 'limit=-3', 'limit=201', 'limit=abc', 'limit=1.5',
        'offset=-1', 'offset=xyz', 'offset=1.5', 'order=sideways']) {
        const res = await request(app).get(`${base}&${query}`).set(authHeader());
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('error');
      }
      // Boundary values are valid.
      expect((await request(app).get(`${base}&limit=1`).set(authHeader())).status).toBe(200);
      expect((await request(app).get(`${base}&limit=200`).set(authHeader())).status).toBe(200);
      expect((await request(app).get(`${base}&offset=0`).set(authHeader())).status).toBe(200);
      expect((await request(app).get(`${base}&order=ASC`).set(authHeader())).status).toBe(200);
    });
  });

  describe('GET /api/game/diagnostics/bots', () => {
    test('aggregates tick, executed, hold/skipped and rejected counts', async () => {
      const { cycle, bot } = await buildScenario();

      const res = await request(app)
        .get(`/api/game/diagnostics/bots?cycleId=${cycle.apocalypse_id}`)
        .set(authHeader());
      expect(res.status).toBe(200);
      const data = res.body.data;
      expect(data.cycleId).toBe(cycle.apocalypse_id);
      expect(data.tickCount).toBe(2);
      expect(data.actionsRecorded).toBe(4);
      expect(data.executed).toEqual({ total: 1, buy: 1, sell: 0 });
      expect(data.skipped.total).toBe(2);
      expect(data.skipped.hold).toBe(1);
      expect(data.skipped.byReason).toEqual({ hold: 1, cooldown: 1 });
      expect(data.rejected.total).toBe(1);
      expect(data.rejected.byReason).toEqual({ 'Insufficient round holdings.': 1 });

      const perBot = data.perBot.find((b) => b.botKey === bot.botKey);
      expect(perBot.actions).toBe(2);
      expect(perBot.executedBuys).toBe(1);
      expect(perBot.executedSells).toBe(0);
      expect(perBot.skipped).toBe(1);
      expect(perBot.personality).toBe(bot.strategy);

      const reckless = data.perBot.find((b) => b.botKey === 'reckless');
      expect(reckless.rejected).toBe(1);
      const conservative = data.perBot.find((b) => b.botKey === 'conservative');
      expect(conservative.holds).toBe(1);
    });
  });

  describe('empty cycle', () => {
    test('returns clean empty results for a cycle with nothing in it', async () => {
      // A manually inserted COMPLETED cycle: no participants, trades,
      // ledger rows or bot ticks (bypasses #17 auto-participation).
      await db.query(
        `INSERT INTO apocalypse_cycles (apocalypse_id, seed, start_time, end_time, duration_ms, status, settled_at)
         VALUES ('APOC-9001', 'test-seed', $1, $2, 1800000, 'COMPLETED', $2)`,
        [at(-60), at(-30)]
      );

      for (const route of ['participants', 'activity', 'bots']) {
        const res = await request(app)
          .get(`/api/game/diagnostics/${route}?cycleId=APOC-9001`)
          .set(authHeader());
        expect(res.status).toBe(200);
        expect(res.body.data.cycleId).toBe('APOC-9001');
        expect(res.body.data.status).toBe('COMPLETED');
      }

      const participants = await request(app)
        .get('/api/game/diagnostics/participants?cycleId=APOC-9001').set(authHeader());
      expect(participants.body.data.participantCount).toBe(0);
      expect(participants.body.data.participants).toEqual([]);

      const activity = await request(app)
        .get('/api/game/diagnostics/activity?cycleId=APOC-9001').set(authHeader());
      expect(activity.body.data.total).toBe(0);
      expect(activity.body.data.returned).toBe(0);
      expect(activity.body.data.activities).toEqual([]);

      const bots = await request(app)
        .get('/api/game/diagnostics/bots?cycleId=APOC-9001').set(authHeader());
      expect(bots.body.data.tickCount).toBe(0);
      expect(bots.body.data.actionsRecorded).toBe(0);
      expect(bots.body.data.executed).toEqual({ total: 0, buy: 0, sell: 0 });
      expect(bots.body.data.rejected).toEqual({ total: 0, byReason: {} });
      expect(bots.body.data.perBot).toEqual([]);

      // With no cycles at all, the default (omitted cycleId) is a clean 404.
      await db.query(`DELETE FROM apocalypse_cycles WHERE apocalypse_id = 'APOC-9001'`);
      const none = await request(app)
        .get('/api/game/diagnostics/participants').set(authHeader());
      expect(none.status).toBe(404);
    });
  });

  describe('access control', () => {
    test('rejects missing, wrong and player-JWT tokens with 401', async () => {
      await startCycle();
      const url = '/api/game/diagnostics/participants';

      expect((await request(app).get(url)).status).toBe(401);
      expect((await request(app).get(url)
        .set('Authorization', 'Bearer wrong-token')).status).toBe(401);
      expect((await request(app).get(url)
        .set('Authorization', 'Bearer')).status).toBe(401);
      // A player JWT is NOT an operator credential.
      const jwt = require('jsonwebtoken');
      const playerToken = jwt.sign({ user_id: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
      expect((await request(app).get(url)
        .set('Authorization', `Bearer ${playerToken}`)).status).toBe(401);

      for (const route of ['activity', 'bots']) {
        expect((await request(app).get(`/api/game/diagnostics/${route}`)).status).toBe(401);
      }
    });

    test('fails closed with 404 when GAME_DIAGNOSTICS_TOKEN is unset', async () => {
      delete process.env.GAME_DIAGNOSTICS_TOKEN;
      for (const route of ['participants', 'activity', 'bots']) {
        const res = await request(app).get(`/api/game/diagnostics/${route}`);
        expect(res.status).toBe(404);
      }
    });
  });

  describe('information hiding', () => {
    test('responses contain no seed, schedule, auth or internal ledger fields', async () => {
      const { cycle } = await buildScenario();

      const expectedParticipantKeys = [
        'participantId', 'userId', 'username', 'kind', 'personality', 'joinedAt',
        'startingCash', 'currentCash', 'finalCash', 'status', 'holdings',
        'buyCount', 'sellCount', 'passiveDebitCount', 'passiveDebitTotal'
      ].sort();
      const expectedTradeKeys = [
        'cycleId', 'source', 'type', 'participantId', 'userId', 'username', 'kind',
        'amount', 'occurredAt', 'coinId', 'symbol', 'quantity', 'price', 'description'
      ].sort();
      const expectedLedgerKeys = [
        'cycleId', 'source', 'type', 'participantId', 'userId', 'username', 'kind',
        'amount', 'occurredAt', 'description'
      ].sort();

      const participants = await request(app)
        .get(`/api/game/diagnostics/participants?cycleId=${cycle.apocalypse_id}`).set(authHeader());
      for (const p of participants.body.data.participants) {
        expect(Object.keys(p).sort()).toEqual(expectedParticipantKeys);
        for (const h of p.holdings) {
          expect(Object.keys(h).sort()).toEqual(['coinId', 'quantity', 'symbol'].sort());
        }
      }

      const activity = await request(app)
        .get(`/api/game/diagnostics/activity?cycleId=${cycle.apocalypse_id}&order=asc`).set(authHeader());
      for (const row of activity.body.data.activities) {
        expect(Object.keys(row).sort()).toEqual(
          row.source === 'TRADE' ? expectedTradeKeys : expectedLedgerKeys
        );
      }

      const bots = await request(app)
        .get(`/api/game/diagnostics/bots?cycleId=${cycle.apocalypse_id}`).set(authHeader());

      // No seed, no future collapse/event schedule, no auth material, no
      // internal ledger keys anywhere in any payload.
      for (const body of [participants.body, activity.body, bots.body]) {
        const raw = JSON.stringify(body);
        expect(raw).not.toMatch(/seed/i);
        expect(raw).not.toMatch(/password/i);
        expect(raw).not.toMatch(/email/i);
        expect(raw).not.toContain('eventKey');
        expect(raw).not.toContain('event_key');
        expect(raw).not.toContain('balance_before');
        expect(raw).not.toContain('balanceBefore');
        expect(raw).not.toContain('balance_after');
        expect(raw).not.toContain('balanceAfter');
        expect(raw).not.toContain('scheduled_at');
      }
    });
  });

  describe('read-only guarantee', () => {
    test('diagnostic reads perform zero writes (fingerprints unchanged)', async () => {
      const { cycle } = await buildScenario();

      // Make the persisted cycle observably EXPIRED: if diagnostics
      // reconciled (like the public game reads do), this would roll over
      // into SETTLING/COMPLETED and create a successor — a write. Pure
      // reads must leave every table byte-identical.
      await db.query(
        'UPDATE apocalypse_cycles SET start_time = $1, end_time = $2 WHERE cycle_id = $3',
        [at(-120), at(-90), cycle.cycle_id]
      );

      const before = await fingerprintDatabase();

      for (const route of ['participants', 'activity', 'bots']) {
        const res = await request(app)
          .get(`/api/game/diagnostics/${route}?cycleId=${cycle.apocalypse_id}`)
          .set(authHeader());
        expect(res.status).toBe(200);
      }
      // Also the default-cycle variants (omitted cycleId).
      for (const route of ['participants', 'activity', 'bots']) {
        const res = await request(app)
          .get(`/api/game/diagnostics/${route}`)
          .set(authHeader());
        expect(res.status).toBe(200);
        expect(res.body.data.status).toBe('ACTIVE'); // still as persisted; no rollover
      }

      const after = await fingerprintDatabase();
      expect(after).toEqual(before);
    });
  });
});
