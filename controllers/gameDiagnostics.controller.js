const diagnosticsService = require('../game/gameDiagnosticsService');

// Map diagnostics domain errors (which carry an explicit status) to
// responses; anything else falls through to the generic error middleware —
// exactly the game.controller.js convention.
function handleDiagnosticsError(err, res, next) {
  if (err && err.name === 'GameDiagnosticsError' && err.status) {
    return res.status(err.status).json({ status: 'error', message: err.message });
  }
  return next(err);
}

// Issue #21: restricted read-only per-participant summary for one cycle
// (current or completed). Cash is the authoritative participant state,
// never event replay.
exports.getDiagnosticsParticipants = async (req, res, next) => {
  try {
    const data = await diagnosticsService.getCycleDiagnosticsParticipants(req.query.cycleId);
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    handleDiagnosticsError(err, res, next);
  }
};

// Restricted read-only merged activity stream (BUY/SELL + FEE/TAX/EVENT),
// bounded and paginated via validated ?limit=, ?offset= and ?order=.
exports.getDiagnosticsActivity = async (req, res, next) => {
  try {
    const data = await diagnosticsService.getCycleDiagnosticsActivity(req.query.cycleId, {
      limit: req.query.limit,
      offset: req.query.offset,
      order: req.query.order
    });
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    handleDiagnosticsError(err, res, next);
  }
};

// Restricted read-only aggregate bot summary (ticks, executed BUY/SELL,
// HOLD/skipped, rejected) — bot behaviour without manual JSON parsing.
exports.getDiagnosticsBots = async (req, res, next) => {
  try {
    const data = await diagnosticsService.getCycleDiagnosticsBots(req.query.cycleId);
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    handleDiagnosticsError(err, res, next);
  }
};
