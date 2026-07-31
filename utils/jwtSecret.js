/**
 * Single shared JWT secret configuration source.
 * Used by BOTH signing (authenticateUser) and verification (authenticateToken).
 *
 * Rules:
 * - In production (NODE_ENV=production): NEVER fallback. Missing/blank must be fatal at startup (see server.js).
 * - For non-production (test/development): use deliberately safe configured/test value only when env not provided.
 * - No hardcoded fallback secret in any production-capable code path.
 * - This module does not load dotenv; relies on db/connection or jest setup to have populated process.env.
 */

const getJwtSecret = () => {
  const secret = process.env.JWT_SECRET;
  const nodeEnv = process.env.NODE_ENV || 'development';

  if (nodeEnv === 'production') {
    if (!secret || typeof secret !== 'string' || secret.trim() === '') {
      // Never provide a fallback in production. Startup check should have exited already.
      // Throwing here ensures no silent bad token if somehow reached.
      throw new Error('JWT_SECRET is required in production and must not be blank');
    }
    return secret;
  }

  // Non-production only: prefer explicit env, else safe test/dev value.
  // These defaults are NEVER used under production NODE_ENV.
  if (secret && typeof secret === 'string' && secret.trim() !== '') {
    return secret;
  }

  if (nodeEnv === 'test') {
    return 'test-secret-key';
  }

  // Development fallback - deliberately obvious, not for any production use.
  return 'development-secret-key-not-for-production-use';
};

module.exports = { getJwtSecret };
