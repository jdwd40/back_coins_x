// The guard is the last line of defence keeping destructive test setup away
// from development/production databases. These tests prove it rejects every
// non-approved target shape.

const { inspect } = require('util');
const { assertDisposableTestDatabase, isLocalHost } = require('./helpers/testDatabaseGuard');

describe('test database guard', () => {
  const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD', 'PGPORT'];
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

  test('fails closed when no database is configured', () => {
    delete process.env.DATABASE_URL;
    delete process.env.PGDATABASE;
    expect(() => assertDisposableTestDatabase()).toThrow(/not set/);
  });

  test('accepts a socket host given as the only host in a DATABASE_URL', () => {
    process.env.DATABASE_URL = 'postgresql://jd@%2Fvar%2Frun%2Fpostgresql/coins_test';
    expect(assertDisposableTestDatabase()).toEqual({ host: '/var/run/postgresql', database: 'coins_test' });
  });

  test.each([
    ['query host overriding a local authority', 'postgresql://jd@localhost:5432/coins_test?host=prod.example.com'],
    ['query host alongside a remote authority', 'postgresql://jd@prod.example.com/coins_test?host=localhost'],
    ['repeated query hosts', 'postgresql:///coins_test?host=localhost&host=prod.example.com'],
    ['host inherited from the environment', 'postgresql:///coins_test'],
    ['database inherited from the environment', 'postgresql://jd@localhost:5432/'],
    ['database query parameter', 'postgresql://jd@localhost/coins_test?database=coins'],
    ['multiple hosts', 'postgresql://jd@localhost,prod.example.com/coins_test'],
    ['non-postgres scheme', 'mysql://jd@localhost/coins_test'],
    ['socket scheme', 'socket:/var/run/postgresql?db=coins_test'],
    ['bare socket string', '/var/run/postgresql coins_test'],
    ['schemeless string', 'localhost/coins_test'],
    ['unparseable URL', 'postgresql://jd:pw@[bad/coins_test'],
  ])('rejects DATABASE_URL with %s', (_label, databaseUrl) => {
    process.env.PGHOST = 'prod.example.com';
    process.env.PGDATABASE = 'coins_test';
    process.env.DATABASE_URL = databaseUrl;
    expect(() => assertDisposableTestDatabase()).toThrow(/test database guard/);
  });

  test.each([
    ['unencoded slash moves the password into the database', 'postgresql://jd:123/s3cret-test@localhost/coins_test'],
    ['unencoded slash with a non-test database', 'postgresql://localhost/s3cret'],
    ['unparseable URL', 'postgresql://jd:s3cret@[bad/coins_test'],
    ['password fragment in the host', 'postgresql://s3cret-host/coins_test'],
  ])('never echoes URL content in its errors: %s', (_label, databaseUrl) => {
    process.env.DATABASE_URL = databaseUrl;
    expect(() => assertDisposableTestDatabase()).toThrow(/test database guard/);
    let message;
    try {
      assertDisposableTestDatabase();
    } catch (err) {
      message = inspect(err);
    }
    expect(message).not.toContain('s3cret');
  });

  test('host classifier', () => {
    expect(isLocalHost('localhost')).toBe(true);
    expect(isLocalHost('127.0.0.1')).toBe(true);
    expect(isLocalHost('/var/run/postgresql')).toBe(true);
    expect(isLocalHost('10.0.0.5')).toBe(false);
    expect(isLocalHost('db.example.com')).toBe(false);
    expect(isLocalHost('')).toBe(false);
    expect(isLocalHost('localhost,prod.example.com')).toBe(false);
  });
});
