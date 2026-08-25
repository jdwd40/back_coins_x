// Crypto Chaos V2-1: the shared deterministic cyclical market domain.
//
// This module is the SINGLE source of truth for gameplay market prices. The
// live market writer (models/market-simulator.js) and the headless
// accelerated simulator (simulation/) both call these exact functions —
// there is no second/fake pricing implementation anywhere.
//
// Design:
//   * Every coin's price is a pure function of:
//       - the apocalypse cycle's persisted Core 1 seed
//       - the coin's archetype (gameplay roster below) and its persisted
//         cycle_baseline_price (the Core 3 restoration baseline)
//       - the apocalypse cycle's persisted start/end window
//       - authoritative time (real clock live, injected clock in simulation)
//       - an amplitude multiplier (Core 2 apocalypse volatility factor)
//     Nothing is held in memory, so a process restart reproduces identical
//     prices from persisted state alone. Math.random() is never used; the
//     deterministic stream is the same SHA-256 counter-mode convention as
//     Core 3 (createSeededRandom), namespaced per coin + market cycle.
//   * Each coin walks repeated market cycles DIP -> RISE -> BOOM -> FALL.
//     Every generated cycle varies: phase durations, dip depth, rise
//     strength, boom height/decay, fall depth, transition shape, bounded
//     short-term noise, and a drifting underlying anchor. Anchor drift means
//     a missed peak is NOT automatically rescued by the next boom — the next
//     cycle's peak can sit below the previous one. Learnable, not solvable.
//   * Coins are staggered: each coin's market clock starts at a seeded
//     offset into its first cycle, and cycle durations differ per coin, so
//     the active market normally contains varied opportunities rather than
//     every coin sharing one phase.
//   * Collapsed coins are NOT this module's concern: Core 3 owns death. The
//     market writer excludes collapsed coins entirely; domain prices for
//     live coins are always finite and strictly positive.
//
// Public-signal policy (getPublicCoinSignal): players may see the current
// price, recent movement, the COARSE current phase (no timing information),
// momentum direction, the coin's archetype and its approximate typical
// cycle/swing ranges, and (via the caller) dead state. The seed, exact
// cycle durations, anchors, phase boundaries, future phases, future peaks
// and any timestamp of a future transition are never exposed.

const { createSeededRandom } = require('./seededRandom');

// ---------------------------------------------------------------------------
// Price precision (migration 017): gameplay prices persist at 4 decimal
// places so sub-£1 coins can express 4-8% archetype swings (at 2dp a £0.10
// coin can only move in 10% steps). Money stays at 2dp everywhere else.
// ---------------------------------------------------------------------------
const GAME_PRICE_DECIMALS = 4;
// Strictly-positive floor for any live price, before and after rounding.
// Far below any real price; only guards against pathological float drift.
const MIN_POSITIVE_PRICE = 0.0001;

// ---------------------------------------------------------------------------
// Archetypes: initial V2-1 balance parameters (GAMEPLAY_V2_NIGHT_PLAN.md).
//   cycleMs: market-cycle duration range (DIP->FALL)
//   swing:   typical total oscillation amplitude (fraction of anchor)
//   drift:   max per-cycle anchor drift fraction (regime movement between
//            cycles — higher means less reliably "rescued" by the next boom)
//   noise:   max bounded short-term noise fraction
// RUG is deliberately irregular: the widest duration range, the widest
// swing band, the strongest drift and the noisiest path.
// ---------------------------------------------------------------------------
const MINUTE = 60 * 1000;
const MARKET_ARCHETYPES = {
  ZIP: {
    id: 'ZIP',
    cycleMs: [1 * MINUTE, 3 * MINUTE],
    swing: [0.04, 0.08],
    drift: 0.02,
    noise: 0.0025
  },
  MOON: {
    id: 'MOON',
    cycleMs: [3 * MINUTE, 5 * MINUTE],
    swing: [0.08, 0.15],
    drift: 0.03,
    noise: 0.004
  },
  BULL: {
    id: 'BULL',
    cycleMs: [5 * MINUTE, 8 * MINUTE],
    swing: [0.12, 0.20],
    drift: 0.035,
    noise: 0.005
  },
  HODL: {
    id: 'HODL',
    cycleMs: [10 * MINUTE, 15 * MINUTE],
    swing: [0.20, 0.35],
    drift: 0.04,
    noise: 0.006
  },
  DEGEN: {
    id: 'DEGEN',
    cycleMs: [2 * MINUTE, 8 * MINUTE],
    swing: [0.15, 0.40],
    drift: 0.06,
    noise: 0.01
  },
  RUG: {
    id: 'RUG',
    cycleMs: [1.5 * MINUTE, 10 * MINUTE],
    swing: [0.10, 0.60],
    drift: 0.08,
    noise: 0.012
  }
};

