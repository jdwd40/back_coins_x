// Barrier-synchronised race worker for the multi-process game-cycle tests.
//
// Usage: node __tests__/helpers/raceWorker.js <barrierEpochMs> <effectiveNowEpochMs>
//
// The worker sleeps until the shared barrier instant, then calls
// reconcileCycle exactly once and prints the resulting row as a single JSON
// line on stdout. Because every spawned worker is held until the same barrier,
// their reconcile calls genuinely collide on the database advisory lock
// instead of drifting in over time.
//
// Optional env RACE_WORKER_CYCLE_SEED: when set (non-empty), a cycle this
// worker creates is seeded with that explicit value instead of a random
// one. Fixture-only control (the value travels with the test process env,
// never production config): it lets a race test pin a documented
// deterministic seed whose collapse rolls are known-safe for the scenario
// under test. Creation semantics are unchanged — the seed is still chosen
// by the server-side generator at insert time, only its value is pinned.

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

// Fixture-only explicit cycle seed (see header). Validated here so a
// misconfigured harness fails loudly instead of falling back to a random
// seed and silently reintroducing nondeterminism.
const explicitSeed = process.env.RACE_WORKER_CYCLE_SEED;
if (explicitSeed !== undefined && explicitSeed.length === 0) {
  console.error('raceWorker: RACE_WORKER_CYCLE_SEED must be non-empty when set');
  process.exit(2);
}
const reconcileOptions = { now: new Date(nowMs) };
if (explicitSeed !== undefined) {
  reconcileOptions.generateSeed = () => explicitSeed;
}

setTimeout(() => {
  reconcileCycle(reconcileOptions)
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
