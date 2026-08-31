// Deterministic seed search for the collapse-race cold-start fixture.
//
// Usage: NODE_ENV=test node __tests__/helpers/findCollapseRaceSeed.js
//
// The cold-start race (collapse-race.test.js) creates its cycle with an
// explicit, documented seed instead of an uncontrolled generated one: the
// dynamic collapse engine legitimately evaluates the exact cycle-start
// bucket, and a random seed can land a per-(coin, bucket) roll under a
// coin's effective risk, killing coins during a test that verifies
// exactly-once cold-start cycle creation. This script finds — and lets
// anyone re-verify — a seed that can produce no such death.
//
// Safety criterion: the cold-start fixture evaluates the cycle-start
// bucket with the market in its opening GROWTH state (the race's
// effective-now is pinned to just after the aligned cycle boundary, so no
// racing reconcile can advance the hidden lifecycle before evaluating).
// In GROWTH/PLATEAU the engine caps per-evaluation risk at config
// dynamicCollapse.preDeclineRiskCap regardless of every other input, and a
// coin dies only when its seeded roll is strictly below its risk. A seed
// whose minimum roll across every seeded coin and every evaluation bucket
// of a fresh 30-minute cycle is >= that cap therefore produces zero deaths
// at ANY point of a fresh pre-decline cycle — the start bucket included.
//
// The search is deterministic: candidates are drawn from the fixed
// sequence `${CANDIDATE_PREFIX}<n>` (n = 0, 1, 2, ...) and the first
// candidate meeting the criterion wins, so re-running against the same
// disposable seed data always returns the same seed.

const path = require('path');
const projectRoot = path.resolve(__dirname, '..', '..');

// Load the same env file db/connection.js resolves for NODE_ENV=test so the
// guard below sees the same target the search will read.
require('dotenv').config({ path: path.join(projectRoot, `.env.${process.env.NODE_ENV || 'development'}`) });

const { assertDisposableTestDatabase } = require('./testDatabaseGuard');

// This tooling only ever reads the coin set of the approved disposable
// test database; refuse anything else, exactly like the race workers.
assertDisposableTestDatabase();

const db = require(path.join(projectRoot, 'db', 'connection'));
const { drawCollapseRoll, COLLAPSE_EVALUATION_BUCKET_MS } = require(path.join(projectRoot, 'game', 'dynamicCollapseService'));
const { DEFAULT_GAME_CYCLE_DURATION_MS } = require(path.join(projectRoot, 'game', 'gameCycleService'));
const { resolveSimulationConfig } = require(path.join(projectRoot, 'game', 'simulationConfig'));

const CANDIDATE_PREFIX = 'collapse-race-safe-seed-';
// Every bucket of a fresh default-duration cycle, plus margin so the seed
// stays safe even if the race's effective-now drifts across a few bucket
// boundaries in a future edit of the fixture.
const BUCKET_COUNT = Math.ceil(DEFAULT_GAME_CYCLE_DURATION_MS / COLLAPSE_EVALUATION_BUCKET_MS) + 4;
const MAX_CANDIDATES = 100000;

async function main() {
  const { rows } = await db.query('SELECT coin_id FROM coins WHERE retired = FALSE ORDER BY coin_id');
  const coinIds = rows.map((r) => r.coin_id);
  if (coinIds.length === 0) {
    throw new Error('findCollapseRaceSeed: no coins in the disposable test database — run the seed first');
  }
  const riskCap = resolveSimulationConfig().dynamicCollapse.preDeclineRiskCap;

  for (let n = 0; n < MAX_CANDIDATES; n++) {
    const candidate = `${CANDIDATE_PREFIX}${n}`;
    let minRoll = 1;
    for (const coinId of coinIds) {
      for (let bucket = 0; bucket < BUCKET_COUNT; bucket++) {
        const roll = drawCollapseRoll({ seed: candidate, coinId, bucketIndex: bucket });
        if (roll < minRoll) minRoll = roll;
        if (minRoll < riskCap) break;
      }
      if (minRoll < riskCap) break;
    }
    if (minRoll >= riskCap) {
      console.log(JSON.stringify({
        seed: candidate,
        minRoll,
        preDeclineRiskCap: riskCap,
        coinIds,
        bucketsCovered: BUCKET_COUNT
      }));
      return;
    }
  }
  throw new Error(`findCollapseRaceSeed: no safe seed found in ${MAX_CANDIDATES} candidates`);
}

main()
  .catch((err) => { console.error(`findCollapseRaceSeed: ${err.message}`); process.exitCode = 1; })
  .finally(() => db.end());
