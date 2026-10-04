// Issue #49's literal-mask premise was false: the original used the real
// password. These tests defend genuine credential-log hardening and preserve
// authentication configuration. Pool is mocked: nothing connects.
//
// These tests re-require the module with stubbed environment variables and a
// mocked 'pg' module, capturing the exact config handed to new Pool(...).
// Nothing connects to anything.

describe('db/connection pool password handling (issue #49)', () => {
  const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'PGUSER', 'PGPASSWORD', 'PGHOST', 'PGPORT', 'PGDATABASE'];
  let saved;

  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  });

  afterEach(() => {
    jest.dontMock('pg');
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Re-require db/connection with 'pg' mocked; returns the config object the
  // module passed to new Pool(config).
  function loadPoolConfig() {
    const poolConfigs = [];
    jest.resetModules();
    jest.doMock('pg', () => ({
      Pool: jest.fn(function (config) {
        poolConfigs.push(config);
        return { query: jest.fn(), connect: jest.fn(), end: jest.fn() };
      })
    }));
    require('../db/connection');
    jest.dontMock('pg');
    expect(poolConfigs).toHaveLength(1);
    return poolConfigs[0];
  }

  function stubLocalEnv(password) {
    delete process.env.DATABASE_URL;
    process.env.PGUSER = 'jd';
    process.env.PGPASSWORD = password;
    process.env.PGHOST = 'localhost';
    process.env.PGPORT = '5432';
    process.env.PGDATABASE = 'coins_test';
  }

  test('the Pool config contains the real PGPASSWORD, never a mask', () => {
    stubLocalEnv('sup3r-s3cret-pg-password');
    const config = loadPoolConfig();

    expect(config.password).toBe(process.env.PGPASSWORD);
    expect(config.password).not.toBe('***');
    expect(config.host).toBe('localhost');
    expect(config.database).toBe('coins_test');
  });

  test('the test-mode debug log is redacted and never includes the real password', () => {
    stubLocalEnv('sup3r-s3cret-pg-password');
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    loadPoolConfig();

    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).not.toContain('sup3r-s3cret-pg-password');
    expect(logged).toContain('[redacted connection configuration]');
  });

  test('a DATABASE_URL-shaped config is never logged with its credentials', () => {
    process.env.DATABASE_URL = 'postgresql://jd:sup3r-s3cret-pg-password@db.example.com:5432/coins_test';
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const config = loadPoolConfig();

    expect(config.connectionString).toBe(process.env.DATABASE_URL);
    const logged = logSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    expect(logged).not.toContain('sup3r-s3cret-pg-password');
    expect(logged).not.toContain(process.env.DATABASE_URL);
  });
});
