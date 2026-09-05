// Lifecycle coverage for the server bootstrap: no import-time side effects,
// explicit start, idempotent graceful shutdown, drained resources, and real
// signal handling in a separately spawned process.

const path = require('path');
const { spawn } = require('child_process');
const db = require('../db/connection');
const gameCycleWorker = require('../game/gameCycleWorker');
const botWorker = require('../game/botWorker');
const economyWorker = require('../game/economyWorker');
const persistentBotWorker = require('../game/persistentBotWorker');
const persistentReplacementWorker = require('../game/persistentReplacementWorker');
const marketSimulator = require('../models/market-simulator');
const { assertDisposableTestDatabase } = require('./helpers/testDatabaseGuard');

const PROJECT_ROOT = path.resolve(__dirname, '..');

jest.setTimeout(30000);

describe('Core 1: server lifecycle', () => {
  afterEach(() => {
    gameCycleWorker.stop();
    persistentReplacementWorker.stop();
  });

  test('importing server.js starts no listener, worker, or timer', () => {
    jest.isolateModules(() => {
      jest.doMock('../models/market-simulator', () => ({ start: jest.fn(), stop: jest.fn() }));
      const serverModule = require('../server');
      expect(serverModule.startServer).toBeInstanceOf(Function);
      expect(serverModule.shutdown).toBeInstanceOf(Function);
    });
    expect(gameCycleWorker.isRunning()).toBe(false);
    expect(persistentReplacementWorker.isRunning()).toBe(false);
    jest.dontMock('../models/market-simulator');
  });

  test('shutdown stops the worker, closes the HTTP server, drains the pool and is idempotent', async () => {
    assertDisposableTestDatabase();

    const serverModule = require('../server');
    const server = await serverModule.startServer(0);
    expect(server.listening).toBe(true);

    // Simulate running production workers; shutdown must stop them.
    gameCycleWorker.start();
    persistentReplacementWorker.start();
    expect(gameCycleWorker.isRunning()).toBe(true);
    expect(persistentReplacementWorker.isRunning()).toBe(true);

    // Observe pool draining without actually ending the suite-shared pool
    // (jest.setup.js reseeds via the same pool before later tests).
    const endSpy = jest.spyOn(db, 'end').mockResolvedValue(undefined);

    const first = serverModule.shutdown('SIGTERM');
    const second = serverModule.shutdown('SIGTERM');
    expect(second).toBe(first); // repeated signals reuse the same shutdown

    await first;
    expect(gameCycleWorker.isRunning()).toBe(false);
    expect(persistentReplacementWorker.isRunning()).toBe(false);
    expect(server.listening).toBe(false);
    expect(endSpy).toHaveBeenCalledTimes(1); // drained exactly once
  });

  test('spawned production server exits 0 on SIGTERM, repeated signals included', async () => {
    assertDisposableTestDatabase();

    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      JWT_SECRET: 'test-secret-key',
      PGHOST: process.env.PGHOST,
      PGDATABASE: process.env.PGDATABASE,
      PGUSER: process.env.PGUSER,
      PGPORT: process.env.PGPORT,
      // Pass the resolved test password through: the spawned production-mode
      // child loads .env.production (absent locally), so without this the
      // local SCRAM-hardened PostgreSQL rejects the connection.
      PGPASSWORD: process.env.PGPASSWORD || '',
      PORT: '0'
    };

    const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT_ROOT, env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    // Wait for the listener to report readiness before signalling.
    const startedAt = Date.now();
    while (!stdout.includes('Ready to accept connections')) {
      if (Date.now() - startedAt > 15000) {
        child.kill('SIGKILL');
        throw new Error(`server did not become ready. stdout:\n${stdout}\nstderr:\n${stderr}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    child.kill('SIGTERM');
    // A repeated signal during shutdown must not re-run or corrupt shutdown.
    setTimeout(() => { try { child.kill('SIGTERM'); } catch (_) { /* already gone */ } }, 150);

    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, timedOut: true });
      }, 15000);
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, timedOut: false });
      });
    });

    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
    expect(stdout).toContain('SIGTERM received');
    expect(stdout).toContain('Shutdown complete');
  });

  test('spawned production server exits 0 on SIGINT', async () => {
    assertDisposableTestDatabase();

    const env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: 'production',
      JWT_SECRET: 'test-secret-key',
      PGHOST: process.env.PGHOST,
      PGDATABASE: process.env.PGDATABASE,
      PGUSER: process.env.PGUSER,
      PGPORT: process.env.PGPORT,
      PGPASSWORD: process.env.PGPASSWORD || '',
      PORT: '0'
    };

    const child = spawn(process.execPath, ['server.js'], { cwd: PROJECT_ROOT, env });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });

    const startedAt = Date.now();
    while (!stdout.includes('Ready to accept connections')) {
      if (Date.now() - startedAt > 15000) {
        child.kill('SIGKILL');
        throw new Error(`server did not become ready. stdout:\n${stdout}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    child.kill('SIGINT');
    const exit = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve({ code: null, timedOut: true });
      }, 15000);
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code, timedOut: false });
      });
    });

    expect(exit.timedOut).toBe(false);
    expect(exit.code).toBe(0);
    expect(stdout).toContain('SIGINT received');
    expect(stdout).toContain('Shutdown complete');
  });

  test('E. production startup calls only persistent workers + market writer (no legacy trio); shutdown safe (lifecycle observation via mocks)', async () => {
    assertDisposableTestDatabase();

    const origEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';

    const gameCycleStart = jest.fn();
    const botStart = jest.fn();
    const economyStart = jest.fn();
    const pBotStart = jest.fn();
    const pReplStart = jest.fn();
    const mktStart = jest.fn();

    let serverModule;
    jest.isolateModules(() => {
      jest.doMock('../game/gameCycleWorker', () => ({
        start: gameCycleStart,
        stop: jest.fn(),
        isRunning: jest.fn(() => false)
      }));
      jest.doMock('../game/botWorker', () => ({
        start: botStart,
        stop: jest.fn(),
        isRunning: jest.fn(() => false)
      }));
      jest.doMock('../game/economyWorker', () => ({
        start: economyStart,
        stop: jest.fn(),
        isRunning: jest.fn(() => false)
      }));
      jest.doMock('../game/persistentBotWorker', () => ({
        start: pBotStart,
        stop: jest.fn(),
        isRunning: jest.fn(() => false)
      }));
      jest.doMock('../game/persistentReplacementWorker', () => ({
        start: pReplStart,
        stop: jest.fn(),
        isRunning: jest.fn(() => false)
      }));
      jest.doMock('../models/market-simulator', () => ({
        start: mktStart,
        stop: jest.fn(),
        lastBatch: null,
        getMarketStatus: jest.fn(() => ({})),
        getMarketStats: jest.fn(() => ({}))
      }));

      serverModule = require('../server');
    });

    // Calling startServer triggers app load (market start at top level if prod) and listen cb (persistent starts)
    const httpServer = await serverModule.startServer(0);
    // allow listen callback to fire
    await new Promise((r) => setImmediate(r));

    // Per E: gameCycle, bot, economy NOT called; persistentBot, persistentReplacement, and market writer ARE
    expect(gameCycleStart).not.toHaveBeenCalled();
    expect(botStart).not.toHaveBeenCalled();
    expect(economyStart).not.toHaveBeenCalled();
    expect(pBotStart).toHaveBeenCalled();
    expect(pReplStart).toHaveBeenCalled();
    expect(mktStart).toHaveBeenCalled();

    // shutdown safe under new policy (no-ops for unstarted legacy are fine)
    await serverModule.shutdown('SIGTERM');
    expect(httpServer.listening).toBe(false);

    process.env.NODE_ENV = origEnv;
    jest.dontMock('../game/gameCycleWorker');
    jest.dontMock('../game/botWorker');
    jest.dontMock('../game/economyWorker');
    jest.dontMock('../game/persistentBotWorker');
    jest.dontMock('../game/persistentReplacementWorker');
    jest.dontMock('../models/market-simulator');
  });
});