// ---------------------------------------------------------------------------
// Gameplay roster: the explicit, NON-DESTRUCTIVE mapping from the canonical
// active coin catalogue (migrations 013/014 — 10 active coins, historical
// records untouched) to archetypes. Coin names/rows are never renamed or
// deleted for gameplay purposes; this roster is the clean mapping layer.
// Two coins per core archetype give the market natural redundancy; DEGEN
// and RUG are single wildcards.
//   1 FutureCoin  (FTR,  £0.10)  ZIP    6 BlockNation (BLN, £43.46) BULL
//   4 DigitalVault(DGV,  £0.10)  ZIP    8 JD Coin     (JDC, £33.48) BULL
//   2 NovaCash    (NVC,  £1.37)  MOON   5 Cybercore   (CYB, £96.45) HODL
//   7 StellaFort. (STF,  £3.91)  MOON  10 CryptoZen   (CZN, £32.00) HODL
//   9 MeteorCoin  (MTC,  £0.10)  DEGEN  3 Byteon      (BYT, £0.12)  RUG
// ---------------------------------------------------------------------------
const GAMEPLAY_ROSTER = new Map([
  [1, 'ZIP'],
  [4, 'ZIP'],
  [2, 'MOON'],
  [7, 'MOON'],
  [6, 'BULL'],
  [8, 'BULL'],
  [5, 'HODL'],
  [10, 'HODL'],
  [9, 'DEGEN'],
  [3, 'RUG']
]);

// Coins outside the explicit roster (e.g. a future catalogue addition)
// default to the bread-and-butter archetype rather than failing closed.
const DEFAULT_ARCHETYPE_ID = 'MOON';

function resolveArchetypeId(coinId) {
  const mapped = GAMEPLAY_ROSTER.get(Number(coinId));
  return mapped || DEFAULT_ARCHETYPE_ID;
}

function getArchetype(coinId) {
  return MARKET_ARCHETYPES[resolveArchetypeId(coinId)];
}

// ---------------------------------------------------------------------------
// Small deterministic helpers.
// ---------------------------------------------------------------------------
function lerp(min, max, u) {
  return min + (max - min) * u;
}

function assertFiniteNumber(name, value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`market domain ${name} must be a finite number; received ${String(value)}`);
  }
}

// Per-coin market-cycle parameter stream. Same (seed, coinId, index) ->
// identical parameters, in every process, forever. The ':v2-market:'
// domain separator keeps this stream independent from the Core 3 collapse
// shuffle, the Core 5 bot stream and the economy event stream.
function buildMarketCycle({ seed, coinId, archetypeId, index }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('market domain seed must be a non-empty string');
  }
  const archetype = MARKET_ARCHETYPES[archetypeId];
  if (!archetype) {
    throw new Error(`unknown market archetype ${String(archetypeId)}`);
  }
  const random = createSeededRandom(`${seed}:v2-market:${Number(coinId)}:${index}`);

  const durationMs = Math.round(lerp(archetype.cycleMs[0], archetype.cycleMs[1], random()));
  const swing = lerp(archetype.swing[0], archetype.swing[1], random());
  // Dip depth / boom height are independent draws within the swing band so
  // cycles are asymmetric: a deep dip does not imply an equally high boom.
  const dipDepth = swing * lerp(0.55, 1.0, random());
  const boomHeight = swing * lerp(0.55, 1.0, random());
  // The BOOM plateau decays a little before the FALL — the exact top is a
  // narrow window, so catching it precisely is genuinely difficult.
  const boomDecay = swing * lerp(0, 0.3, random());
  // Where the FALL lands relative to the NEXT anchor: 0 lands exactly on
  // it, 1 lands a full swing below it.
  const endDiscount = swing * lerp(0, 0.8, random());
  // Phase fractions (DIP, RISE, BOOM; FALL takes the remainder).
  const dipFrac = lerp(0.15, 0.30, random());
  const riseFrac = lerp(0.20, 0.35, random());
  const boomFrac = lerp(0.10, 0.25, random());
  const fallFrac = 1 - dipFrac - riseFrac - boomFrac;
  // Transition shape: <1 snappy-then-drift, 1 linear, >1 slow-then-sharp.
  const shape = lerp(0.7, 1.6, random());
  // Anchor drift into the next cycle (regime movement).
  const drift = lerp(-archetype.drift, archetype.drift, random());

  return {
    index,
    archetypeId,
    durationMs,
    swing,
    dipDepth,
    boomHeight,
    boomDecay,
    endDiscount,
    dipFrac,
    riseFrac,
    boomFrac,
    fallFrac,
    shape,
    drift
  };
}

