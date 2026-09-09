// Director Coin Events Wave 3: deterministic simulation parity for the
// persistent coin-event modifier path.
//
// The persistent horizon harnesses (simulation/persistentHorizon.js,
// simulation/stage9Horizon.js) must exercise the SAME event modifier path
// as the live writer — the shared pure runtime helpers
// (game/persistentCoinEventRuntime.js: reconcileCoinEventTargets over a
// deterministic in-memory ledger) plus the Wave 1 capped net modifier —
// rather than a hardcoded zero, WITHOUT a competing simulator
// architecture.
//
// Covered:
//   * both horizons drive advanceCondition/pricing with the reconciled
//     capped net modifier (nonzero coverage over the run);
//   * the in-memory ledger is deterministic: two runs agree bit-for-bit
//     and interrupted replay stays bit-identical (the ledger freezes with
//     the rest of the committed state);
//   * lifecycle: dead coins stop receiving events (nothing created after
//     diedAt); replacements receive fresh independent coverage from
//     sequence 1;
//   * bounds: every created event respects the configured duration band
//     and individual modifier bound; net modifiers respect the stack cap.

const {
  runPersistentHorizon,
  assertHorizonInvariants,
  assertReplayIdentity
} = require('../simulation/persistentHorizon');
const {
  runStage9Horizon,
  CANONICAL_PERSISTENT_COINS: STAGE9_COINS
} = require('../simulation/stage9Horizon');
const replacementPool = require('../game/replacementPool');
const persistentCoinEventDomain = require('../game/persistentCoinEventDomain');
const { resolveSimulationConfig } = require('../game/simulationConfig');

jest.setTimeout(180000);

const CONFIG = resolveSimulationConfig();
const SEED = 'wave3-horizon-parity-seed';

describe('Wave 3 horizon parity: persistentHorizon exercises the event modifier path', () => {
  test('every coin reconciles a deterministic in-memory event ledger and prices/conditions consume its capped net modifier', () => {
    const result = runPersistentHorizon({ days: 5, seed: SEED, cadenceMinutes: 30 });
    for (const entry of result.world) {
      // Events were actually planned and created for the coin.
      expect(entry.state.eventSeqCursor).toBeGreaterThan(0);
      // The last step's applied modifier equals the Wave 1 capped net of
      // the coin's ledger at that instant — the same computation the live
      // writer runs.
      const lastStepMs = result.originMs + result.steps * 30 * 60 * 1000;
      const expected = persistentCoinEventDomain.netActiveModifierCapped(entry.state.eventLedger, lastStepMs, CONFIG);
      expect(Object.is(entry.state.lastEventModifier, expected)).toBe(true);
      // Every created event respects the configured bounds.
      for (const event of entry.state.eventLedger) {
        const durationMs = new Date(event.endsAt).getTime() - new Date(event.startsAt).getTime();
        expect(durationMs).toBeGreaterThanOrEqual(CONFIG.persistentEvents.durationMs.min);
        expect(durationMs).toBeLessThanOrEqual(CONFIG.persistentEvents.durationMs.max);
        expect(Math.abs(event.modifier)).toBeLessThanOrEqual(CONFIG.persistentEvents.maxIndividualModifier);
        expect(Math.sign(event.modifier)).toBe(event.direction === 'POSITIVE' ? 1 : -1);
      }
    }
    // The event stream genuinely moved at least one modifier off zero.
    expect(result.world.some((entry) => entry.state.lastEventModifier !== 0)).toBe(true);
    // The hard invariants still hold with the event path live.
    expect(() => assertHorizonInvariants(result)).not.toThrow();
  });

  test('two independent runs with event ledgers agree bit-for-bit', () => {
    const a = runPersistentHorizon({ days: 3, seed: SEED, cadenceMinutes: 30 });
    const b = runPersistentHorizon({ days: 3, seed: SEED, cadenceMinutes: 30 });
    for (let i = 0; i < a.world.length; i += 1) {
      expect(a.world[i].state.eventSeqCursor).toBeGreaterThan(0); // genuinely exercised
      expect(b.world[i].state.eventSeqCursor).toBe(a.world[i].state.eventSeqCursor);
      expect(Object.is(b.world[i].state.lastEventModifier, a.world[i].state.lastEventModifier)).toBe(true);
      expect(b.world[i].state.eventLedger).toEqual(a.world[i].state.eventLedger);
    }
  });

  test('interrupted replay with ledgers stays bit-identical', () => {
    const result = runPersistentHorizon({ days: 6, seed: SEED, cadenceMinutes: 30, replayDay: 3 });
    // The event ledger is part of the frozen restart boundary.
    for (const entry of result.frozenReplayState) {
      expect(Array.isArray(entry.state.eventLedger)).toBe(true);
      expect(entry.state.eventSeqCursor).toBeGreaterThan(0);
    }
    const replay = assertReplayIdentity(result);
    expect(replay.checked).toBeGreaterThan(0);
  });
});

describe('Wave 3 horizon parity: stage9Horizon event lifecycle', () => {
  test('alive coins receive events, dead coins stop receiving them, replacements start a fresh sequence', () => {
    // The proven Stage 9 gate timeline (its 30-day director run measurably
    // produces deaths AND delayed replacements) with the event path live.
    const result = runStage9Horizon({
      days: 30,
      cadenceMinutes: 60,
      seed: 'stage9-gate-seed',
      provider: 'director',
      replacementDelayMs: replacementPool.DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs
    });

    let sawDead = false;
    let sawReplacement = false;
    for (const entry of result.world) {
      const ledger = entry.state.eventLedger;
      if (entry.state.status === 'DEAD') {
        sawDead = true;
        // No event was created for the coin after its authoritative death.
        for (const event of ledger) {
          expect(new Date(event.startsAt).getTime()).toBeLessThanOrEqual(entry.state.diedAt);
        }
      } else {
        expect(entry.state.eventSeqCursor).toBeGreaterThan(0);
      }
      if (entry.state.isReplacement) {
        sawReplacement = true;
        // Fresh independent coverage: the replacement accumulated its own
        // events (its sequence cursor advanced from 0 at introduction) and
        // nothing predates its introduction. (The from-sequence-1 property
        // is pinned against the real authority in the DB-backed writer
        // suite; the pruned in-memory ledger only retains the live tail.)
        expect(entry.state.eventSeqCursor).toBeGreaterThan(0);
        expect(ledger.length).toBeGreaterThan(0);
        for (const event of ledger) {
          expect(new Date(event.startsAt).getTime()).toBeGreaterThanOrEqual(entry.state.introducedAtMs);
        }
      }
      // Bounds on every created event.
      for (const event of ledger) {
        expect(Math.abs(event.modifier)).toBeLessThanOrEqual(CONFIG.persistentEvents.maxIndividualModifier);
      }
    }
    expect(result.world.length).toBeGreaterThanOrEqual(STAGE9_COINS.length);
    expect(sawDead || result.events.deaths.length > 0).toBe(true);
    expect(sawReplacement).toBe(true);
  });
});
