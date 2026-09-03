// Persistent-market Stage 6: persistent API routes. Mounted at
// /api/persistent — additive only; the old cycle-shaped routes stay
// mounted unchanged for the deployed frontend (Stage 13 removal debt).

const express = require('express');
const {
  buyPersistent,
  sellPersistent,
  getMyPersistentAccount,
  getMyPersistentTransactions
} = require('../controllers/persistent.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const persistentRouter = express.Router();

persistentRouter.post('/trades/buy', authenticateToken, buyPersistent);
persistentRouter.post('/trades/sell', authenticateToken, sellPersistent);
persistentRouter.get('/account', authenticateToken, getMyPersistentAccount);
persistentRouter.get('/transactions', authenticateToken, getMyPersistentTransactions);

exports.persistentRouter = persistentRouter;