// Bounded short-term noise is a PER-COIN, pure function of time: constant
// seeded periods/phases for the whole round, so it is continuous everywhere
// — including across market-cycle boundaries (a per-cycle noise draw would
// jump at every boundary). Two incommensurate sine components keep it
// aperiodic; |noise| <= noiseAmp always.
function buildCoinNoise({ seed, coinId, archetypeId }) {
  const archetype = MARKET_ARCHETYPES[archetypeId];
  const random = createSeededRandom(`${seed}:v2-market-noise:${Number(coinId)}`);
  return {
    noiseAmp: archetype.noise * lerp(0.5, 1.0, random()),
    noisePeriod1Ms: lerp(20 * 1000, 45 * 1000, random()),
    noisePeriod2Ms: lerp(50 * 1000, 95 * 1000, random()),
    noisePhase1: random() * 2 * Math.PI,
    noisePhase2: random() * 2 * Math.PI,
    noiseMix: random()
  };
}

function coinNoise(noise, nowMs) {
  const a = Math.sin((2 * Math.PI * nowMs) / noise.noisePeriod1Ms + noise.noisePhase1);
  const b = Math.sin((2 * Math.PI * nowMs) / noise.noisePeriod2Ms + noise.noisePhase2);
  return noise.noiseAmp * (noise.noiseMix * a + (1 - noise.noiseMix) * b);
}

// Staggering: each coin's market clock is offset into its first cycle by a
// seeded fraction, so at apocalypse start the coins are spread across
// different phases instead of dipping in lockstep. Deterministic per
// (seed, coinId); deliberately NOT derived from coinId alone so the
// stagger pattern changes every apocalypse.
function getCoinStartOffsetFraction(seed, coinId) {
  const random = createSeededRandom(`${seed}:v2-market-offset:${Number(coinId)}`);
  return random();
}

// Walk the coin's market timeline from the apocalypse start to the cycle
// containing nowMs, accumulating anchors and boundary levels. The walk is
// bounded (ZIP completes at most ~45 cycles in a 30-minute round, counting
// the pre-start offset) and every step is pure seeded math — no state is
// stored anywhere.
//
// Relative price model (multiplied by the baseline at the end):
//   anchor_0 = 1, boundary_0 = 1  (the round starts exactly at baseline)
//   cycle k:  start B_k -> trough A_k*(1-dip_k)   [DIP]
//             trough -> peak A_k*(1+boom_k)       [RISE]
//             peak -> peak*(1-boomDecay_k)        [BOOM plateau]
//             plateau end -> B_{k+1}              [FALL]
//   A_{k+1} = A_k * (1 + drift_k)
//   B_{k+1} = A_{k+1} * (1 - endDiscount_k)
const MAX_TIMELINE_CYCLES = 10000;

function locateMarketCycle({ seed, coinId, archetypeId, roundStartMs, nowMs }) {
  assertFiniteNumber('roundStartMs', roundStartMs);
  assertFiniteNumber('nowMs', nowMs);

  const first = buildMarketCycle({ seed, coinId, archetypeId, index: 0 });
  const offsetMs = getCoinStartOffsetFraction(seed, coinId) * first.durationMs;

  let cycle = first;
  let startMs = roundStartMs - offsetMs;
  let anchor = 1;
  let boundary = 1;

  for (let i = 0; i < MAX_TIMELINE_CYCLES; i++) {
    const endMs = startMs + cycle.durationMs;
    if (nowMs < endMs) {
      return { cycle, startMs, endMs, anchor, boundary };
    }
    const nextAnchor = anchor * (1 + cycle.drift);
    const nextBoundary = nextAnchor * (1 - cycle.endDiscount);
    cycle = buildMarketCycle({ seed, coinId, archetypeId, index: cycle.index + 1 });
    startMs = endMs;
    anchor = nextAnchor;
    boundary = nextBoundary;
  }
  throw new Error('market domain timeline failed to converge');
}

