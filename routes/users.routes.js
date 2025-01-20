const express = require('express');
const { 
  registerUser,
  loginUser,
  getUserProfile,
  updateUserProfile,
  deleteUser,
  updateUserFunds
} = require('../controllers/users.controller');
const { authenticateToken } = require('../middleware/auth.middleware');

const usersRouter = express.Router();

// Public routes
usersRouter.post('/register', registerUser);
usersRouter.post('/login', loginUser);

// Protected routes
usersRouter.get('/:user_id', authenticateToken, getUserProfile);
usersRouter.put('/:user_id', authenticateToken, updateUserProfile);
usersRouter.delete('/:user_id', authenticateToken, deleteUser);
usersRouter.patch('/:user_id/funds', authenticateToken, updateUserFunds);

module.exports = { usersRouter };
