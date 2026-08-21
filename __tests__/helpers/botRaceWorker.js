// Barrier-synchronised race worker for the Core 5 multi-process bot tests.
//
// Usage: node __tests__/helpers/botRaceWorker.js <mode> <barrierEpochMs> <payloadJson>
//   mode: tick | reconcile
//   payloadJson: { tickId, nowMs }
//
// The worker sleeps until the shared barrier instant, then executes exactly
// one operation and prints a single JSON line on stdout:
//   { ok: true, result: ... }   — operation completed (executed OR skipped)
// Unexpected errors exit non-zero. Because every spawned worker is held until
// the same barrier, their tick claims genuinely collide on the database
// unique constraint instead of drifting in over time.

const path = require('path');
const { assertDisposableTestDatabase } = require('./testDatabaseGuard');

// Never let a race worker touch anything but the approved disposable test DB.
assertDisposableTestDatabase();

const projectRoot = path.resolve(__dirname, '..', '..');
const db = require(path.join(projectRoot, 'db', 'connection'));
const botService = require(path.join(projectRoot, 'game', 'botService'));
const { reconcileCycle } = require(path.join(projectRoot, 'game', 'gameCycleService'));

const mode = process.argv[2];
const barrierMs = Number(process.argv[3]);
const payload = JSON.parse(process.argv[4] || '{}');
const now = payload.nowMs ? new Date(payload.nowMs) : new Date();

if (!['tick', 'reconcile'].includes(mode) || !Number.isFinite(barrierMs)) {
  console.error('botRaceWorker: mode (tick|reconcile) and barrier epoch ms are required');
  process.exit(2);
}

function run() {
  switch (mode) {
    case 'tick':
      return botService.runBotTick({ tickId: payload.tickId, now });
    case 'reconcile':
      return reconcileCycle({ now });
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
      console.error(`botRaceWorker: ${err && err.message}`);
      try { await db.end(); } catch (_) { /* already ending */ }
      process.exit(1);
    });
}, delay);