// Ease a segment position x in [0,1]. Falling segments ease in (slow start,
// sharp end), rising segments ease out (fast start, topping drift) — peaks
// are approached gradually and left quickly, which is what makes exits
// skilful rather than mechanical.
function easeSegment(x, shape, direction) {
  const clamped = Math.min(1, Math.max(0, x));
  if (direction === 'UP') return 1 - Math.pow(1 - clamped, shape);
  if (direction === 'DOWN') return Math.pow(clamped, shape);
  return clamped; // BOOM plateau: linear decay
}

// Internal phase/price evaluation inside the located cycle. Returns the
// exact internal state; public exposure goes through getPublicCoinSignal,
// which deliberately strips all timing/anchor detail.
function evaluateCyclePoint({ location, nowMs }) {
  const { cycle, startMs, anchor, boundary } = location;
  const x = Math.min(1, Math.max(0, (nowMs - startMs) / cycle.durationMs));

  const trough = anchor * (1 - cycle.dipDepth);
  const peak = anchor * (1 + cycle.boomHeight);
  const plateauEnd = peak * (1 - cycle.boomDecay);
  const nextAnchor = anchor * (1 + cycle.drift);
  const nextBoundary = nextAnchor * (1 - cycle.endDiscount);

  const dipEnd = cycle.dipFrac;
  const riseEnd = dipEnd + cycle.riseFrac;
  const boomEnd = riseEnd + cycle.boomFrac;

  let phase;
  let relative;
  if (x < dipEnd) {
    phase = 'DIP';
    const u = easeSegment(x / dipEnd, cycle.shape, 'DOWN');
    relative = boundary + (trough - boundary) * u;
  } else if (x < riseEnd) {
    phase = 'RISE';
    const u = easeSegment((x - dipEnd) / cycle.riseFrac, cycle.shape, 'UP');
    relative = trough + (peak - trough) * u;
  } else if (x < boomEnd) {
    phase = 'BOOM';
    const u = easeSegment((x - riseEnd) / cycle.boomFrac, cycle.shape, 'FLAT');
    relative = peak + (plateauEnd - peak) * u;
  } else {
    phase = 'FALL';
    const span = Math.max(cycle.fallFrac, 1e-9);
    const u = easeSegment((x - boomEnd) / span, cycle.shape, 'DOWN');
    relative = plateauEnd + (nextBoundary - plateauEnd) * u;
  }
  // The anchor path WALKS linearly from A_k to A_{k+1} across the cycle.
  // It is continuous in time (A_{k+1} is shared with the next cycle), which
  // is what allows the Core 2 amplitude to scale deviation-from-anchor
  // without introducing discontinuities at cycle boundaries.
  const anchorPath = anchor * (1 + cycle.drift * x);
  return { phase, relative, anchor, anchorPath };
}

// Validate and normalise the amplitude multiplier exactly like Core 2 does:
// any invalid value safely falls back to normal amplitude (1).
function resolveAmplitude(amplitude) {
  return typeof amplitude === 'number' && Number.isFinite(amplitude) && amplitude > 0
    ? amplitude
    : 1;
}

// The core pricing function. Deterministic in every input.
//   options:
//     seed            persisted apocalypse cycle seed (internal only)
//     coinId          catalogue coin id
//     baselinePrice   persisted cycle_baseline_price (> 0)
//     roundStartMs    persisted apocalypse cycle start (ms epoch)
//     nowMs           authoritative time (real clock live, injected in sim)
//     amplitude       Core 2 apocalypse volatility factor (default 1)
// Returns the exact internal price point, including the internal phase and
// anchor — callers that expose anything publicly MUST go through
// getPublicCoinSignal instead.
function evaluateMarketPoint({ seed, coinId, baselinePrice, roundStartMs, nowMs, amplitude = 1 }) {
  assertFiniteNumber('baselinePrice', baselinePrice);
  if (baselinePrice <= 0) {
    throw new Error(`market domain baselinePrice must be positive; received ${baselinePrice}`);
  }
  const amp = resolveAmplitude(amplitude);
  const archetypeId = resolveArchetypeId(coinId);
  const location = locateMarketCycle({ seed, coinId, archetypeId, roundStartMs, nowMs });
  const point = evaluateCyclePoint({ location, nowMs });

  // Amplitude scales the DEVIATION from the continuous anchor path (dip
  // depth and boom height), never the anchor path itself — late-apocalypse
  // escalation makes swings wilder without silently repricing the market or
  // breaking price continuity at cycle boundaries.
  const deviation = point.relative - point.anchorPath;
  const scaled = point.anchorPath + deviation * amp;
  const noise = coinNoise(buildCoinNoise({ seed, coinId, archetypeId }), nowMs) * amp;

  const raw = baselinePrice * scaled * (1 + noise);
  // Live prices are always finite and strictly positive. The floor is far
  // below any reachable value (anchor drift is bounded per cycle and the
  // cycle count per round is small); it exists so a pathological input can
  // never produce 0, a negative number or NaN.
  const price = Math.max(MIN_POSITIVE_PRICE, raw);

  return {
    price,
    phase: point.phase,
    archetypeId,
    // Internal-only detail: never serialise into any public response.
    anchor: point.anchor,
    cycleIndex: location.cycle.index
  };
}

