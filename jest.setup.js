const seed = require('./db/seed');
const db = require('./db/connection');

beforeEach(() => seed());
afterAll(() => db.end());
