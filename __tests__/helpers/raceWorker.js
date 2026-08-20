// Barrier-synchronised race worker for the multi-process game-cycle tests.
//
// Usage: node __tests__/helpers/raceWorker.js <barrierEpochMs> <effectiveNowEpochMs>
//
// The worker sleeps until the shared barrier instant, then calls
// reconcileCycle exactly once and prints the resulting row as a single JSON
// line on stdout. Because every spawned worker is held until the same barrier,
// their reconcile calls genuinely collide on the database advisory lock
// instead of drifting in over time.

const path = require('path');
const { assertDisposableTestDatabase } = require('./testDatabaseGuard');

// Never let a race worker touch anything but the approved disposable test DB.
assertDisposableTestDatabase();

const projectRoot = path.resolve(__dirname, '..', '..');
const { reconcileCycle } = require(path.join(projectRoot, 'game', 'gameCycleService'));
const db = require(path.join(projectRoot, 'db', 'connection'));

const barrierMs = Number(process.argv[2]);
const nowMs = Number(process.argv[3] || process.argv[2]);

if (!Number.isFinite(barrierMs) || !Number.isFinite(nowMs)) {
  console.error('raceWorker: barrier and effective-now epoch ms arguments are required');
  process.exit(2);
}

const delay = Math.max(0, barrierMs - Date.now());
setTimeout(() => {
  reconcileCycle({ now: new Date(nowMs) })
    .then(async (cycle) => {
      process.stdout.write(JSON.stringify(cycle) + '\n');
      await db.end();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`raceWorker: ${err.message}`);
      try { await db.end(); } catch (_) { /* already ending */ }
      process.exit(1);
    });
}, delay);
