// Persistent-market Stage 6: persistent API routes. Mounted at
// /api/persistent — additive only; the old cycle-shaped routes stay
// mounted unchanged for the deployed frontend (Stage 13 removal debt).
//
// Stage 10A (S10-01): GET /leaderboard is public (no auth), matching the
// legacy GET /api/game/leaderboard convention.

const express = require('express');
const {
  buyPersistent,
  sellPersistent,
  getMyPersistentAccount,
  getMyPersistentTransactions,
  getPersistentLeaderboard,
  getPersistentMarketSignals
} = require('../controllers/persistent.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const persistentRouter = express.Router();

persistentRouter.post('/trades/buy', authenticateToken, buyPersistent);
persistentRouter.post('/trades/sell', authenticateToken, sellPersistent);
persistentRouter.get('/account', authenticateToken, getMyPersistentAccount);
persistentRouter.get('/transactions', authenticateToken, getMyPersistentTransactions);
// Primary Stage 10A public persistent leaderboard.
persistentRouter.get('/leaderboard', getPersistentLeaderboard);
// Stage 11-02: public read-only persistent market signals (soft world resolve,
// exact key contract, authoritative current_price from coins, no mutations).
persistentRouter.get('/signals', getPersistentMarketSignals);

exports.persistentRouter = persistentRouter;
