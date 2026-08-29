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

// Apocalypse Monitor Phase 2: restricted read-only raw price_history series
// for one cycle, with exact (cycle_id) vs time-window-derived (legacy NULL
// rows) attribution. Optional ?cycleId=APOC-NNNN and ?coinId=<positive int>.
exports.getDiagnosticsMonitor = async (req, res, next) => {
  try {
    const data = await diagnosticsService.getCycleDiagnosticsMonitor(req.query.cycleId, {
      coinId: req.query.coinId
    });
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    handleDiagnosticsError(err, res, next);
  }
};

// Apocalypse Monitor Phase 2.5: restricted read-only newest-first cycle
// discovery (public cycle fields + hasExactHistory exact-provenance flag).
// Optional ?limit= strict integer 1-100 (default 20; 400 invalid/excessive).
exports.getDiagnosticsMonitorCycles = async (req, res, next) => {
  try {
    const data = await diagnosticsService.getCycleDiagnosticsMonitorCycles({
      limit: req.query.limit
    });
    res.status(200).json({ status: 'success', data });
  } catch (err) {
    handleDiagnosticsError(err, res, next);
  }
};
