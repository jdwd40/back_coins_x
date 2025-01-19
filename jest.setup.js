const db = require('./db/connection');
const seed = require('./db/seed');

// Set up test environment variables
process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

beforeEach(async () => {
  await seed();
});

afterAll(async () => {
  await db.end();
});
