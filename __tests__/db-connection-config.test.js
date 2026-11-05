// Proves, against the real db/connection.js, that the Pool receives the
// effective credentials while nothing printed or thrown discloses them, and
// that the destructive-test guard judges the same target the Pool reaches.

const { inspect } = require('util');
const ConnectionParameters = require('pg/lib/connection-parameters');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'PGHOST', 'PGPORT', 'PGUSER', 'PGPASSWORD', 'PGDATABASE'];
const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'];
const HOSTILE_PASSWORD = `p@ss:w/rd?#%&+= é'"\\`;

// Loads a fresh db/connection.js under `env` with Pool and .env loading stubbed.
function loadConnection(env) {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, { NODE_ENV: 'test' }, env);

  const poolConfigs = [];
  jest.doMock('pg', () => ({
    Pool: class {
      constructor(config) {
        poolConfigs.push(config);
      }
    },
  }));
  jest.doMock('dotenv', () => ({ config: () => ({}) }));

  const output = [];
  for (const method of CONSOLE_METHODS) {
    jest.spyOn(console, method).mockImplementation((...args) => output.push(inspect(args)));
  }

  let error;
  jest.isolateModules(() => {
    try {
      require('../db/connection');
    } catch (err) {
      error = err;
    }
  });

  return { poolConfig: poolConfigs[0], output: output.join('\n'), error };
}

