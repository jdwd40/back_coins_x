// Stage 9 S9-02: focused unit tests for game/replacementPool.js.
//
// Pure configuration / identity tests. Covered:
//   * every replacement requires an explicit archetype;
//   * missing / invalid archetype fails loudly (named ReplacementConfigError);
//   * no silent MOON (or any) archetype fallback;
//   * replacement delay comes from configuration;
//   * historical coin_ids cannot be reused;
//   * replacement identities differ from dead / live identities;
//   * roster loading is deterministic;
//   * authored configuration is validated at load / resolve time;
//   * peekNextReplacement walks unused authored ids in stable order.

const {
  VALID_ARCHETYPE_IDS,
  HISTORICAL_RESERVED_COIN_IDS,
  AUTHORED_REPLACEMENT_ROSTER,
  DEFAULT_REPLACEMENT_CONFIG,
  ReplacementConfigError,
  ReplacementIdentityError,
  LEGACY_RETIRED_COIN_IDS,
  getHistoricalReservedCoinIds,
  getLiveGameplayCoinIds,
  resolveReservedCoinIds,
  assertIdentityUnused,
  validateReplacementDefinition,
  validateReplacementConfig,
  resolveReplacementConfig,
  getReplacementDelayMs,
  getTargetActiveCount,
  loadReplacementRoster,
  peekNextReplacement
} = require('../game/replacementPool');
const { MARKET_ARCHETYPES, GAMEPLAY_ROSTER, DEFAULT_ARCHETYPE_ID } = require('../game/marketDomain');

function baseDefinition(overrides = {}) {
  return {
    coinId: 201,
    name: 'TestCoin',
    symbol: 'TST',
    description: 'Test replacement definition',
    startingPrice: 1.25,
    marketCap: 10000,
    circulatingSupply: 4000,
    founder: 'Tester',
    archetype: 'ZIP',
    ...overrides
  };
}

