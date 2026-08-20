// The guard is the last line of defence keeping destructive test setup away
// from development/production databases. These tests prove it rejects every
// non-approved target shape.

const { assertDisposableTestDatabase, isLocalHost } = require('./helpers/testDatabaseGuard');

describe('test database guard', () => {
  const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'PGHOST', 'PGDATABASE'];
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test('accepts the approved local disposable test database', () => {
    delete process.env.DATABASE_URL;
    process.env.PGHOST = '/var/run/postgresql';
    process.env.PGDATABASE = 'coins_test';
    expect(assertDisposableTestDatabase()).toEqual({ host: '/var/run/postgresql', database: 'coins_test' });
  });

  test('rejects when NODE_ENV is not test', () => {
    process.env.NODE_ENV = 'development';
    expect(() => assertDisposableTestDatabase()).toThrow(/NODE_ENV must be "test"/);
  });

  test('rejects a non-test database name', () => {
    delete process.env.DATABASE_URL;
    process.env.PGHOST = 'localhost';
    process.env.PGDATABASE = 'coins'; // the real development database
    expect(() => assertDisposableTestDatabase()).toThrow(/refusing/);
  });

  test('rejects a production-shaped DATABASE_URL even when it contains "test"', () => {
    process.env.DATABASE_URL = 'postgresql://user:secret@prod.example.com:5432/coins_test';
    expect(() => assertDisposableTestDatabase()).toThrow(/non-local host/);
  });

  test('accepts a local DATABASE_URL test database', () => {
    process.env.DATABASE_URL = 'postgresql://jd@localhost:5432/coins_test';
    expect(assertDisposableTestDatabase().database).toBe('coins_test');
  });

  test('host classifier', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('/var/run/postgresql')).toBe(true);
    expect(isLocalHost('10.0.0.5')).toBe(false);
    expect(isLocalHost('db.example.com')).toBe(false);
  });
});
