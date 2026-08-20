const db = require('./db/connection');
const seed = require('./db/seed');
const { assertDisposableTestDatabase } = require('./__tests__/helpers/testDatabaseGuard');

// Set up test environment variables
process.env.JWT_SECRET = 'test-secret-key';
process.env.NODE_ENV = 'test';

// Hard guard: the suite mutates its database (full reseed before each test).
// Prove the target is the approved disposable local test DB before anything
// runs — never a development or production database.
assertDisposableTestDatabase();

beforeEach(async () => {
  assertDisposableTestDatabase();
  await seed();
});

afterAll(async () => {
  await db.end();
});
