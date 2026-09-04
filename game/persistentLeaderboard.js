// Persistent-market Stage 10A (S10-01): read-only persistent leaderboard.
//
// Public ranking of every provisioned persistent_accounts row in THE active
// persistent world (humans AND bots). Valuation reuses the Stage 5/8 figure
// already owned by persistentEconomy.getPersistentAccountState:
//   holdingsValue = sum(round2(quantity * current_price)) for quantity > 0
//   netWorth      = round2(cash + holdingsValue - debt)
// DEAD coins carry current_price exactly £0, so their holdings contribute £0.
//
// Ranking: netWorth DESC, then account_id ASC (stable identity — the
// persistent analogue of the legacy participant_id ASC tie-break).
//
// Pure read: never provisions, never trades, never mutates balances, debt,
// holdings, prices, loans, worlds, or bot state. No world seed / Director
// internals / JWT / bot decision state is exposed.

const db = require('../db/connection');
const persistentWorld = require('./persistentWorld');

function round2(value) {
  return Math.round(value * 100) / 100;
}

class PersistentLeaderboardError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PersistentLeaderboardError';
    this.status = status;
  }
}

// Soft-resolve THE active world. The hard throw from resolveActiveWorld is
// the right contract for mutating economy paths; a public leaderboard read
// prefers an empty board when nothing is provisioned yet.
async function resolveActiveWorldOrNull(queryable) {
  try {
    return await persistentWorld.resolveActiveWorld(queryable);
  } catch (err) {
    if (err && /no active market world/.test(err.message)) {
      return null;
    }
    throw err;
  }
}

/**
 * Read-only persistent leaderboard for THE active persistent world.
 * @param {{ queryable?: object, now?: Date }} [opts]
 * @returns {Promise<{ worldId: number|null, serverTime: string, entries: object[] }>}
 */
async function getPersistentLeaderboard({ queryable = db, now = new Date() } = {}) {
  const nowDate = now instanceof Date ? now : new Date(now);
  const serverTime = nowDate.toISOString();

  const world = await resolveActiveWorldOrNull(queryable);
  if (!world) {
    return { worldId: null, serverTime, entries: [] };
  }

  // One account-level read joining identity + personality, then one holdings
  // aggregation. Holdings value is computed in JS with the same round2 as
  // persistentEconomy (pg numeric arrives as strings; SQL ROUND would also
  // differ on half-even edge cases).
  const { rows: accountRows } = await queryable.query(
    `SELECT a.account_id, a.user_id, a.cash, a.debt,
            u.username, u.is_bot,
            b.strategy AS personality
       FROM persistent_accounts a
       JOIN users u ON u.user_id = a.user_id
       LEFT JOIN apocalypse_bots b ON b.user_id = a.user_id
      WHERE a.world_id = $1
      ORDER BY a.account_id ASC`,
    [world.worldId]
  );

  const { rows: holdingRows } = await queryable.query(
    `SELECT h.account_id, h.quantity, c.current_price
       FROM persistent_holdings h
       JOIN coins c ON c.coin_id = h.coin_id
      WHERE h.world_id = $1 AND h.quantity > 0`,
    [world.worldId]
  );

  const holdingsValueByAccount = new Map();
  for (const row of holdingRows) {
    const accountId = Number(row.account_id);
    const quantity = parseFloat(row.quantity);
    const price = parseFloat(row.current_price);
    const lineValue = round2(quantity * price);
    holdingsValueByAccount.set(
      accountId,
      round2((holdingsValueByAccount.get(accountId) || 0) + lineValue)
    );
  }

  const entries = accountRows.map((row) => {
    const accountId = Number(row.account_id);
    const cash = parseFloat(row.cash);
    const debt = parseFloat(row.debt);
    const holdingsValue = holdingsValueByAccount.get(accountId) || 0;
    const netWorth = round2(cash + holdingsValue - debt);
    return {
      accountId,
      userId: Number(row.user_id),
      username: row.username,
      isBot: row.is_bot === true,
      personality: row.personality || null,
      cash,
      holdingsValue,
      debt,
      netWorth
    };
  });

  // Rank: netWorth DESC, account_id ASC (already stable when equal).
  entries.sort((a, b) => {
    if (b.netWorth !== a.netWorth) return b.netWorth - a.netWorth;
    return a.accountId - b.accountId;
  });

  return {
    worldId: world.worldId,
    serverTime,
    entries: entries.map((entry, index) => ({
      rank: index + 1,
      ...entry
    }))
  };
}

module.exports = {
  PersistentLeaderboardError,
  getPersistentLeaderboard,
  round2
};
