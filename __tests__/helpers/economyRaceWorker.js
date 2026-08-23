// Barrier-synchronised race worker for the issue #18 economy multi-process
// tests (same contract as roundRaceWorker.js).
//
// Usage: node __tests__/helpers/economyRaceWorker.js <mode> <barrierEpochMs> <payloadJson>
//   mode: pass | buy
//   payloadJson: { nowMs, userId, apocalypseId, coinId, quantity }
//
// The worker sleeps until the shared barrier instant, then executes exactly
// one operation and prints a single JSON line on stdout:
//   { ok: true, result: ... }                  — operation committed
//   { ok: false, status, message }             — expected domain rejection
// Unexpected (non-domain) errors exit non-zero. Domain rejections are a
// legitimate race outcome, so they still exit 0 and let the parent assert.
// Because every spawned worker is held until the same barrier, their
// operations genuinely collide on the database advisory lock instead of
// drifting in over time.

const path = require('path');
const { assertDisposableTestDatabase } = require('./testDatabaseGuard');

// Never let a race worker touch anything but the approved disposable test DB.
assertDisposableTestDatabase();

const projectRoot = path.resolve(__dirname, '..', '..');
const db = require(path.join(projectRoot, 'db', 'connection'));
const gameRoundService = require(path.join(projectRoot, 'game', 'gameRoundService'));
const economyService = require(path.join(projectRoot, 'game', 'economyService'));

const mode = process.argv[2];
const barrierMs = Number(process.argv[3]);
const payload = JSON.parse(process.argv[4] || '{}');
const now = payload.nowMs ? new Date(payload.nowMs) : new Date();

if (!['pass', 'buy'].includes(mode) || !Number.isFinite(barrierMs)) {
  console.error('economyRaceWorker: mode (pass|buy) and barrier epoch ms are required');
  process.exit(2);
}

function run() {
  switch (mode) {
    case 'pass':
      return economyService.runEconomyPass({ now });
    case 'buy':
      return gameRoundService.buyRoundTrade({
        userId: payload.userId,
        apocalypseId: payload.apocalypseId,
        coinId: payload.coinId,
        quantity: payload.quantity,
        now
      });
    default:
      throw new Error(`unknown mode ${mode}`);
  }
}

const delay = Math.max(0, barrierMs - Date.now());
setTimeout(() => {
  run()
    .then(async (result) => {
      process.stdout.write(JSON.stringify({ ok: true, result }) + '\n');
      await db.end();
      process.exit(0);
    })
    .catch(async (err) => {
      if (err && (err.name === 'GameRoundError' || err.name === 'GameEconomyError')) {
        process.stdout.write(JSON.stringify({ ok: false, status: err.status, message: err.message }) + '\n');
        try { await db.end(); } catch (_) { /* already ending */ }
        process.exit(0);
      }
      console.error(`economyRaceWorker: ${err && err.message}`);
      try { await db.end(); } catch (_) { /* already ending */ }
      process.exit(1);
    });
}, delay);
