// Persistent-market Stage 1: the long-horizon checkpoint harness.
//
// Runs the deterministic pricing engine over world ages no 30-minute round
// ever reaches (default 365 simulated days) using ONLY the production
// checkpoint machinery (game/pricingCheckpoint.js over game/marketDomain.js
// + game/priceEngine.js): every step resumes from the accumulator frozen at
// the previous step and freezes the next one — the exact pattern the live
// writer uses per batch, so this is the simulation threading of the Stage 1
// production path.
//
// What it proves:
//   * no world-age, timeline-guard (marketDomain.MAX_TIMELINE_CYCLES) or
//     crash-horizon (priceEngine.MAX_CRASH_EPISODES) failure at any step;
//   * every price stays finite and strictly positive (no runaway numerical
//     behaviour over the horizon);
//   * bit-identity: at every within-guard cross-check instant the
//     chained-checkpoint price equals the stateless origin engine price
//     (Object.is), and the un-checkpointed origin walk provably fails the
//     horizon the checkpoints survive.
//
// Usage: node simulation/checkpointHorizon.js [--days N] [--cadence-minutes M]
//        [--seed S] [--cross-check-day D]
// Exits non-zero on any failure. Nothing here touches a database, a real
// clock, or Math.random(): time is injected, exactly like simulation/.

const pricingCheckpoint = require('../game/pricingCheckpoint');
const priceEngine = require('../game/priceEngine');

// The canonical active catalogue (mirrors simulation/roundEnvironment.js).
const CANONICAL_COINS = [
  { coinId: 1, symbol: 'FTR', baselinePrice: 0.10 },
  { coinId: 2, symbol: 'NVC', baselinePrice: 1.37 },
  { coinId: 3, symbol: 'BYT', baselinePrice: 0.12 },
  { coinId: 4, symbol: 'DGV', baselinePrice: 0.10 },
  { coinId: 5, symbol: 'CYB', baselinePrice: 96.45 },
  { coinId: 6, symbol: 'BLN', baselinePrice: 43.46 },
  { coinId: 7, symbol: 'STF', baselinePrice: 3.91 },
  { coinId: 8, symbol: 'JDC', baselinePrice: 33.48 },
  { coinId: 9, symbol: 'MTC', baselinePrice: 0.10 },
  { coinId: 10, symbol: 'CZN', baselinePrice: 32.00 }
];

const DAY_MS = 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const args = { days: 365, cadenceMinutes: 30, seed: 'stage1-horizon-seed', crossCheckDay: 6 };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days') args.days = Number(argv[++i]);
    else if (argv[i] === '--cadence-minutes') args.cadenceMinutes = Number(argv[++i]);
    else if (argv[i] === '--seed') args.seed = argv[++i];
    else if (argv[i] === '--cross-check-day') args.crossCheckDay = Number(argv[++i]);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  for (const [name, value] of Object.entries(args)) {
    if (name === 'seed') continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new Error(`checkpoint horizon ${name} must be a positive number; received ${String(value)}`);
    }
  }
  return args;
}

