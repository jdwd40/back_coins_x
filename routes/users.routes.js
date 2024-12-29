const express = require('express');
const { 
  registerUser,
  loginUser,
  getUserProfile,
  updateUserProfile,
  deleteUser
} = require('../controllers/users.controller');

const usersRouter = express.Router();

// Authentication routes
usersRouter.post('/register', registerUser);
usersRouter.post('/login', loginUser);

// Profile routes
usersRouter.get('/:user_id', getUserProfile);
usersRouter.put('/:user_id', updateUserProfile);
usersRouter.delete('/:user_id', deleteUser);

module.exports = { usersRouter };
