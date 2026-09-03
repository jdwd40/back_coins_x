// Persistent-market Stage 8: bot-only persistent debt (master plan §8).
//
// THE persistent bankruptcy/loan/repayment engine for BOTS ONLY, adapted to
// the same safety shape as game/persistentEconomy.js:
//   * exactly ONE acquired pg client owns each mutation: BEGIN, FOR UPDATE
//     reads, guarded writes, ledger-after-success, COMMIT or ROLLBACK;
//   * debt is interest-free and persisted on persistent_accounts.debt
//     (DECIMAL(18,2), CHECK >= 0); every ISSUE/REPAYMENT lands an append-only
//     persistent_loans row carrying the post-operation debt (debt_after) in
//     the same transaction;
//   * a loan is issued ONLY to a bot account (users.is_bot — humans can
//     never carry debt) and ONLY when the bankruptcy predicate holds at the
//     locked row: no usable cash (< the £0.01 minimum notional) AND no
//     meaningful sellable holdings (no LIVE coin holding whose live sale
//     value reaches the minimum notional; dead coins are unsellable £0
//     history). Multiple loans are allowed — each requires bankruptcy again.
//   * repayment is automatic and priority-ordered: cash above the
//     configurable operating reserve (default £2,000) repays outstanding
//     debt first; the guarded debit (cash >= amount) is the backstop and
//     the reserve floor is enforced by the amount computation itself.
//   * debt-adjusted wealth (the Stage 10 leaderboard figure) is
//     cash + live holdings value - outstanding debt — computed in
//     persistentEconomy.getPersistentAccountState, which owns the read.
//
// Legacy apocalypse_* / users.funds data is never read or written here.

const db = require('../db/connection');
const persistentWorld = require('./persistentWorld');
const { PERSISTENT_STARTING_CASH } = require('./persistentEconomy');
const {
  GAME_MIN_TRADE_VALUE,
  resolvePersistentBotLoanAmount,
  resolvePersistentBotOperatingReserve
} = require('./gameConstants');

class PersistentDebtError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'PersistentDebtError';
    this.status = status;
  }
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

// ---------------------------------------------------------------------------
// The bankruptcy predicate (pure — the decision contract, unit-tested
// directly): a bot is bankrupt only when it has NO usable cash (below the
// minimum tradeable notional) AND NO meaningful sellable holdings (live
// proceeds below the minimum notional). Dead holdings are £0 history and
// never count as sellable.
// ---------------------------------------------------------------------------
function isPersistentBankrupt({ cash, sellableProceeds }) {
  if (typeof cash !== 'number' || !Number.isFinite(cash) || cash < 0) {
    throw new PersistentDebtError(`bankruptcy predicate requires a finite non-negative cash; received ${cash}`, 500);
  }
  if (typeof sellableProceeds !== 'number' || !Number.isFinite(sellableProceeds) || sellableProceeds < 0) {
    throw new PersistentDebtError(`bankruptcy predicate requires a finite non-negative sellableProceeds; received ${sellableProceeds}`, 500);
  }
  return cash < GAME_MIN_TRADE_VALUE && sellableProceeds < GAME_MIN_TRADE_VALUE;
}

// ---------------------------------------------------------------------------
// Evaluate the predicate for an account row the caller has already locked
// FOR UPDATE (or a plain queryable for read-only diagnostics). Sellable
// proceeds sum LIVE coin holdings only — a coin with no persistent state row
// yet is alive by convention; a DEAD coin contributes £0.
// ---------------------------------------------------------------------------
async function evaluateBotBankruptcy({ accountId, queryable = db } = {}) {
  const { rows: accountRows } = await queryable.query(
    'SELECT cash, debt FROM persistent_accounts WHERE account_id = $1',
    [accountId]
  );
  const account = accountRows[0];
  if (!account) {
    throw new PersistentDebtError(`Persistent account ${accountId} not found.`, 404);
  }
  const { rows: holdingRows } = await queryable.query(
    `SELECT h.quantity, c.current_price, COALESCE(s.status, 'ALIVE') AS status
       FROM persistent_holdings h
       JOIN coins c ON c.coin_id = h.coin_id
       LEFT JOIN market_coin_state s
         ON s.world_id = h.world_id AND s.coin_id = h.coin_id
      WHERE h.account_id = $1 AND h.quantity > 0`,
    [accountId]
  );
  const sellableProceeds = round2(
    holdingRows
      .filter((row) => row.status !== 'DEAD')
      .reduce((sum, row) => sum + parseFloat(row.quantity) * parseFloat(row.current_price), 0)
  );
  const cash = parseFloat(account.cash);
  return {
    cash,
    debt: parseFloat(account.debt),
    sellableProceeds,
    bankrupt: isPersistentBankrupt({ cash, sellableProceeds })
  };
}