// Run the horizon. lifecycleState pins the crash/rally gating context for
// the whole run (COLLAPSE activates the most episodes — the maximal stress
// for the accumulator). Returns a summary; throws on any failure.
function runCheckpointHorizon({ days = 365, cadenceMinutes = 30, seed = 'stage1-horizon-seed', crossCheckDay = 6, lifecycleState = 'COLLAPSE', coins = CANONICAL_COINS, log = () => {} } = {}) {
  const cadenceMs = cadenceMinutes * 60 * 1000;
  const steps = Math.floor((days * DAY_MS) / cadenceMs);
  if (steps < 1) {
    throw new Error(`checkpoint horizon needs at least one step (days=${days}, cadenceMinutes=${cadenceMinutes})`);
  }
  const crossCheckMs = crossCheckDay * DAY_MS;
  const baselineByCoin = new Map(coins.map((c) => [c.coinId, c.baselinePrice]));

  const summary = {
    seed,
    days,
    cadenceMinutes,
    lifecycleState,
    steps,
    coins: coins.length,
    perCoin: []
  };

  for (const coin of coins) {
    let stored = null;
    let minPrice = Infinity;
    let maxPrice = 0;
    let crossChecked = false;
    for (let s = 1; s <= steps; s++) {
      const tMs = s * cadenceMs;
      stored = pricingCheckpoint.extractPricingCheckpoint({
        seed, coinId: coin.coinId, roundStartMs: 0, nowMs: tMs, lifecycleState, stored
      });
      const resume = pricingCheckpoint.resolveResumeCheckpoints({
        stored, seed, coinId: coin.coinId, nowMs: tMs, lifecycleState
      });
      const price = priceEngine.unifiedPriceAt({
        seed, coinId: coin.coinId, baselinePrice: baselineByCoin.get(coin.coinId),
        roundStartMs: 0, nowMs: tMs, amplitude: 1, lifecycleState, cycleProgress: 0,
        domainCheckpoint: resume.domainCheckpoint,
        crashCheckpoint: resume.crashCheckpoint
      });
      if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`checkpoint horizon: coin ${coin.coinId} produced invalid price ${String(price)} at step ${s} (day ${(tMs / DAY_MS).toFixed(2)})`);
      }
      if (price < minPrice) minPrice = price;
      if (price > maxPrice) maxPrice = price;

      // Bit-identity cross-check against the stateless origin engine at a
      // within-guard instant (the origin walk can still reach it).
      if (!crossChecked && tMs >= crossCheckMs) {
        const origin = priceEngine.unifiedPriceAt({
          seed, coinId: coin.coinId, baselinePrice: baselineByCoin.get(coin.coinId),
          roundStartMs: 0, nowMs: tMs, amplitude: 1, lifecycleState, cycleProgress: 0
        });
        if (!Object.is(price, origin)) {
          throw new Error(`checkpoint horizon: coin ${coin.coinId} diverged from the origin engine at day ${(tMs / DAY_MS).toFixed(2)} (${price} vs ${origin})`);
        }
        crossChecked = true;
      }
    }
    if (!crossChecked) {
      throw new Error(`checkpoint horizon: coin ${coin.coinId} never reached the cross-check day ${crossCheckDay}`);
    }
    summary.perCoin.push({
      coinId: coin.coinId,
      symbol: coin.symbol,
      finalEpisodeIndex: stored.crashEpisodeIndex,
      finalDomainCycleIndex: stored.domainCycleIndex,
      minPrice,
      maxPrice,
      crossCheckedAtDay: crossCheckDay
    });
    log(`coin ${coin.symbol} (${coin.coinId}): ${steps} steps OK, episodes=${stored.crashEpisodeIndex}, cycles=${stored.domainCycleIndex}, price range [${minPrice}, ${maxPrice}]`);
  }

  // Load-bearing proof: the un-checkpointed origin walk FAILS inside this
  // horizon (the fastest coin's market-cycle chain exceeds the timeline
  // guard), so the harness's completion is attributable to checkpoints.
  const fastest = coins[0];
  let originFailed = false;
  try {
    priceEngine.unifiedPriceAt({
      seed, coinId: fastest.coinId, baselinePrice: baselineByCoin.get(fastest.coinId),
      roundStartMs: 0, nowMs: days * DAY_MS, amplitude: 1, lifecycleState, cycleProgress: 0
    });
  } catch (err) {
    originFailed = true;
    summary.originWalkFailure = err.message;
  }
  if (!originFailed) {
    throw new Error(`checkpoint horizon: the origin walk unexpectedly survived ${days} days for coin ${fastest.coinId}; the harness is not proving the checkpoint path is load-bearing`);
  }

  return summary;
}

if (require.main === module) {
  const args = parseArgs(process.argv);
  const startedAt = Date.now();
  try {
    const summary = runCheckpointHorizon({ ...args, log: console.log });
    console.log(`origin walk at +${args.days}d failed as expected: ${summary.originWalkFailure}`);
    console.log(`CHECKPOINT HORIZON PASS: ${summary.coins} coins x ${summary.steps} steps (${args.days} simulated days at ${args.cadenceMinutes}-minute cadence) in ${Date.now() - startedAt}ms`);
  } catch (err) {
    console.error(`CHECKPOINT HORIZON FAIL: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { runCheckpointHorizon, CANONICAL_COINS };
