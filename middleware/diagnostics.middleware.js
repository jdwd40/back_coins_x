// Issue #21: access control for the operator/game diagnostics API.
//
// This backend has no admin role: authenticateToken only establishes a
// PLAYER identity, and making per-user JWTs double as operator credentials
// would silently turn every registered user into an operator. The safest
// minimal restricted mechanism consistent with the existing architecture is
// therefore a dedicated, env-configured operator bearer token:
//
//   GAME_DIAGNOSTICS_TOKEN — a high-entropy secret set on the server
//   environment only (never in the frontend, never committed).
//
//   Authorization: Bearer <token>
//
// Fail-closed semantics:
//   * Token unset/blank on the server -> every diagnostics route answers
//     404 (the API is indistinguishable from absent; nothing leaks about
//     its existence).
//   * Missing/malformed/wrong bearer -> 401, same shape as the JWT
//     middleware.
// Comparison is timing-safe. The token is a pure read credential: the
// diagnostics routes only ever read (see gameDiagnosticsService).
//
// This module does not load dotenv; db/connection or the jest setup has
// already populated process.env by the time requests are handled. The env
// var is read per-request so tests can toggle it without module-cache
// surgery.

const crypto = require('crypto');

function configuredToken() {
  const raw = process.env.GAME_DIAGNOSTICS_TOKEN;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  return raw;
}

function safeEqual(provided, expected) {
  const providedBuf = Buffer.from(String(provided));
  const expectedBuf = Buffer.from(String(expected));
  if (providedBuf.length !== expectedBuf.length) return false;
  return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

exports.authenticateDiagnostics = (req, res, next) => {
  const token = configuredToken();
  if (!token) {
    return res.status(404).json({ message: 'Route not found' });
  }
  const authHeader = req.headers['authorization'];
  const provided = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN
  if (!provided || !safeEqual(provided, token)) {
    return res.status(401).json({ msg: 'Authentication required' });
  }
  next();
};
