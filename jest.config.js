/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/__tests__/**/*.test.js'],
  moduleFileExtensions: ['js', 'json'],
  testPathIgnorePatterns: ['/node_modules/'],
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