// Round an exact domain price to persisted gameplay precision, preserving
// the strictly-positive invariant. This is the ONLY price-rounding rule;
// the live writer and the simulator both use it, so simulated trades settle
// at exactly the prices the live game would persist.
function roundGamePrice(price) {
  assertFiniteNumber('price', price);
  const factor = Math.pow(10, GAME_PRICE_DECIMALS);
  const rounded = Math.round(price * factor) / factor;
  return Math.max(MIN_POSITIVE_PRICE, rounded);
}

// The persisted gameplay price for a live coin at a moment in time.
function priceAt(options) {
  return roundGamePrice(evaluateMarketPoint(options).price);
}

// ---------------------------------------------------------------------------
// Public signals. Coarse and imperfect by construction: current price,
// recent movement over a fixed public lookback, the CURRENT coarse phase
// (name only — never its timing, boundaries or duration), momentum
// direction, archetype identity and its approximate typical ranges. No
// seed, no anchor, no cycle index, no future information of any kind.
// ---------------------------------------------------------------------------
const PUBLIC_SIGNAL_LOOKBACK_MS = 60 * 1000;
const PUBLIC_MOMENTUM_THRESHOLD_PCT = 0.15;

// Keys a public signal is allowed to carry — the redaction contract, also
// enforced by test.
const PUBLIC_SIGNAL_KEYS = [
  'coinId',
  'archetype',
  'currentPrice',
  'recentChangePct',
  'phase',
  'momentum',
  'typicalCycleMinutes',
  'typicalSwingPct'
];

function getPublicCoinSignal({ seed, coinId, baselinePrice, roundStartMs, nowMs, amplitude = 1, lookbackMs = PUBLIC_SIGNAL_LOOKBACK_MS }) {
  const archetypeId = resolveArchetypeId(coinId);
  const archetype = MARKET_ARCHETYPES[archetypeId];

  const current = evaluateMarketPoint({ seed, coinId, baselinePrice, roundStartMs, nowMs, amplitude });
  const currentPrice = roundGamePrice(current.price);

  const pastMs = nowMs - Math.max(1, lookbackMs);
  const pastPrice = priceAt({ seed, coinId, baselinePrice, roundStartMs, nowMs: pastMs, amplitude });
  const recentChangePct = Math.round(((currentPrice - pastPrice) / pastPrice) * 10000) / 100;

  const momentum = recentChangePct > PUBLIC_MOMENTUM_THRESHOLD_PCT
    ? 'UP'
    : recentChangePct < -PUBLIC_MOMENTUM_THRESHOLD_PCT
      ? 'DOWN'
      : 'FLAT';

  return {
    coinId: Number(coinId),
    archetype: archetypeId,
    currentPrice,
    recentChangePct,
    phase: current.phase,
    momentum,
    typicalCycleMinutes: [archetype.cycleMs[0] / MINUTE, archetype.cycleMs[1] / MINUTE],
    typicalSwingPct: [archetype.swing[0] * 100, archetype.swing[1] * 100]
  };
}

module.exports = {
  GAME_PRICE_DECIMALS,
  MIN_POSITIVE_PRICE,
  MARKET_ARCHETYPES,
  GAMEPLAY_ROSTER,
  DEFAULT_ARCHETYPE_ID,
  PUBLIC_SIGNAL_LOOKBACK_MS,
  PUBLIC_SIGNAL_KEYS,
  resolveArchetypeId,
  getArchetype,
  buildMarketCycle,
  getCoinStartOffsetFraction,
  locateMarketCycle,
  evaluateMarketPoint,
  roundGamePrice,
  priceAt,
  getPublicCoinSignal
};
