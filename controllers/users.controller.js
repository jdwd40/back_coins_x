const usersModel = require('../models/users.model');
const logger = require('../utils/logger');

const { 
  createUser,
  authenticateUser,
  selectUserById,
  updateUser,
  removeUser,
  updateUserFunds,
  getUserFunds
} = usersModel;

/**
 * Registers a new user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const registerUser = async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    
    // Basic validation (additional validation in model)
    if (!username || !email || !password) {
      return res.status(400).json({ 
        success: false,
        msg: 'Missing required fields',
        details: {
          username: username ? null : 'Username is required',
          email: email ? null : 'Email is required',
          password: password ? null : 'Password is required'
        }
      });
    }

    const newUser = await createUser(username, email, password);
    
    logger.log(`User registered successfully: ${username} (${email})`);
    
    res.status(201).json({ 
      success: true,
      msg: 'User registered successfully',
      user: newUser 
    });
  } catch (err) {
    logger.error('Registration error:', err.message);
    
    if (err.message.includes('Username already exists') || 
        err.message.includes('Email already exists') ||
        err.message.includes('User already exists')) {
      return res.status(409).json({ 
        success: false,
        msg: err.message 
      });
    }
    
    if (err.message.includes('Username is required') ||
        err.message.includes('Valid email is required') ||
        err.message.includes('Password must be at least')) {
      return res.status(400).json({ 
        success: false,
        msg: 'Validation failed',
        details: err.message
      });
    }
    
    if (err.code === '23505') { // Unique violation
      return res.status(409).json({ 
        success: false,
        msg: 'Username or email already exists' 
      });
    }
    
    next(err);
  }
};

/**
 * Authenticates a user and returns a JWT token
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    
    // Basic validation (additional validation in model)
    if (!email || !password) {
      return res.status(400).json({ 
        success: false,
        msg: 'Missing required fields',
        details: {
          email: email ? null : 'Email is required',
          password: password ? null : 'Password is required'
        }
      });
    }

    const { user, token } = await authenticateUser(email, password);
    
    logger.log(`User logged in: ${user.username} (${user.email})`);
    
    res.status(200).json({ 
      success: true,
      msg: 'Login successful',
      user, 
      token 
    });
  } catch (err) {
    logger.error('Login error:', err.message);
    
    if (err.message === 'Invalid credentials') {
      return res.status(401).json({ 
        success: false,
        msg: 'Invalid email or password' 
      });
    }
    
    if (err.message.includes('Valid email is required') ||
        err.message.includes('Password is required')) {
      return res.status(400).json({ 
        success: false,
        msg: 'Validation failed',
        details: err.message
      });
    }
    
    next(err);
  }
};

/**
 * Gets a user's profile
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const getUserProfile = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    
    if (isNaN(Number(user_id))) {
      return res.status(400).json({ 
        success: false,
        msg: 'Invalid user ID' 
      });
    }

    const user = await selectUserById(user_id);
    if (!user) {
      return res.status(404).json({ 
        success: false,
        msg: 'User not found' 
      });
    }

    res.status(200).json({ 
      success: true,
      user 
    });
  } catch (err) {
    logger.error('Get user profile error:', err.message);
    
    if (err.message.includes('Valid user ID is required')) {
      return res.status(400).json({ 
        success: false,
        msg: 'Invalid user ID' 
      });
    }
    
    next(err);
  }
};

/**
 * Updates a user's profile
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const updateUserProfile = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    const updates = req.body;
    
    if (isNaN(Number(user_id))) {
      return res.status(400).json({ 
        success: false,
        msg: 'Invalid user ID' 
      });
    }
    
    if (!updates || Object.keys(updates).length === 0) {
      return res.status(400).json({ 
        success: false,
        msg: 'No update data provided' 
      });
    }

    const updatedUser = await updateUser(user_id, updates);
    if (!updatedUser) {
      return res.status(404).json({ 
        success: false,
        msg: 'User not found' 
      });
    }

    logger.log(`User profile updated: ${updatedUser.username} (ID: ${user_id})`);
    
    res.status(200).json({ 
      success: true,
      msg: 'Profile updated successfully',
      user: updatedUser 
    });
  } catch (err) {
    logger.error('Update user profile error:', err.message);
    
    if (err.message.includes('Username must be') ||
        err.message.includes('Valid email is required') ||
        err.message.includes('Password must be')) {
      return res.status(400).json({ 
        success: false,
        msg: 'Validation failed',
        details: err.message
      });
    }
    
    if (err.message.includes('already exists')) {
      return res.status(409).json({ 
        success: false,
        msg: err.message 
      });
    }
    
    if (err.code === '23505') {
      return res.status(409).json({ 
        success: false,
        msg: 'Username or email already exists' 
      });
    }
    
    next(err);
  }
};

/**
 * Deletes a user
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const deleteUser = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    
    if (isNaN(Number(user_id))) {
      return res.status(400).json({ 
        success: false,
        msg: 'Invalid user ID' 
      });
    }

    const deletedUser = await removeUser(user_id);
    if (!deletedUser) {
      return res.status(404).json({ 
        success: false,
        msg: 'User not found' 
      });
    }

    logger.log(`User deleted: ${deletedUser.username} (ID: ${user_id})`);
    
    res.status(200).json({ 
      success: true,
      msg: 'User deleted successfully' 
    });
  } catch (err) {
    logger.error('Delete user error:', err.message);
    
    if (err.message.includes('Valid user ID is required')) {
      return res.status(400).json({ 
        success: false,
        msg: 'Invalid user ID' 
      });
    }
    
    next(err);
  }
};

/**
 * Updates a user's funds
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {Function} next - Express next middleware function
 */
const updateUserFundsHandler = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    const { amount } = req.body;

    if (isNaN(Number(user_id))) {
      return res.status(400).json({ 
        success: false,
        msg: 'Invalid user ID' 
      });
    }
    
    if (amount === undefined || amount === null) {
      return res.status(400).json({ 
        success: false,
        msg: 'Amount is required' 
      });
    }

    // Verify amount is a valid number
    const fundAmount = parseFloat(amount);
    if (isNaN(fundAmount)) {
      return res.status(400).json({ 
        success: false,
        msg: 'Invalid amount provided' 
      });
    }

    // Get current funds
    const currentFunds = await getUserFunds(user_id);
    const newFunds = parseFloat(currentFunds) + fundAmount;

    // Don't allow negative funds
    if (newFunds < 0) {
      return res.status(400).json({ 
        success: false,
        msg: 'Insufficient funds' 
      });
    }

    // Update funds
    const updatedUser = await updateUserFunds(user_id, fundAmount);
    
    logger.log(`User funds updated: ${updatedUser.username} (ID: ${user_id}), Amount: ${fundAmount}`);
    
    res.status(200).json({
      success: true,
      msg: 'Funds updated successfully',
      user: updatedUser
    });
  } catch (error) {
    logger.error('Error updating user funds:', error.message);
    
    if (error.message === 'User not found') {
      return res.status(404).json({ 
        success: false,
        msg: 'User not found' 
      });
    }
    
    if (error.message.includes('Valid user ID is required') ||
        error.message.includes('Amount must be a valid number')) {
      return res.status(400).json({ 
        success: false,
        msg: error.message 
      });
    }
    
    next(error);
  }
};

module.exports = {
  registerUser,
  loginUser,
  getUserProfile,
  updateUserProfile,
  deleteUser,
  updateUserFunds: updateUserFundsHandler
};
