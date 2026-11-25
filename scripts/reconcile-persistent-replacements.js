// One-shot operational reconciliation used by the deployment gate.
// It uses the same idempotent transaction as the worker, then exits so the
// normal schema verifier sees a repaired catalogue rather than masking it.
const db = require('../db/connection');
const { reconcilePersistentReplacements } = require('../game/persistentReplacementRuntime');

(async () => {
  try {
    const result = await reconcilePersistentReplacements();
    console.log(JSON.stringify({
      stateReady: result.stateReady,
      retired: result.retiredCoinIds.length,
      inserted: result.inserted.length,
      activeAfter: result.activeAfter,
      pendingEligibleDeaths: result.pendingEligibleDeathsAfter,
      reserveRemaining: result.reserveRemaining,
      reserveExhausted: result.reserveExhausted
    }));
  } finally {
    await db.end();
  }
})().catch((error) => {
  console.error(`persistent replacement reconciliation failed: ${error.message}`);
  process.exitCode = 1;
});
