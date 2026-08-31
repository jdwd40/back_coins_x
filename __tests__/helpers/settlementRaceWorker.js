// Barrier-synchronised race worker for the Core 6 multi-process settlement
// tests.
//
// Usage: node __tests__/helpers/settlementRaceWorker.js <mode> <barrierEpochMs> <payloadJson>
//   mode: buy | sell | freeze | settle | reconcile
//   payloadJson: { userId, apocalypseId, coinId, quantity, nowMs, cycleSeed }
//
// Fixture-only `cycleSeed` (reconcile mode): when present, a cycle this
// worker creates is seeded with that explicit value via the existing
// reconcileCycle `generateSeed` injection point instead of an uncontrolled
// generated one. It lets a race test pin a documented deterministic seed
// whose collapse rolls are known-safe for the scenario under test (see
// __tests__/helpers/findCollapseRaceSeed.js). Creation semantics are
// unchanged — the seed is still chosen server-side at insert time, only
// its value is pinned. Validated here so a misconfigured harness fails
// loudly instead of silently reintroducing nondeterminism.
//
// The worker sleeps until the shared barrier instant, then executes exactly
// one operation and prints a single JSON line on stdout:
//   { ok: true, result: ... }                  — operation committed
//   { ok: false, status, message }             — expected domain rejection
// Unexpected (non-domain) errors exit non-zero. Domain rejections are a
// legitimate race outcome (a trade that loses the race to the freeze), so
// they still exit 0 and let the parent assert. Because every spawned worker
// is held until the same barrier, their operations genuinely collide on the
// database advisory lock instead of drifting in over time.

const path = require('path');
const { assertDisposableTestDatabase } = require('./testDatabaseGuard');

// Never let a race worker touch anything but the approved disposable test DB.
assertDisposableTestDatabase();

const projectRoot = path.resolve(__dirname, '..', '..');
const db = require(path.join(projectRoot, 'db', 'connection'));
const gameRoundService = require(path.join(projectRoot, 'game', 'gameRoundService'));
const settlementService = require(path.join(projectRoot, 'game', 'gameSettlementService'));
const { reconcileCycle } = require(path.join(projectRoot, 'game', 'gameCycleService'));

const mode = process.argv[2];
const barrierMs = Number(process.argv[3]);
const payload = JSON.parse(process.argv[4] || '{}');
const now = payload.nowMs ? new Date(payload.nowMs) : new Date();

if (!['buy', 'sell', 'freeze', 'settle', 'reconcile'].includes(mode) || !Number.isFinite(barrierMs)) {
  console.error('settlementRaceWorker: mode (buy|sell|freeze|settle|reconcile) and barrier epoch ms are required');
  process.exit(2);
}
if (payload.cycleSeed !== undefined && (typeof payload.cycleSeed !== 'string' || payload.cycleSeed.length === 0)) {
  console.error('settlementRaceWorker: cycleSeed must be a non-empty string when set');
  process.exit(2);
}

function reconcileOptions() {
  const options = { now, durationMs: payload.durationMs };
  if (payload.cycleSeed !== undefined) {
    options.generateSeed = () => payload.cycleSeed;
  }
  return options;
}

function run() {
  switch (mode) {
    case 'buy':
      return gameRoundService.buyRoundTrade({
        userId: payload.userId,
        apocalypseId: payload.apocalypseId,
        coinId: payload.coinId,
        quantity: payload.quantity,
        now
      });
    case 'sell':
      return gameRoundService.sellRoundTrade({
        userId: payload.userId,
        apocalypseId: payload.apocalypseId,
        coinId: payload.coinId,
        quantity: payload.quantity,
        now
      });
    case 'freeze':
      return settlementService.freezeExpiredActiveCycle({ nowMs: now.getTime() });
    case 'settle':
      return settlementService.settleSettlingCycle();
    case 'reconcile':
      return reconcileCycle(reconcileOptions());
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
      if (err && (err.name === 'GameRoundError' || err.name === 'GameResultsError')) {
        process.stdout.write(JSON.stringify({ ok: false, status: err.status, message: err.message }) + '\n');
        try { await db.end(); } catch (_) { /* already ending */ }
        process.exit(0);
      }
      console.error(`settlementRaceWorker: ${err && err.message}`);
      try { await db.end(); } catch (_) { /* already ending */ }
      process.exit(1);
    });
}, delay);