describe('db/connection.js', () => {
  let saved;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });
  afterEach(() => {
    jest.dontMock('pg');
    jest.dontMock('dotenv');
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  describe('PG* variables', () => {
    test.each([
      ['reserved URL characters', HOSTILE_PASSWORD],
      ['a literal percent escape', 'abc%40def'],
      ['surrounding whitespace', '  padded  '],
      ['plain text', 'hunter2'],
    ])('delivers a password with %s to the Pool and keeps it out of logs', (_label, password) => {
      const { poolConfig, output, error } = loadConnection({
        PGUSER: 'app@user',
        PGPASSWORD: password,
        PGHOST: 'db.internal',
        PGPORT: '6543',
        PGDATABASE: 'coins_test',
      });

      expect(error).toBeUndefined();
      const effective = new ConnectionParameters(poolConfig);
      expect(effective.password).toBe(password);
      expect(effective).toMatchObject({ user: 'app@user', host: 'db.internal', port: 6543, database: 'coins_test' });
      expect(output).not.toContain(password);
      expect(output).not.toContain(encodeURIComponent(password));
    });

    test('keeps the existing defaults', () => {
      const { poolConfig } = loadConnection({ PGDATABASE: 'coins_test' });
      expect(new ConnectionParameters(poolConfig)).toMatchObject({
        user: 'jd',
        host: 'localhost',
        port: 5432,
        database: 'coins_test',
      });
    });

    test.each([
      ['unset', {}],
      ['empty', { PGPASSWORD: '' }],
      ['blank', { PGPASSWORD: '   ' }],
    ])('sends no password when PGPASSWORD is %s', (_label, env) => {
      const { poolConfig } = loadConnection({ PGDATABASE: 'coins_test', ...env });
      expect(poolConfig).not.toHaveProperty('password');
    });

    test('supports a unix-socket PGHOST', () => {
      const { poolConfig } = loadConnection({
        PGHOST: '/var/run/postgresql',
        PGPORT: '5434',
        PGDATABASE: 'coins_test',
      });
      expect(new ConnectionParameters(poolConfig)).toMatchObject({
        host: '/var/run/postgresql',
        port: 5434,
        database: 'coins_test',
        isDomainSocket: true,
      });
    });
  });

  describe('DATABASE_URL', () => {
    const encoded = encodeURIComponent(HOSTILE_PASSWORD);

    test('reaches the Pool verbatim with its decoded credentials and stays out of logs', () => {
      const url = `postgresql://app:${encoded}@db.example.com:6543/coins?sslmode=no-verify`;
      const { poolConfig, output, error } = loadConnection({ DATABASE_URL: url });

      expect(error).toBeUndefined();
      expect(poolConfig).toEqual({ connectionString: url });
      const effective = new ConnectionParameters(poolConfig);
      expect(effective.password).toBe(HOSTILE_PASSWORD);
      expect(effective).toMatchObject({ user: 'app', host: 'db.example.com', port: 6543, database: 'coins' });
      expect(output).not.toContain(encoded);
      expect(output).not.toContain(HOSTILE_PASSWORD);
      expect(output).not.toContain('postgresql://');
    });

    test('keeps credentials passed as connection-string parameters out of logs', () => {
      const url = 'postgresql://db.example.com/coins?user=qs-user&password=qs-secret&sslpassword=qs-key-secret';
      const { poolConfig, output } = loadConnection({ DATABASE_URL: url });

      expect(new ConnectionParameters(poolConfig).password).toBe('qs-secret');
      expect(output).not.toContain('qs-secret');
      expect(output).not.toContain('qs-key-secret');
      expect(output).not.toContain('qs-user');
    });

    test('takes precedence over PG* variables', () => {
      const url = 'postgresql://app:url-secret@db.example.com/coins';
      const { poolConfig } = loadConnection({
        DATABASE_URL: url,
        PGHOST: 'other.example.com',
        PGPASSWORD: 'pg-secret',
        PGDATABASE: 'other',
      });

      expect(poolConfig).toEqual({ connectionString: url });
      const effective = new ConnectionParameters(poolConfig);
      expect(effective.password).toBe('url-secret');
      expect(effective).toMatchObject({ host: 'db.example.com', database: 'coins' });
    });

    test('leaves a passwordless URL without a password', () => {
      const { poolConfig } = loadConnection({ DATABASE_URL: 'postgresql://app@db.example.com/coins' });
      expect(new ConnectionParameters(poolConfig).password).toBeNull();
    });

    test.each([
      ['an unparseable host', 'postgresql://app:s3cret@[bad/coins'],
      ['a space in the host', 'postgresql://app:s3cret@ho st:x/coins'],
    ])('fails with a sanitised error and no Pool on %s', (_label, url) => {
      const { poolConfig, output, error } = loadConnection({ DATABASE_URL: url });

      expect(poolConfig).toBeUndefined();
      expect(error).toBeInstanceOf(Error);
      expect(inspect(error)).not.toContain('s3cret');
      expect(output).not.toContain('s3cret');
    });

    test('does not log a password misparsed out of a malformed URL', () => {
      const { output, error } = loadConnection({ DATABASE_URL: 'postgresql://app:123/s3cret@localhost/coins' });
      expect(error).toBeUndefined();
      expect(output).not.toContain('s3cret');
    });
  });

  test('still requires a configured database', () => {
    const { error } = loadConnection({});
    expect(error.message).toBe('PGDATABASE or DATABASE_URL not set');
  });

  describe('guard parity with the Pool', () => {
    test.each([
      ['PG* over TCP', { PGHOST: 'localhost', PGDATABASE: 'coins_test' }],
      ['PG* over a unix socket', { PGHOST: '/var/run/postgresql', PGDATABASE: 'coins_test' }],
      ['PG* with a password', { PGPASSWORD: HOSTILE_PASSWORD, PGDATABASE: 'coins_test' }],
      ['a query-like PGDATABASE', { PGDATABASE: 'coins_test?host=prod.example.com' }],
      ['DATABASE_URL over TCP', { DATABASE_URL: 'postgresql://jd:pw@127.0.0.1:5434/coins_test' }],
      ['DATABASE_URL with an encoded database', { DATABASE_URL: 'postgresql://jd@localhost/coins%5Ftest' }],
      ['DATABASE_URL with a query socket', { DATABASE_URL: 'postgresql:///coins_test?host=/var/run/postgresql' }],
      ['DATABASE_URL over PG*', { DATABASE_URL: 'postgresql://jd@localhost/coins_test', PGDATABASE: 'coins' }],
    ])('approves exactly what the Pool reaches: %s', (_label, env) => {
      const { poolConfig } = loadConnection(env);
      const { host, database } = new ConnectionParameters(poolConfig);
      expect(assertDisposableTestDatabase()).toEqual({ host, database });
    });

    test.each([
      ['a remote PGHOST', { PGHOST: 'prod.example.com', PGDATABASE: 'coins_test' }],
      ['a non-test PGDATABASE', { PGHOST: 'localhost', PGDATABASE: 'coins' }],
      ['a remote DATABASE_URL', { DATABASE_URL: 'postgresql://jd@prod.example.com/coins_test' }],
      ['a query host override', { DATABASE_URL: 'postgresql://jd@localhost/coins_test?host=prod.example.com' }],
    ])('rejects %s', (_label, env) => {
      loadConnection(env);
      expect(() => assertDisposableTestDatabase()).toThrow(/test database guard/);
    });
  });
});