// Assert the account's owner is a roster bot — humans can never carry debt.
async function assertBotAccount(client, userIdNum) {
  const { rows } = await client.query(
    'SELECT is_bot FROM users WHERE user_id = $1',
    [userIdNum]
  );
  if (!rows[0]) {
    throw new PersistentDebtError(`User ${userIdNum} not found.`, 404);
  }
  if (rows[0].is_bot !== true) {
    throw new PersistentDebtError(
      'Persistent loans are bot-only; a human account can never carry persistent debt.',
      400
    );
  }
}

// ---------------------------------------------------------------------------
// ISSUE a loan: exactly the configured principal, only to a bankrupt bot.
// Atomic: provision-if-needed (exactly-once £10,000 by UNIQUE), lock the
// account, re-evaluate bankruptcy on the LOCKED row, guarded cash credit +
// debt increment, ledger-after-success — one client, one transaction.
// ---------------------------------------------------------------------------
async function issueBotLoan({ userId } = {}) {
  const userIdNum = Number(userId);
  if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
    throw new PersistentDebtError('Invalid user_id.', 400);
  }
  const loanAmount = resolvePersistentBotLoanAmount();

  const world = await persistentWorld.resolveActiveWorld(db);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await assertBotAccount(client, userIdNum);

    // Provision-if-needed then lock THE account (identical exactly-once
    // backstop as the trade paths).
    await client.query(
      `INSERT INTO persistent_accounts (world_id, user_id, starting_cash, cash)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (world_id, user_id) DO NOTHING`,
      [world.worldId, userIdNum, PERSISTENT_STARTING_CASH]
    );
    const { rows } = await client.query(
      `SELECT account_id, cash, debt FROM persistent_accounts
        WHERE world_id = $1 AND user_id = $2
        FOR UPDATE`,
      [world.worldId, userIdNum]
    );
    const account = rows[0];

    // Bankruptcy is re-evaluated on the locked row — a loan issued to a
    // solvent bot would be unearned money.
    const evaluation = await evaluateBotBankruptcy({ accountId: account.account_id, queryable: client });
    if (!evaluation.bankrupt) {
      throw new PersistentDebtError(
        `This bot is not bankrupt (usable cash £${evaluation.cash.toFixed(2)}, sellable holdings £${evaluation.sellableProceeds.toFixed(2)}); no loan is due.`,
        400
      );
    }

    const debtAfter = round2(parseFloat(account.debt) + loanAmount);
    // Guarded write: the CHECK debt >= 0 and cash >= 0 constraints backstop
    // the arithmetic; the row lock serialises concurrent loan attempts.
    const { rowCount } = await client.query(
      `UPDATE persistent_accounts
          SET cash = cash + $1, debt = debt + $1, updated_at = now()
        WHERE account_id = $2`,
      [loanAmount, account.account_id]
    );
    if (rowCount !== 1) {
      throw new PersistentDebtError('Loan issuance failed to update the account row.', 500);
    }

    // Ledger AFTER success, in the same transaction.
    const { rows: loanRows } = await client.query(
      `INSERT INTO persistent_loans (account_id, world_id, user_id, type, amount, debt_after)
       VALUES ($1, $2, $3, 'ISSUE', $4, $5)
       RETURNING persistent_loan_id`,
      [account.account_id, world.worldId, userIdNum, loanAmount, debtAfter]
    );

    await client.query('COMMIT');
    return {
      loanId: loanRows[0].persistent_loan_id,
      type: 'ISSUE',
      amount: loanAmount,
      cash: round2(parseFloat(account.cash) + loanAmount),
      debt: debtAfter
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// REPAY: automatic priority repayment of outstanding debt from cash above
// the operating reserve. No debt / no surplus is a clean no-op (never an
// error): the caller runs this after every bot cash inflow. Atomic: locked
// account, amount = min(cash - reserve, debt) at exact 2dp, guarded debit
// (cash >= amount is the backstop), guarded debt decrement (debt >=
// amount), ledger-after-success.
// ---------------------------------------------------------------------------
async function repayBotDebt({ userId, reserve = resolvePersistentBotOperatingReserve() } = {}) {
  const userIdNum = Number(userId);
  if (!Number.isInteger(userIdNum) || userIdNum <= 0) {
    throw new PersistentDebtError('Invalid user_id.', 400);
  }
  if (typeof reserve !== 'number' || !Number.isFinite(reserve) || reserve < 0) {
    throw new PersistentDebtError('Invalid operating reserve.', 500);
  }

  const world = await persistentWorld.resolveActiveWorld(db);

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    await assertBotAccount(client, userIdNum);

    const { rows } = await client.query(
      `SELECT account_id, cash, debt FROM persistent_accounts
        WHERE world_id = $1 AND user_id = $2
        FOR UPDATE`,
      [world.worldId, userIdNum]
    );
    const account = rows[0];
    if (!account) {
      // No account, no debt — a clean no-op.
      await client.query('COMMIT');
      return { repaid: 0, debt: 0, cash: 0, skipped: 'no-account' };
    }

    const cash = parseFloat(account.cash);
    const debt = parseFloat(account.debt);
    if (debt <= 0) {
      await client.query('COMMIT');
      return { repaid: 0, debt: 0, cash, skipped: 'no-debt' };
    }
    const surplus = round2(cash - reserve);
    if (surplus < GAME_MIN_TRADE_VALUE) {
      await client.query('COMMIT');
      return { repaid: 0, debt, cash, skipped: 'within-reserve' };
    }
    const amount = round2(Math.min(surplus, debt));

    // Guarded debit: the reserve floor is enforced by the amount computed
    // from the LOCKED row; cash >= $1 backstops any residual race.
    const { rowCount: debitCount } = await client.query(
      `UPDATE persistent_accounts
          SET cash = cash - $1, debt = debt - $1, updated_at = now()
        WHERE account_id = $2 AND cash >= $1 AND debt >= $1`,
      [amount, account.account_id]
    );
    if (debitCount !== 1) {
      throw new PersistentDebtError('Debt repayment failed its guarded account update.', 500);
    }
    const debtAfter = round2(debt - amount);

    const { rows: loanRows } = await client.query(
      `INSERT INTO persistent_loans (account_id, world_id, user_id, type, amount, debt_after)
       VALUES ($1, $2, $3, 'REPAYMENT', $4, $5)
       RETURNING persistent_loan_id`,
      [account.account_id, world.worldId, userIdNum, amount, debtAfter]
    );

    await client.query('COMMIT');
    return {
      loanId: loanRows[0].persistent_loan_id,
      type: 'REPAYMENT',
      repaid: amount,
      cash: round2(cash - amount),
      debt: debtAfter
    };
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// The bounded loan-ledger read (account-scoped, newest first) — diagnostics
// and the Stage 10+ surfaces.
async function getPersistentLoans({ accountId, limit = 50, queryable = db } = {}) {
  const accountIdNum = Number(accountId);
  if (!Number.isInteger(accountIdNum) || accountIdNum <= 0) {
    throw new PersistentDebtError('Invalid account_id.', 400);
  }
  const bounded = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 100) : 50;
  const { rows } = await queryable.query(
    `SELECT persistent_loan_id, type, amount, debt_after, created_at
       FROM persistent_loans
      WHERE account_id = $1
      ORDER BY persistent_loan_id DESC
      LIMIT $2`,
    [accountIdNum, bounded]
  );
  return rows.map((row) => ({
    persistentLoanId: Number(row.persistent_loan_id),
    type: row.type,
    amount: parseFloat(row.amount),
    debtAfter: parseFloat(row.debt_after),
    createdAt: new Date(row.created_at).toISOString()
  }));
}

module.exports = {
  PersistentDebtError,
  isPersistentBankrupt,
  evaluateBotBankruptcy,
  issueBotLoan,
  repayBotDebt,
  getPersistentLoans
};
