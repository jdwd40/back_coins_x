const db = require('./db/connection');
const seed = require('./db/seed');

beforeEach(async () => {
  await seed();
});

afterAll(async () => {
  await db.end();
});
