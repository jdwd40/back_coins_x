const jwt = require('jsonwebtoken');
const { selectUserById } = require('../models/users.model');
const { getJwtSecret } = require('../utils/jwtSecret');

exports.authenticateToken = async (req, res, next) => {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

    if (!token) {
      return res.status(401).json({ msg: 'Authentication required' });
    }

    const decoded = jwt.verify(token, getJwtSecret());
    const user = await selectUserById(decoded.user_id);

    if (!user) {
      return res.status(401).json({ msg: 'Invalid token' });
    }

    // Add user to request object for use in protected routes
    req.user = user;
    next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ msg: 'Invalid token' });
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ msg: 'Token expired' });
    }
    next(err);
  }
};

/**
 * Restrict global coin price mutation to system key or configured admins.
 * Fail-closed: if no PRICE_ADMIN_API_KEY/SYSTEM_API_KEY match and user is not
 * listed in ADMIN_USER_IDS / ADMIN_EMAILS, respond 403.
 *
 * System path (internal tooling): header `X-System-Key` or `X-Admin-Key`
 * matching PRICE_ADMIN_API_KEY or SYSTEM_API_KEY (skips user check when present
 * after authenticateToken is not required — use on routes that allow either).
 */
function parseCsvEnv(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function systemKeyMatches(req) {
  // Honor either key when both are set (not only the first non-empty env).
  const configured = [process.env.PRICE_ADMIN_API_KEY, process.env.SYSTEM_API_KEY]
    .filter((k) => k && String(k).trim().length > 0);
  if (configured.length === 0) return false;
  const provided =
    req.headers['x-system-key'] ||
    req.headers['x-admin-key'] ||
    null;
  if (!provided) return false;
  return configured.some((k) => provided === k);
}

function userIsConfiguredAdmin(user) {
  if (!user) return false;
  const adminIds = parseCsvEnv('ADMIN_USER_IDS');
  const adminEmails = parseCsvEnv('ADMIN_EMAILS');
  const adminUsernames = parseCsvEnv('ADMIN_USERNAMES');
  if (adminIds.includes(String(user.user_id))) return true;
  if (user.email && adminEmails.includes(String(user.email).toLowerCase())) return true;
  if (user.username && adminUsernames.includes(String(user.username).toLowerCase())) return true;
  return false;
}

// Alias used by price-admin middleware
const userIsPriceAdmin = userIsConfiguredAdmin;

/**
 * After authenticateToken: only allow configured admin users.
 * Does not accept system key (use requirePriceAdminOrSystem for that).
 */
exports.requirePriceAdmin = (req, res, next) => {
  if (userIsPriceAdmin(req.user)) {
    return next();
  }
  return res.status(403).json({ msg: 'Admin privileges required to update coin prices' });
};

/**
 * After authenticateToken: require path :user_id to match the caller,
 * or the caller to be a configured admin (ADMIN_USER_IDS / EMAILS / USERNAMES).
 * Blocks cross-user password / profile / funds / delete attacks.
 */
exports.requireSelfOrAdmin = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ msg: 'Authentication required' });
  }
  const targetId = parseInt(req.params.user_id, 10);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({
      success: false,
      msg: 'Invalid user ID',
    });
  }
  if (Number(req.user.user_id) === targetId) {
    return next();
  }
  if (userIsConfiguredAdmin(req.user)) {
    return next();
  }
  return res.status(403).json({
    success: false,
    msg: 'Forbidden: you can only modify your own account',
  });
};

/**
 * Allow either a matching system API key OR an authenticated admin user.
 * Place after optional auth, or use alone when system key should skip JWT.
 */
exports.requirePriceAdminOrSystem = async (req, res, next) => {
  try {
    if (systemKeyMatches(req)) {
      req.isSystem = true;
      return next();
    }

    // Fall through to JWT admin path
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) {
      return res.status(401).json({ msg: 'Authentication required' });
    }
    const decoded = jwt.verify(token, getJwtSecret());
    const user = await selectUserById(decoded.user_id);
    if (!user) {
      return res.status(401).json({ msg: 'Invalid token' });
    }
    req.user = user;
    if (!userIsPriceAdmin(user)) {
      return res.status(403).json({ msg: 'Admin privileges required to update coin prices' });
    }
    return next();
  } catch (err) {
    if (err.name === 'JsonWebTokenError') {
      return res.status(401).json({ msg: 'Invalid token' });
    }
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ msg: 'Token expired' });
    }
    return next(err);
  }
};
