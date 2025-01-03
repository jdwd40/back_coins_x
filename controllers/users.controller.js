const { 
  createUser,
  authenticateUser,
  selectUserById,
  updateUser,
  removeUser
} = require('../models/users.model');

exports.registerUser = async (req, res, next) => {
  try {
    const { username, email, password } = req.body;
    
    if (!username || !email || !password) {
      return res.status(400).json({ msg: 'Missing required fields' });
    }

    const newUser = await createUser(username, email, password);
    res.status(201).json({ user: newUser });
  } catch (err) {
    if (err.code === '23505') { // Unique violation
      return res.status(409).json({ msg: 'Username or email already exists' });
    }
    next(err);
  }
};

exports.loginUser = async (req, res, next) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ msg: 'Missing required fields' });
    }

    const { user, token } = await authenticateUser(email, password);
    res.status(200).json({ user, token });
  } catch (err) {
    if (err.message === 'Invalid credentials') {
      return res.status(401).json({ msg: 'Invalid credentials' });
    }
    next(err);
  }
};

exports.getUserProfile = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    
    if (isNaN(user_id)) {
      return res.status(400).json({ msg: 'Invalid user ID' });
    }

    const user = await selectUserById(user_id);
    
    if (!user) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.status(200).json({ user });
  } catch (err) {
    next(err);
  }
};

exports.updateUserProfile = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    const updateData = req.body;
    
    if (isNaN(user_id)) {
      return res.status(400).json({ msg: 'Invalid user ID' });
    }

    const updatedUser = await updateUser(user_id, updateData);
    
    if (!updatedUser) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.status(200).json({ user: updatedUser });
  } catch (err) {
    next(err);
  }
};

exports.deleteUser = async (req, res, next) => {
  try {
    const { user_id } = req.params;
    
    if (isNaN(user_id)) {
      return res.status(400).json({ msg: 'Invalid user ID' });
    }

    const deleted = await removeUser(user_id);
    
    if (!deleted) {
      return res.status(404).json({ msg: 'User not found' });
    }

    res.status(204).json();
  } catch (err) {
    next(err);
  }
};
