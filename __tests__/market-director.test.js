// Persistent-market Stage 3: the Market Director (game/marketDirector.js, master plan §8/§10/§74).
//
// Pins: deterministic replay of the regime chain, bounded durations/intensities, regime
// variety, no absorbing regime, the environment seam contract (valid Market
// Environments at every instant, lerped by intensity), the public contract
// (regime + intensity ONLY — no rolls/chain internals), loud validation, and
// cursor resume identity (a resumed walk reproduces the origin walk exactly).

const marketDirector = require('../game/marketDirector');
const { assertMarketEnvironment, assertEnvironmentProvider } = require('../game/marketEnvironment');
const { NEUTRAL_ENVIRONMENT } = require('../game/marketEnvironment');
const { resolveSimulationConfig } = require('../game/simulationConfig');

jest.setTimeout(120000);

const SEED = 'stage3-director-test-seed';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('Stage 3 Market Director: deterministic chain and environment seam', () => {
  test('deterministic replay: the same seed reproduces the identical regime chain and environments', () => {
    const a = marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: 0 });
    const b = marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: 0 });
    for (let t = 0; t <= 365 * DAY_MS; t += 7 * 60 * 60 * 1000) {
      const ra = a.regimeAt(t);
      const rb = b.regimeAt(t);
      expect(ra.regime).toBe(rb.regime);
      expect(ra.regimeIndex).toBe(rb.regimeIndex);
      expect(Object.is(ra.intensity, rb.intensity)).toBe(true);
      const ea = a.environmentAt(t);
      const eb = b.environmentAt(t);
      for (const key of Object.keys(NEUTRAL_ENVIRONMENT)) {
        expect(Object.is(ea[key], eb[key])).toBe(true);
      }
    }
  });

  test('every evaluation returns a valid Market Environment through the seam', () => {
    const provider = marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: 0 });
    expect(() => assertEnvironmentProvider(provider)).not.toThrow();
    for (let t = 0; t <= 365 * DAY_MS; t += 37 * 60 * 1000) {
      const env = provider.environmentAt(t);
      expect(() => assertMarketEnvironment(env)).not.toThrow();
    }
  });

  test('regime variety over a year: every regime appears, transitions are frequent, none absorbs the chain', () => {
    const provider = marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: 0 });
    const seen = new Set();
    let transitions = 0;
    let previous = null;
    // Monotone sampling: the cursor amortises the chain walk.
    for (let t = 0; t <= 365 * DAY_MS; t += 60 * 60 * 1000) {
      const { regime } = provider.regimeAt(t);
      seen.add(regime);
      if (previous !== null && regime !== previous) transitions += 1;
      previous = regime;
    }
    expect(seen.size).toBeGreaterThanOrEqual(4); // variety over a year
    expect(transitions).toBeGreaterThan(100); // sub-weekly regime churn all year
    expect(transitions).toBeLessThan(365 * 24); // regimes last at least an hour (bounded durations)
  });

  test('committed regimes stay within their bounded durations and intensities', () => {
    const provider = marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: 0 });
    const config = resolveSimulationConfig();
    for (let t = 0; t <= 120 * DAY_MS; t += 3 * 60 * 60 * 1000) {
      const r = provider.regimeAt(t);
      const range = config.director.regimes[r.regime];
      expect(r.durationMs).toBeGreaterThanOrEqual(range.durationMs.min);
      expect(r.durationMs).toBeLessThanOrEqual(range.durationMs.max);
      expect(r.intensity).toBeGreaterThanOrEqual(range.intensity.min);
      expect(r.intensity).toBeLessThanOrEqual(range.intensity.max);
      expect(r.endMs).toBe(r.startMs + r.durationMs);
      expect(t).toBeGreaterThanOrEqual(r.startMs);
      expect(t).toBeLessThan(r.endMs);
    }
  });

  test('the public contract exposes ONLY regime and intensity (no rolls, no chain internals)', () => {
    const provider = marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: 0 });
    for (const t of [0, 10 * DAY_MS, 200 * DAY_MS]) {
      const pub = provider.publicRegimeAt(t);
      expect(Object.keys(pub).sort()).toEqual(['intensity', 'regime']);
      expect(pub.regime).toBe(provider.regimeAt(t).regime);
      expect(pub).not.toHaveProperty('regimeIndex');
      expect(pub).not.toHaveProperty('transitionRoll');
      expect(pub).not.toHaveProperty('seed');
      expect(pub).not.toHaveProperty('endMs');
    }
  });

  test('cursor resume reproduces the origin chain exactly', () => {
    // Walk to a deep instant, take the committed cursor, resume from it:
    // identical regime/environment at every later instant.
    const origin = marketDirector.walkDirectorChain({ seed: SEED, originMs: 0, nowMs: 100 * DAY_MS });
    const cursor = {
      regimeIndex: origin.regimeIndex,
      regime: origin.regime,
      startMs: origin.startMs,
      durationMs: origin.durationMs,
      intensity: origin.intensity
    };
    for (let t = 100 * DAY_MS; t <= 110 * DAY_MS; t += 5 * 60 * 60 * 1000) {
      const walked = marketDirector.walkDirectorChain({ seed: SEED, originMs: 0, nowMs: t });
      const resumed = marketDirector.walkDirectorChain({ seed: SEED, originMs: 0, nowMs: t, cursor });
      expect(resumed.regime).toBe(walked.regime);
      expect(resumed.regimeIndex).toBe(walked.regimeIndex);
      expect(resumed.startMs).toBe(walked.startMs);
    }
  });

  test('loud validation: bad seed/origin/instants and future cursors fail', () => {
    expect(() => marketDirector.createMarketDirectorProvider({ seed: '', originMs: 0 })).toThrow(/seed/);
    expect(() => marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: NaN })).toThrow(/originMs/);
    const provider = marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: 0 });
    // Pre-epoch instants resolve to the genesis regime (the staggered-start
    // convention) rather than throwing; non-finite instants still fail.
    expect(() => provider.environmentAt(-1)).not.toThrow();
    expect(() => provider.environmentAt(NaN)).toThrow(/nowMs/);
    expect(() => marketDirector.walkDirectorChain({ seed: SEED, originMs: 0, nowMs: 0, cursor: { regimeIndex: 0, regime: 'BULL', startMs: 1000, durationMs: 1000, intensity: 0.5 } })).toThrow(/future/);
  });

  test('positive and negative regimes move the environment in the expected direction', () => {
    // Deterministic per seed: find one positive and one negative regime
    // instant over the year and check the environment signs.
    const provider = marketDirector.createMarketDirectorProvider({ seed: SEED, originMs: 0 });
    let positiveEnv = null;
    let negativeEnv = null;
    let positiveRegime = null;
    let negativeRegime = null;
    for (let t = 0; t <= 365 * DAY_MS && (!positiveEnv || !negativeEnv); t += 60 * 60 * 1000) {
      const { regime } = provider.regimeAt(t);
      if (['GOLDEN_AGE', 'BOOM', 'BULL'].includes(regime) && !positiveEnv) {
        positiveEnv = provider.environmentAt(t);
        positiveRegime = regime;
      }
      if (['BEAR', 'BUST', 'RECESSION'].includes(regime) && !negativeEnv) {
        negativeEnv = provider.environmentAt(t);
        negativeRegime = regime;
      }
    }
    expect(positiveEnv).not.toBeNull();
    expect(negativeEnv).not.toBeNull();
    expect(positiveEnv.structuralBias).toBeGreaterThan(0);
    expect(negativeEnv.structuralBias).toBeLessThan(0);
    expect(positiveEnv.crashProbabilityModifier).toBeLessThanOrEqual(1);
    expect(negativeEnv.crashProbabilityModifier).toBeGreaterThanOrEqual(1);
    expect(['GOLDEN_AGE', 'BOOM', 'BULL']).toContain(positiveRegime);
    expect(['BEAR', 'BUST', 'RECESSION']).toContain(negativeRegime);
  });
});
