// SIM-05: focused unit tests for the pure market-phase engine
// (game/marketPhaseEngine.js) — no database.
//
// Covered:
//   * all six phase ids are drawable in every lifecycle state;
//   * modifier sign/range and duration range per phase;
//   * deterministic weighted selection (same seed+seq+state -> same draw);
//   * lifecycle-dependent distributions over thousands of selections;
//   * positive phases remain possible late and negative phases possible
//     early (Rule 8 and its mirror);
//   * the contiguous one-primary phase chain and the covering-phase lookup.

const {
  selectPhaseFromWeights,
  drawPhaseAt,
  buildPhaseChain,
  getPhaseAt
} = require('../game/marketPhaseEngine');
const {
  MARKET_PHASE_IDS,
  POSITIVE_MARKET_PHASE_IDS,
  NEGATIVE_MARKET_PHASE_IDS,
  LIFECYCLE_STATE_IDS,
  DEFAULT_SIMULATION_CONFIG
} = require('../game/simulationConfig');

const SEED = 'market-phase-engine-test-seed';
const START = new Date('2026-08-30T10:00:00.000Z');
const END = new Date('2026-08-30T10:30:00.000Z');

function sampleSelections(lifecycleState, count, seed = SEED) {
  const phases = [];
  for (let seq = 1; seq <= count; seq++) {
    phases.push(drawPhaseAt({ seed, phaseSeq: seq, lifecycleState }).phase);
  }
  return phases;
}

function countByPhase(phases) {
  const counts = Object.fromEntries(MARKET_PHASE_IDS.map((id) => [id, 0]));
  for (const p of phases) counts[p] += 1;
  return counts;
}

describe('phase selection primitives', () => {
  test('selectPhaseFromWeights is a pure cumulative draw over the canonical order', () => {
    const weights = DEFAULT_SIMULATION_CONFIG.marketPhases.lifecycleWeights.GROWTH;
    // A draw of 0 lands on the first phase with non-zero weight.
    expect(selectPhaseFromWeights(0, weights)).toBe('GOLDEN_AGE');
    // A draw just below 1 lands on the last phase.
    expect(selectPhaseFromWeights(0.999999999, weights)).toBe('RECESSION');
    // Out-of-range draws are rejected, never clamped.
    expect(() => selectPhaseFromWeights(-0.1, weights)).toThrow(/\[0, 1\)/);
    expect(() => selectPhaseFromWeights(1, weights)).toThrow(/\[0, 1\)/);
  });

  test('drawPhaseAt is deterministic for the same (seed, seq, lifecycle state)', () => {
    const a = drawPhaseAt({ seed: SEED, phaseSeq: 7, lifecycleState: 'DECLINE' });
    const b = drawPhaseAt({ seed: SEED, phaseSeq: 7, lifecycleState: 'DECLINE' });
    expect(b).toEqual(a);
    expect(MARKET_PHASE_IDS).toContain(a.phase);
    expect(a.lifecycleState).toBe('DECLINE');
  });

  test('drawPhaseAt varies across chain positions and seeds', () => {
    const seqs = [1, 2, 3, 4, 5].map((seq) => drawPhaseAt({ seed: SEED, phaseSeq: seq, lifecycleState: 'GROWTH' }));
    expect(new Set(seqs.map((d) => `${d.phase}:${d.modifier}:${d.durationMs}`)).size).toBeGreaterThan(1);
    const otherSeed = drawPhaseAt({ seed: 'another-seed', phaseSeq: 1, lifecycleState: 'GROWTH' });
    const sameSeed = drawPhaseAt({ seed: SEED, phaseSeq: 1, lifecycleState: 'GROWTH' });
    // Not a proof of difference in general, but these fixed seeds do differ.
    expect(`${otherSeed.phase}:${otherSeed.modifier}:${otherSeed.durationMs}`)
      .not.toBe(`${sameSeed.phase}:${sameSeed.modifier}:${sameSeed.durationMs}`);
  });

  test('drawPhaseAt rejects an unknown lifecycle state and a bad sequence number', () => {
    expect(() => drawPhaseAt({ seed: SEED, phaseSeq: 1, lifecycleState: 'MANIA' })).toThrow(/unknown lifecycle state/);
    expect(() => drawPhaseAt({ seed: SEED, phaseSeq: 0, lifecycleState: 'GROWTH' })).toThrow(/positive integer/);
  });

  test('every phase draw has the sign, modifier range and duration range of its phase', () => {
    const { phases } = DEFAULT_SIMULATION_CONFIG.marketPhases;
    for (const state of LIFECYCLE_STATE_IDS) {
      for (let seq = 1; seq <= 300; seq++) {
        const draw = drawPhaseAt({ seed: SEED, phaseSeq: seq, lifecycleState: state });
        const def = phases[draw.phase];
        expect(draw.modifier).toBeGreaterThanOrEqual(def.modifier.min);
        expect(draw.modifier).toBeLessThanOrEqual(def.modifier.max);
        if (POSITIVE_MARKET_PHASE_IDS.includes(draw.phase)) expect(draw.modifier).toBeGreaterThan(0);
        else expect(draw.modifier).toBeLessThan(0);
        expect(draw.durationMs).toBeGreaterThanOrEqual(def.durationMs.min);
        expect(draw.durationMs).toBeLessThanOrEqual(def.durationMs.max);
        expect(Number.isInteger(draw.durationMs)).toBe(true);
      }
    }
  });

  test('all six phase ids occur in every lifecycle state', () => {
    for (const state of LIFECYCLE_STATE_IDS) {
      const counts = countByPhase(sampleSelections(state, 3000));
      for (const id of MARKET_PHASE_IDS) {
        expect(counts[id]).toBeGreaterThan(0);
      }
    }
  });
});

