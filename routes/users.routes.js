const express = require('express');
const { 
  registerUser,
  loginUser,
  getUserProfile,
  updateUserProfile,
  deleteUser,
  updateUserFunds
} = require('../controllers/users.controller');
const { authenticateToken, requireSelfOrAdmin } = require('../middleware/auth.middleware');

const usersRouter = express.Router();

// Public routes
usersRouter.post('/register', registerUser);
usersRouter.post('/login', loginUser);

// Protected routes
usersRouter.get('/:user_id', authenticateToken, getUserProfile);
// Mutating routes: self or configured admin only (blocks cross-user password takeover)
usersRouter.put('/:user_id', authenticateToken, requireSelfOrAdmin, updateUserProfile);
usersRouter.delete('/:user_id', authenticateToken, requireSelfOrAdmin, deleteUser);
usersRouter.patch('/:user_id/funds', authenticateToken, requireSelfOrAdmin, updateUserFunds);

module.exports = { usersRouter };
