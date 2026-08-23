const express = require('express');
const {
  getDiagnosticsParticipants,
  getDiagnosticsActivity,
  getDiagnosticsBots
} = require('../controllers/gameDiagnostics.controller');
const { authenticateDiagnostics } = require('../middleware/diagnostics.middleware');

const gameDiagnosticsRouter = express.Router();

// Issue #21: operator/game diagnostics. Every route is GET-only, read-only
// at the database level (BEGIN READ ONLY), and gated by the dedicated
// env-configured operator token — never by the player JWT, because this
// backend has no admin role and these views expose every participant's
// activity. When GAME_DIAGNOSTICS_TOKEN is unset the router answers 404
// for all three routes (fail closed).
gameDiagnosticsRouter.use(authenticateDiagnostics);

gameDiagnosticsRouter.get('/participants', getDiagnosticsParticipants);
gameDiagnosticsRouter.get('/activity', getDiagnosticsActivity);
gameDiagnosticsRouter.get('/bots', getDiagnosticsBots);

exports.gameDiagnosticsRouter = gameDiagnosticsRouter;
