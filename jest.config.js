/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  moduleFileExtensions: ['js', 'json'],
  testPathIgnorePatterns: [
    '/node_modules/',
    // Player-facing /api/game HTTP suites retired with the Apocalypse cutover
    // (PR #42). The 404 contract is covered by game-api-cutover.test.js.
    // Cycle *domain* suites that call gameRoundService/botService directly
    // remain in the default run.
    '<rootDir>/__tests__/game-state.test.js',
    '<rootDir>/__tests__/game-public-state-no-seed.test.js',
    '<rootDir>/__tests__/game-join.test.js',
    '<rootDir>/__tests__/game-leaderboard.test.js',
    '<rootDir>/__tests__/game-trades.test.js',
    '<rootDir>/__tests__/game-trades-fractional.test.js',
    '<rootDir>/__tests__/game-profitable-leaderboard.test.js',
    '<rootDir>/__tests__/v2-market-signals.test.js',
    '<rootDir>/__tests__/v2-market-signals-events.test.js',
    '<rootDir>/__tests__/v2-collapse-risk.test.js',
    '<rootDir>/__tests__/market-state-redaction.test.js'
  ],
  verbose: true,
  forceExit: true,
  clearMocks: true,
  resetMocks: true,
  restoreMocks: true,
  setupFiles: ['dotenv/config'],
  setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
  globals: {
    'process.env.SHELL': '/bin/bash',
    'process.platform': 'linux'
  }
};
