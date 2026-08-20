// Crypto Chaos game-design constants.
//
// GAME_STARTING_CASH is the single authoritative starting cash for every
// participant of every apocalypse cycle. Joining at 1%, 50% or 95% of a
// cycle always yields exactly this amount; it is never copied from
// users.funds and never adjusted for late entry. This is the ONLY place the
// value is defined — do not scatter literals.

const GAME_STARTING_CASH = 1000;

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
  validateGameStartingCash,
  resolveGameStartingCash
};
