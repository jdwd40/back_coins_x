const express = require('express');
const {
  getDiagnosticsParticipants,
  getDiagnosticsActivity,
  getDiagnosticsBots,
  getDiagnosticsMonitor
} = require('../controllers/gameDiagnostics.controller');
const { authenticateDiagnostics } = require('../middleware/diagnostics.middleware');

const gameDiagnosticsRouter = express.Router();

// Issue #21: operator/game diagnostics. Every route is GET-only, read-only
// at the database level (BEGIN READ ONLY), and gated by the dedicated
// env-configured operator token — never by the player JWT, because this
// backend has no admin role and these views expose every participant's
// activity. When GAME_DIAGNOSTICS_TOKEN is unset the router answers 404
// for all four routes (fail closed).
gameDiagnosticsRouter.use(authenticateDiagnostics);

// Authenticated diagnostics payloads are live operator views of game state:
// never cacheable. Set after authentication so the fail-closed 404/401
// shapes stay byte-identical to any other missing/unauthorized route.
gameDiagnosticsRouter.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

gameDiagnosticsRouter.get('/participants', getDiagnosticsParticipants);
gameDiagnosticsRouter.get('/activity', getDiagnosticsActivity);
gameDiagnosticsRouter.get('/bots', getDiagnosticsBots);
// Apocalypse Monitor Phase 2: per-cycle raw price series with provenance
// attribution (exact vs time-window-derived legacy rows).
gameDiagnosticsRouter.get('/monitor', getDiagnosticsMonitor);

exports.gameDiagnosticsRouter = gameDiagnosticsRouter;