describe('lifecycle-dependent phase distributions', () => {
  const SAMPLES = 10000;

  test('growth favours positive phases, decline favours negative phases, within tolerance of the configured weights', () => {
    const { lifecycleWeights } = DEFAULT_SIMULATION_CONFIG.marketPhases;
    for (const state of LIFECYCLE_STATE_IDS) {
      const counts = countByPhase(sampleSelections(state, SAMPLES));
      for (const id of MARKET_PHASE_IDS) {
        const observed = counts[id] / SAMPLES;
        const expected = lifecycleWeights[state][id];
        // 10000 draws: the 4-sigma noise band is well under ±0.02.
        expect(Math.abs(observed - expected)).toBeLessThan(0.02);
      }
    }
  });

  test('positive phases remain possible late and negative phases remain possible early', () => {
    const growth = countByPhase(sampleSelections('GROWTH', SAMPLES));
    const collapse = countByPhase(sampleSelections('COLLAPSE', SAMPLES));
    const positiveIn = (counts) => POSITIVE_MARKET_PHASE_IDS.reduce((n, id) => n + counts[id], 0);
    const negativeIn = (counts) => NEGATIVE_MARKET_PHASE_IDS.reduce((n, id) => n + counts[id], 0);
    // Early bear spells exist; late believable hope exists.
    expect(negativeIn(growth)).toBeGreaterThan(0);
    expect(positiveIn(collapse)).toBeGreaterThan(0);
    // And the tilt is correct: growth is mostly positive, collapse mostly negative.
    expect(positiveIn(growth)).toBeGreaterThan(negativeIn(growth));
    expect(negativeIn(collapse)).toBeGreaterThan(positiveIn(collapse));
  });
});

describe('the primary phase chain', () => {
  test('buildPhaseChain is contiguous, in-window and covers the whole cycle', () => {
    const chain = buildPhaseChain({ seed: SEED, startTime: START, endTime: END, lifecycleState: 'GROWTH' });
    expect(chain.length).toBeGreaterThan(0);
    expect(chain[0].starts_at.getTime()).toBe(START.getTime());
    expect(chain[0].phase_seq).toBe(1);
    for (let i = 0; i < chain.length; i++) {
      expect(chain[i].phase_seq).toBe(i + 1);
      expect(chain[i].starts_at.getTime()).toBeLessThan(END.getTime());
      expect(chain[i].ends_at.getTime()).toBeGreaterThan(chain[i].starts_at.getTime());
      if (i > 0) {
        // Contiguous: each phase starts exactly at its predecessor's end.
        expect(chain[i].starts_at.getTime()).toBe(chain[i - 1].ends_at.getTime());
      }
    }
    // Coverage: the tail reaches or passes the cycle end.
    expect(chain[chain.length - 1].ends_at.getTime()).toBeGreaterThanOrEqual(END.getTime());
  });

  test('buildPhaseChain is deterministic and seed-varied', () => {
    const a = buildPhaseChain({ seed: SEED, startTime: START, endTime: END, lifecycleState: 'GROWTH' });
    const b = buildPhaseChain({ seed: SEED, startTime: START, endTime: END, lifecycleState: 'GROWTH' });
    expect(b).toEqual(a);
    const c = buildPhaseChain({ seed: 'other-seed', startTime: START, endTime: END, lifecycleState: 'GROWTH' });
    expect(c).not.toEqual(a);
  });

  test('exactly one primary phase covers any instant of the cycle', () => {
    const chain = buildPhaseChain({ seed: SEED, startTime: START, endTime: END, lifecycleState: 'GROWTH' });
    for (let t = START.getTime(); t < END.getTime(); t += 30000) {
      const covering = chain.filter(
        (p) => p.starts_at.getTime() <= t && t < p.ends_at.getTime()
      );
      expect(covering).toHaveLength(1);
      expect(getPhaseAt(chain, new Date(t))).toEqual(covering[0]);
    }
    // Outside the covered window: null, never an error.
    expect(getPhaseAt(chain, new Date(START.getTime() - 1))).toBeNull();
  });

  test('chain rows carry the explicit lifecycle state used for the draw', () => {
    const chain = buildPhaseChain({ seed: SEED, startTime: START, endTime: END, lifecycleState: 'PLATEAU' });
    for (const row of chain) {
      expect(row.lifecycle_state).toBe('PLATEAU');
      expect(MARKET_PHASE_IDS).toContain(row.phase);
      expect(typeof row.modifier).toBe('number');
    }
  });

  test('rejects an inverted window', () => {
    expect(() => buildPhaseChain({ seed: SEED, startTime: END, endTime: START, lifecycleState: 'GROWTH' }))
      .toThrow(/endTime after startTime/);
  });
});