describe('replacement pool authored defaults', () => {
  test('default config validates and exposes the expected knobs', () => {
    expect(DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs).toBe(6 * 60 * 60 * 1000);
    expect(DEFAULT_REPLACEMENT_CONFIG.targetActiveCount).toBe(10);
    expect(DEFAULT_REPLACEMENT_CONFIG.roster.length).toBeGreaterThanOrEqual(10);
    expect(AUTHORED_REPLACEMENT_ROSTER.length).toBe(DEFAULT_REPLACEMENT_CONFIG.roster.length);
  });

  test('valid archetype vocabulary matches MARKET_ARCHETYPES exactly', () => {
    expect([...VALID_ARCHETYPE_IDS].sort()).toEqual(Object.keys(MARKET_ARCHETYPES).sort());
    expect(VALID_ARCHETYPE_IDS).toEqual(expect.arrayContaining(['ZIP', 'MOON', 'BULL', 'HODL', 'DEGEN', 'RUG']));
  });

  test('every authored replacement carries an explicit valid archetype', () => {
    for (const entry of AUTHORED_REPLACEMENT_ROSTER) {
      expect(entry.archetype).toBeDefined();
      expect(VALID_ARCHETYPE_IDS).toContain(entry.archetype);
      expect(() => validateReplacementDefinition(entry)).not.toThrow();
    }
  });

  test('authored pool is large enough to refill ~10 active coins without recycling ids', () => {
    expect(AUTHORED_REPLACEMENT_ROSTER.length).toBeGreaterThanOrEqual(DEFAULT_REPLACEMENT_CONFIG.targetActiveCount);
    expect(AUTHORED_REPLACEMENT_ROSTER.length).toBeGreaterThanOrEqual(10);
  });

  test('historical reserved ids cover the live roster and retired legacy coins', () => {
    expect(HISTORICAL_RESERVED_COIN_IDS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(getHistoricalReservedCoinIds()).toEqual(HISTORICAL_RESERVED_COIN_IDS);
    for (const liveId of getLiveGameplayCoinIds()) {
      expect(HISTORICAL_RESERVED_COIN_IDS).toContain(liveId);
    }
    expect(getLiveGameplayCoinIds()).toEqual([...GAMEPLAY_ROSTER.keys()].sort((a, b) => a - b));
    // Live canonical portion is derived from GAMEPLAY_ROSTER, not duplicated.
    for (const liveId of GAMEPLAY_ROSTER.keys()) {
      expect(HISTORICAL_RESERVED_COIN_IDS).toContain(liveId);
    }
    for (const retiredId of LEGACY_RETIRED_COIN_IDS) {
      expect(GAMEPLAY_ROSTER.has(retiredId)).toBe(false);
      expect(HISTORICAL_RESERVED_COIN_IDS).toContain(retiredId);
    }
  });
});

describe('mandatory explicit archetype (no silent MOON fallback)', () => {
  test('missing archetype fails loudly with ReplacementConfigError', () => {
    const def = baseDefinition();
    delete def.archetype;
    expect(() => validateReplacementDefinition(def)).toThrow(ReplacementConfigError);
    expect(() => validateReplacementDefinition(def)).toThrow(/archetype is mandatory/i);
  });

  test('undefined archetype fails loudly', () => {
    expect(() => validateReplacementDefinition(baseDefinition({ archetype: undefined })))
      .toThrow(/archetype is mandatory/i);
  });

  test('null archetype fails loudly', () => {
    expect(() => validateReplacementDefinition(baseDefinition({ archetype: null })))
      .toThrow(/archetype is mandatory/i);
  });

  test('invalid archetype fails loudly', () => {
    expect(() => validateReplacementDefinition(baseDefinition({ archetype: 'NOT_AN_ARCHETYPE' })))
      .toThrow(ReplacementConfigError);
    expect(() => validateReplacementDefinition(baseDefinition({ archetype: 'NOT_AN_ARCHETYPE' })))
      .toThrow(/not a valid archetype/i);
  });

  test('empty-string archetype fails loudly', () => {
    expect(() => validateReplacementDefinition(baseDefinition({ archetype: '' })))
      .toThrow(/not a valid archetype|mandatory/i);
  });

  test('no silent MOON fallback occurs when archetype is missing', () => {
    // marketDomain's DEFAULT_ARCHETYPE_ID is MOON for off-roster coins —
    // replacements must NEVER inherit that silent default.
    expect(DEFAULT_ARCHETYPE_ID).toBe('MOON');
    const def = baseDefinition();
    delete def.archetype;
    let thrown = null;
    try {
      validateReplacementDefinition(def);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ReplacementConfigError);
    expect(thrown.message).toMatch(/no silent default|MOON is never substituted/i);
    // Prove we did not quietly produce a MOON definition.
    expect(thrown.message).not.toMatch(/resolved to MOON|defaulted to MOON/i);
  });

  test('explicit MOON is accepted when authored deliberately', () => {
    const validated = validateReplacementDefinition(baseDefinition({
      coinId: 202,
      symbol: 'EXM',
      archetype: 'MOON'
    }));
    expect(validated.archetype).toBe('MOON');
  });

  test('roster validation fails loud when any entry lacks archetype', () => {
    const bad = AUTHORED_REPLACEMENT_ROSTER.map((entry, i) => {
      if (i !== 0) return entry;
      const copy = { ...entry };
      delete copy.archetype;
      return copy;
    });
    expect(() => validateReplacementConfig({
      replacementDelayMs: DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs,
      targetActiveCount: 10,
      roster: bad
    })).toThrow(ReplacementConfigError);
  });
});

describe('replacement delay configuration', () => {
  test('getReplacementDelayMs returns the configured default', () => {
    expect(getReplacementDelayMs()).toBe(DEFAULT_REPLACEMENT_CONFIG.replacementDelayMs);
    expect(getReplacementDelayMs()).toBe(6 * 60 * 60 * 1000);
  });

  test('replacement delay comes from configuration overrides', () => {
    const custom = resolveReplacementConfig({ replacementDelayMs: 2 * 60 * 60 * 1000 });
    expect(getReplacementDelayMs(custom)).toBe(2 * 60 * 60 * 1000);
    expect(getTargetActiveCount(custom)).toBe(10);
  });

  test('non-positive or non-integer delay fails loudly', () => {
    expect(() => resolveReplacementConfig({ replacementDelayMs: 0 })).toThrow(/positive integer/);
    expect(() => resolveReplacementConfig({ replacementDelayMs: -1 })).toThrow(/positive integer/);
    expect(() => resolveReplacementConfig({ replacementDelayMs: 1.5 })).toThrow(/positive integer/);
  });
});

describe('identity reservation rules', () => {
  test('historical coin_ids cannot be reused', () => {
    for (const id of HISTORICAL_RESERVED_COIN_IDS) {
      expect(() => assertIdentityUnused(id)).toThrow(ReplacementIdentityError);
      expect(() => validateReplacementDefinition(baseDefinition({ coinId: id, symbol: `X${id}` })))
        .toThrow(ReplacementIdentityError);
    }
  });

  test('replacement identities differ from dead identities', () => {
    const deadIds = [3, 9]; // sample dead historical entities
    for (const deadId of deadIds) {
      expect(() => assertIdentityUnused(deadId, deadIds)).toThrow(/never reused/i);
    }
    // A fresh authored id is fine even when other coins are dead.
    expect(assertIdentityUnused(101, deadIds)).toBe(101);
    const next = peekNextReplacement(deadIds);
    expect(next).not.toBeNull();
    expect(deadIds).not.toContain(next.coinId);
    expect(next.coinId).not.toBe(3);
    expect(next.coinId).not.toBe(9);
  });

  test('assertIdentityUnused accepts ids outside the reserved set', () => {
    expect(assertIdentityUnused(101)).toBe(101);
    expect(assertIdentityUnused(999, [1, 2, 3])).toBe(999);
  });

  test('authored roster coin_ids never collide with historical reserved ids', () => {
    const reserved = new Set(HISTORICAL_RESERVED_COIN_IDS);
    for (const entry of AUTHORED_REPLACEMENT_ROSTER) {
      expect(reserved.has(entry.coinId)).toBe(false);
      expect(entry.coinId).toBeGreaterThan(13);
    }
  });
});

describe('caller-supplied historical IDs are additive to the permanent baseline', () => {
  test('canonical coin_id 1 is still rejected when additional historical IDs are [999]', () => {
    expect(() => assertIdentityUnused(1, [999])).toThrow(ReplacementIdentityError);
    expect(() => assertIdentityUnused(1, [999])).toThrow(/never reused/i);
  });

  test('additional historical coin_id 999 is rejected alongside the baseline', () => {
    expect(() => assertIdentityUnused(999, [999])).toThrow(ReplacementIdentityError);
  });

  test('a genuinely fresh ID is accepted when additional historical IDs are supplied', () => {
    expect(assertIdentityUnused(101, [999])).toBe(101);
    expect(assertIdentityUnused(250, [999])).toBe(250);
  });

  test('the same additive reservation works with a Set', () => {
    const extra = new Set([999]);
    expect(() => assertIdentityUnused(1, extra)).toThrow(ReplacementIdentityError);
    expect(() => assertIdentityUnused(13, extra)).toThrow(ReplacementIdentityError);
    expect(() => assertIdentityUnused(999, extra)).toThrow(ReplacementIdentityError);
    expect(assertIdentityUnused(101, extra)).toBe(101);
    const reserved = resolveReservedCoinIds(extra);
    expect(reserved.has(1)).toBe(true);
    expect(reserved.has(13)).toBe(true);
    expect(reserved.has(999)).toBe(true);
    expect(reserved.has(101)).toBe(false);
  });

  test('validateReplacementDefinition cannot bypass the permanent set via custom historical IDs', () => {
    expect(() => validateReplacementDefinition(
      baseDefinition({ coinId: 1, symbol: 'BYP' }),
      { historicalIds: [999] }
    )).toThrow(ReplacementIdentityError);

    expect(() => validateReplacementDefinition(
      baseDefinition({ coinId: 999, symbol: 'EXR' }),
      { historicalIds: [999] }
    )).toThrow(ReplacementIdentityError);

    expect(() => validateReplacementDefinition(
      baseDefinition({ coinId: 250, symbol: 'FRS' }),
      { historicalIds: [999] }
    )).not.toThrow();
  });

  test('validateReplacementConfig cannot bypass the permanent set via custom historical IDs', () => {
    const cfg = {
      replacementDelayMs: 1000,
      targetActiveCount: 1,
      roster: [baseDefinition({ coinId: 1, symbol: 'CFG' })]
    };
    expect(() => validateReplacementConfig(cfg, { historicalIds: [999] }))
      .toThrow(ReplacementIdentityError);

    const extraOnly = {
      replacementDelayMs: 1000,
      targetActiveCount: 1,
      roster: [baseDefinition({ coinId: 999, symbol: 'XTR' })]
    };
    expect(() => validateReplacementConfig(extraOnly, { historicalIds: [999] }))
      .toThrow(ReplacementIdentityError);

    const fresh = {
      replacementDelayMs: 1000,
      targetActiveCount: 1,
      roster: [baseDefinition({ coinId: 250, symbol: 'OK1' })]
    };
    expect(() => validateReplacementConfig(fresh, { historicalIds: [999] }))
      .not.toThrow();
  });
});

describe('deterministic roster loading', () => {
  test('loadReplacementRoster returns the same order and ids twice', () => {
    const first = loadReplacementRoster();
    const second = loadReplacementRoster();
    expect(first.map((e) => e.coinId)).toEqual(second.map((e) => e.coinId));
    expect(first.map((e) => e.symbol)).toEqual(second.map((e) => e.symbol));
    expect(first.map((e) => e.archetype)).toEqual(second.map((e) => e.archetype));
    expect(first).toEqual(second);
  });

  test('loadReplacementRoster does not mutate the frozen defaults', () => {
    const roster = loadReplacementRoster();
    roster.pop();
    expect(loadReplacementRoster().length).toBe(AUTHORED_REPLACEMENT_ROSTER.length);
  });

  test('peekNextReplacement walks unused authored ids in stable order', () => {
    const first = peekNextReplacement([]);
    expect(first.coinId).toBe(AUTHORED_REPLACEMENT_ROSTER[0].coinId);
    const second = peekNextReplacement([first.coinId]);
    expect(second.coinId).toBe(AUTHORED_REPLACEMENT_ROSTER[1].coinId);
    const usedAll = AUTHORED_REPLACEMENT_ROSTER.map((e) => e.coinId);
    expect(peekNextReplacement(usedAll)).toBeNull();
  });

  test('peekNextReplacement is deterministic for the same used set', () => {
    const used = [101, 103, 105];
    expect(peekNextReplacement(used)).toEqual(peekNextReplacement(used));
    expect(peekNextReplacement(used).coinId).toBe(102);
  });
});

describe('authored configuration validation', () => {
  test('resolveReplacementConfig with no overrides returns frozen defaults', () => {
    expect(resolveReplacementConfig()).toBe(DEFAULT_REPLACEMENT_CONFIG);
    expect(resolveReplacementConfig(null)).toBe(DEFAULT_REPLACEMENT_CONFIG);
  });

  test('duplicate coinId or symbol in roster fails loudly', () => {
    const dupId = [
      baseDefinition({ coinId: 301, symbol: 'AAA' }),
      baseDefinition({ coinId: 301, symbol: 'BBB' })
    ];
    expect(() => validateReplacementConfig({
      replacementDelayMs: 1000,
      targetActiveCount: 1,
      roster: dupId
    })).toThrow(/duplicate coinId/);

    const dupSym = [
      baseDefinition({ coinId: 301, symbol: 'AAA' }),
      baseDefinition({ coinId: 302, symbol: 'AAA' })
    ];
    expect(() => validateReplacementConfig({
      replacementDelayMs: 1000,
      targetActiveCount: 1,
      roster: dupSym
    })).toThrow(/duplicate symbol/);
  });

  test('roster shorter than targetActiveCount fails loudly', () => {
    expect(() => validateReplacementConfig({
      replacementDelayMs: 1000,
      targetActiveCount: 5,
      roster: [baseDefinition({ coinId: 401, symbol: 'S1' })]
    })).toThrow(/below targetActiveCount/);
  });

  test('missing required metadata fields fail loudly', () => {
    for (const key of ['name', 'symbol', 'startingPrice', 'marketCap', 'circulatingSupply', 'founder', 'description']) {
      const def = baseDefinition({ coinId: 501, symbol: 'MDT' });
      delete def[key];
      expect(() => validateReplacementDefinition(def)).toThrow(ReplacementConfigError);
    }
  });

  test('non-positive startingPrice fails loudly', () => {
    expect(() => validateReplacementDefinition(baseDefinition({ startingPrice: 0 })))
      .toThrow(/startingPrice must be strictly positive/);
  });
});
