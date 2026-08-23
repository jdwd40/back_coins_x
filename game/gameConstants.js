// Crypto Chaos game-design constants.
//
// GAME_STARTING_CASH is the single authoritative starting cash for every
// participant of every apocalypse cycle. Every registered human and every
// configured bot is initialized with exactly this amount at each cycle
// start (issue #17: continuous automatic participation); it is never copied
// from users.funds and never adjusted for late entry. This is the ONLY place
// the value is defined — do not scatter literals.

const GAME_STARTING_CASH = 10000;

// Round-trade quantity precision (migration 012): apocalypse_holdings and
// apocalypse_transactions store quantity as DECIMAL(18,8) — crypto-style
// fractional coins, so trades like 0.004 JDC are exact. MONEY stays at the
// application's 2-decimal precision (DECIMAL(18,2)); only the COIN amount
// carries up to 8 decimal places. Trade validation must REJECT quantities
// with more than this many significant fractional digits — never silently
// round them into a materially different quantity.
const GAME_QUANTITY_DECIMALS = 8;
// DECIMAL(18,8) leaves 10 integer digits, so the largest storable quantity
// is 9,999,999,999.99999999. This exclusive upper bound keeps a too-large
// request a clean 400 instead of a PostgreSQL numeric-overflow 500.
const GAME_QUANTITY_MAX = 10000000000;

// Minimum notional (fcoins_y #6 follow-up): money is DECIMAL(18,2), so a
// positive fractional quantity can have an authoritative 2-decimal
// consideration of £0.00 (e.g. 0.004 of a £1 coin). Such a BUY would mint
// holdings for zero round cash and such a SELL would destroy holdings for
// zero proceeds — both repeatable. Every live-priced trade must therefore
// settle for at least one penny AFTER the authoritative round2 money
// rounding. Quantity precision is unaffected: 0.004 JDC at £2.50+ is a
// perfectly valid £0.01+ trade.
const GAME_MIN_TRADE_VALUE = 0.01;

// ---------------------------------------------------------------------------
// Issue #18: passive economic pressure (fees / taxes / Apocalypse events).
// These are the single authoritative game-design values for the economy
// engine — do not scatter literals. Validated env overrides are resolved in
// game/economyConfig.js (resolveEconomyConfig), which is the only reader.
//
// Defaults are tuned for the default 30-minute cycle so a zero-trade
// participant finishes around £9,680 — inside the issue's £9,500–£9,800
// target band:
//   FEE:   £5.00 every 2 minutes   -> 14 ticks per 30-min cycle  = £70
//   TAX:   £10.00 every 5 minutes  -> 5 ticks per 30-min cycle   = £50
//   EVENT: 2 deterministic events  -> £50–£150 each (seeded)     = ~£200
// ---------------------------------------------------------------------------

// Recurring fee: a fixed charge every GAME_FEE_TICK_INTERVAL_MS of ACTIVE
// cycle time. Tick 1 lands at cycle start + one interval; a tick exactly at
// cycle end never fires (the cycle is no longer ACTIVE).
const GAME_FEE_TICK_INTERVAL_MS = 2 * 60 * 1000;
const GAME_FEE_AMOUNT = 5.0;

// Recurring tax: an independent fixed deduction on its own cadence, so fee
// and tax pressure can be tuned independently.
const GAME_TAX_TICK_INTERVAL_MS = 5 * 60 * 1000;
const GAME_TAX_AMOUNT = 10.0;

// Apocalypse events: a fixed number per cycle, scheduled deterministically
// from the cycle's persisted seed inside this fraction window of the cycle
// (deliberately before the 70% collapse window opens), each debiting a
// seeded amount in [GAME_EVENT_MIN_AMOUNT, GAME_EVENT_MAX_AMOUNT].
const GAME_EVENT_COUNT = 2;
const GAME_EVENT_MIN_FRACTION = 0.1;
const GAME_EVENT_MAX_FRACTION = 0.6;
const GAME_EVENT_MIN_AMOUNT = 50.0;
const GAME_EVENT_MAX_AMOUNT = 150.0;

// Economy worker wakeup cadence. Wakeups only claim/apply due persisted
// ticks and events, so the wakeup frequency never changes amounts — it only
// bounds how late a due debit lands.
const GAME_ECONOMY_WORKER_INTERVAL_MS = 30 * 1000;

// Validate a monetary game constant: it must be a positive, finite number
// representable exactly at the application's 2-decimal money precision (the
// same precision PostgreSQL DECIMAL(18,2) stores). Values with more than two
// decimal places (e.g. 1000.001) are configuration errors and are REJECTED,
// never silently rounded — so a stored participant row can only ever differ
// from the configured value by being exactly equal to it. Anything else
// throws immediately, before any participant row can be created from a bad
// value.
function validateGameStartingCash(raw) {
  const value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof value !== 'number' || Number.isNaN(value)) {
    throw new Error(`GAME_STARTING_CASH must be a number; received ${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)}`);
  }
  if (!Number.isFinite(value)) {
    throw new Error(`GAME_STARTING_CASH must be finite; received ${String(raw)}`);
  }
  if (value <= 0) {
    throw new Error(`GAME_STARTING_CASH must be positive; received ${value}`);
  }
  // Exact 2-decimal money precision: value * 100 must be (within floating-
  // point representation error of) an integer. A fractional penny such as
  // 1000.001 fails this; every legitimate 2dp amount (e.g. 999.99) passes
  // because the residual is only binary-representation noise, far below the
  // scaled epsilon.
  const scaled = value * 100;
  const tolerance = Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4;
  if (Math.abs(scaled - Math.round(scaled)) > tolerance) {
    throw new Error(`GAME_STARTING_CASH must have at most two decimal places (exact 2-decimal money precision); received ${value}`);
  }
  return value;
}

// An explicit override ( GAME_STARTING_CASH env var ) is honoured only when
// it validates; absent/empty means the game-design default.
function resolveGameStartingCash(raw = process.env.GAME_STARTING_CASH) {
  if (raw === undefined || raw === null) return GAME_STARTING_CASH;
  if (typeof raw === 'string' && raw.trim() === '') return GAME_STARTING_CASH;
  return validateGameStartingCash(raw);
}

module.exports = {
  GAME_STARTING_CASH,
  GAME_QUANTITY_DECIMALS,
  GAME_QUANTITY_MAX,
  GAME_MIN_TRADE_VALUE,
  GAME_FEE_TICK_INTERVAL_MS,
  GAME_FEE_AMOUNT,
  GAME_TAX_TICK_INTERVAL_MS,
  GAME_TAX_AMOUNT,
  GAME_EVENT_COUNT,
  GAME_EVENT_MIN_FRACTION,
  GAME_EVENT_MAX_FRACTION,
  GAME_EVENT_MIN_AMOUNT,
  GAME_EVENT_MAX_AMOUNT,
  GAME_ECONOMY_WORKER_INTERVAL_MS,
  validateGameStartingCash,
  resolveGameStartingCash
};
