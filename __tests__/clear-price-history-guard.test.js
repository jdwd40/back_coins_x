// Regression suite for issue #50 (HIGH): clear-price-history.js ran
// TRUNCATE price_history CASCADE against whatever database the ambient
// environment resolved to — including production — via
// `npm run clear-price-history`. The script must now:
//   * refuse NODE_ENV=production outright,
//   * refuse unless the resolved database name contains "test" AND the
//     resolved host is local,
//   * abort without an explicit confirmation (--yes or
//     CONFIRM_CLEAR_PRICE_HISTORY=YES), printing what it would have done.
//
// The script is spawned as a child process with hostile env combinations.
// Every child uses fixture dotenv files and a mocked Pool. pg.Client's real
// resolver is retained, but no query can ever reach a database.

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SCRIPT = path.join(__dirname, '..', 'clear-price-history.js');

function runScript(envOverrides, args = [], dotenv = '') {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith('PG') || ['DATABASE_URL', 'CONFIRM_CLEAR_PRICE_HISTORY', 'NODE_OPTIONS'].includes(key)) delete env[key];
  }
  Object.assign(env, envOverrides);
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete env[key];
  }
  const fixture = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'clear-guard-'));
  fs.mkdirSync(path.join(fixture, 'db'));
  fs.copyFileSync(SCRIPT, path.join(fixture, 'clear-price-history.js'));
  fs.copyFileSync(path.join(__dirname, '../db/connectionConfig.js'), path.join(fixture, 'db/connectionConfig.js'));
  fs.copyFileSync(path.join(__dirname, '../db/connection.js'), path.join(fixture, 'db/connection.js'));
  fs.symlinkSync(path.join(__dirname, '../node_modules'), path.join(fixture, 'node_modules'));
  fs.writeFileSync(path.join(fixture, `.env.${env.NODE_ENV || 'development'}`), dotenv);
  fs.writeFileSync(path.join(fixture, 'mock.js'), `
    const pg = require(${JSON.stringify(require.resolve('pg'))});
    pg.Pool = class {
      constructor(config) {
        const {host, database} = new pg.Client(config).connectionParameters;
        console.log('MOCK_POOL_TARGET', JSON.stringify({host, database}));
      }
      async query(sql) { console.log('MOCK_QUERY', sql); }
      async end() { console.log('MOCK_END'); }
    };
  `);
  try {
    return spawnSync(process.execPath, ['--require', path.join(fixture, 'mock.js'), path.join(fixture, 'clear-price-history.js'), ...args], {
      env, encoding: 'utf8', timeout: 10000
    });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
}

function outputOf(result) {
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

describe('clear-price-history.js destructive-action guard (issue #50)', () => {
  test('refuses NODE_ENV=production, even with --yes', () => {
    const result = runScript({
      NODE_ENV: 'production',
      PGHOST: 'localhost',
      PGDATABASE: 'coins_prod_shaped_nonexistent'
    }, ['--yes']);

    const out = outputOf(result);
    expect(result.status).not.toBe(0);
    expect(out).toMatch(/production/i);
    expect(out).not.toContain('Successfully cleared price history');
  });

  test('refuses a development-shaped target (database name without "test"), even with --yes', () => {
    const result = runScript({
      NODE_ENV: 'development',
      PGHOST: 'localhost',
      PGDATABASE: 'coins_dev_shaped_nonexistent'
    }, ['--yes']);

    const out = outputOf(result);
    expect(result.status).not.toBe(0);
    expect(out).toMatch(/test/i);
    expect(out).not.toContain('Successfully cleared price history');
    expect(out).not.toContain('Error clearing price history'); // never even attempted
  });

  test('refuses a non-local host, even for a *test* database with --yes', () => {
    const result = runScript({
      NODE_ENV: 'test',
      PGHOST: 'db.prod.example.com',
      PGDATABASE: 'coins_test'
    }, ['--yes']);

    const out = outputOf(result);
    expect(result.status).not.toBe(0);
    expect(out).toMatch(/host/i);
    expect(out).not.toContain('Successfully cleared price history');
    expect(out).not.toContain('Error clearing price history'); // never even attempted
  });

  test('refuses a production-shaped DATABASE_URL even when its database contains "test"', () => {
    const result = runScript({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgresql://jd:pw@prod.example.com:5432/coins_test'
    }, ['--yes']);

    const out = outputOf(result);
    expect(result.status).not.toBe(0);
    expect(out).toMatch(/host/i);
    expect(out).not.toContain('Successfully cleared price history');
  });

  test('aborts without explicit confirmation, printing what it would have done', () => {
    const result = runScript({
      NODE_ENV: 'test',
      PGHOST: 'localhost',
      PGDATABASE: 'coins_test_guard_probe_nonexistent'
    });

    const out = outputOf(result);
    expect(result.status).not.toBe(0);
    expect(out).toMatch(/TRUNCATE price_history CASCADE/);
    expect(out).toMatch(/resolved local test database/);
    expect(out).toMatch(/--yes/);
    expect(out).not.toContain('Successfully cleared price history');
    expect(out).not.toContain('Error clearing price history'); // never even attempted
  });

  test('proceeds for a local *test* database with --yes using only the mocked Pool', () => {
    const result = runScript({
      NODE_ENV: 'test',
      PGHOST: 'localhost',
      PGDATABASE: 'coins_test_guard_probe_nonexistent'
    }, ['--yes']);

    const out = outputOf(result);
    expect(result.status).toBe(0);
    expect(out).toContain('MOCK_QUERY TRUNCATE price_history CASCADE');
    expect(out).toContain('MOCK_END');
  });

  test('CONFIRM_CLEAR_PRICE_HISTORY=YES is accepted as confirmation', () => {
    const result = runScript({
      NODE_ENV: 'test',
      PGHOST: 'localhost',
      PGDATABASE: 'coins_test_guard_probe_nonexistent',
      CONFIRM_CLEAR_PRICE_HISTORY: 'YES'
    });

    const out = outputOf(result);
    expect(result.status).toBe(0);
    expect(out).toContain('MOCK_QUERY TRUNCATE price_history CASCADE');
  });
  test.each([
    ['remote URL query host', 'postgresql://u:fixture-secret@localhost/coins_test?host=prod.example.com'],
    ['remote IPv6', 'postgresql://u:fixture-secret@[2001:db8::1]/coins_test'],
    ['socket URL query database override', 'socket:/var/run/postgresql?db=coins_production'],
    ['malformed credential URL', 'postgresql://u:fixture-secret@[invalid/coins_test']
  ])('refuses %s without credentials or Pool construction', (_, url) => {
    const result = runScript({ NODE_ENV: 'test', DATABASE_URL: url }, ['--yes']);
    const out = outputOf(result);
    expect(result.status).toBe(1);
    expect(out).toContain('REFUSING');
    expect(out).not.toContain('MOCK_POOL');
    expect(out).not.toContain('fixture-secret');
    expect(out).not.toContain(url);
  });

  test.each([
    ['IPv6 URL loopback', { DATABASE_URL: 'postgresql://u:fixture-secret@[::1]/coins_test' }, { host: '[::1]', database: 'coins_test' }],
    ['IPv6 PGHOST loopback', { PGHOST: '::1', PGDATABASE: 'coins_test' }, { host: '::1', database: 'coins_test' }],
    ['query host overrides remote authority', { DATABASE_URL: 'postgresql://u:fixture-secret@prod.example.com/coins_test?host=127.0.0.1&database=coins_production' }, { host: '127.0.0.1', database: 'coins_test' }],
    ['socket URL database override', { DATABASE_URL: 'socket:/var/run/postgresql?db=coins_test' }, { host: '/var/run/postgresql', database: 'coins_test' }]
  ])('uses pg exact target for %s', (_, env, target) => {
    const result = runScript({ NODE_ENV: 'test', ...env }, ['--yes']);
    const out = outputOf(result);
    expect(result.status).toBe(0);
    expect(out).toContain(`MOCK_POOL_TARGET ${JSON.stringify(target)}`);
    expect(out).toContain('MOCK_QUERY TRUNCATE');
    expect(out).not.toContain('fixture-secret');
  });

  test.each([
    'PGHOST=prod.example.com\nPGDATABASE=coins_test\n',
    'DATABASE_URL=postgresql://u:fixture-secret@localhost/coins_test?host=prod.example.com\n',
    'PGHOST=localhost\nPGDATABASE=coins_production\n'
  ])('dotenv-loaded unsafe target refuses before Pool creation (%s)', (dotenv) => {
    const result = runScript({ NODE_ENV: 'development' }, ['--yes'], dotenv);
    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('REFUSING');
    expect(outputOf(result)).not.toContain('MOCK_POOL');
    expect(outputOf(result)).not.toContain('fixture-secret');
  });

  test('dotenv-loaded local test target is the exact target passed to Pool', () => {
    const result = runScript({ NODE_ENV: 'development' }, ['--yes'], 'PGHOST=localhost\nPGDATABASE=coins_test\n');
    expect(result.status).toBe(0);
    expect(outputOf(result)).toContain('MOCK_POOL_TARGET {"host":"localhost","database":"coins_test"}');
  });
  test('production NODE_ENV loaded from default dotenv is refused', () => {
    const result = runScript({ NODE_ENV: undefined }, ['--yes'], 'NODE_ENV=production\nPGHOST=localhost\nPGDATABASE=coins_test\n');
    expect(result.status).toBe(1);
    expect(outputOf(result)).toContain('NODE_ENV=production');
    expect(outputOf(result)).not.toContain('MOCK_POOL');
  });
});
