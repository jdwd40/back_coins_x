// V2-1 simulation strategies.
//
// Every strategy except PERFECT_INFORMATION acts ONLY on the legal public
// observation the engine hands it: per-coin public signals (current price,
// recent movement, coarse current phase, momentum, archetype, approximate
// typical ranges, dead state), its own cash/holdings, apocalypse progress
// and remaining time. No strategy receives the seed, anchors, cycle
// durations, future phases, future peaks or collapse identities/times.
//
// PERFECT_INFORMATION is the simulation-only upper benchmark: it may read
// the future grid. It must NEVER be used by real bots or gameplay.

function findSignal(observation, coinId) {
  return observation.coins.find((c) => c.coinId === coinId);
}

function aliveCoins(observation) {
  return observation.coins.filter((c) => !c.dead);
}

function sellAllAction(holding) {
  return { action: 'sell', coinId: holding.coinId, fraction: 1 };
}

// Shared DIP-BOOM-style entry selection: coins currently in DIP (or a very
// early RISE that has barely left the trough), cheapest recent movement
// first — buy low, with the intent to sell into the boom.
function dipEntries(observation, { maxPositions, spendFraction, maxBuys }) {
  const heldIds = new Set(observation.portfolio.holdings.map((h) => h.coinId));
  const openSlots = maxPositions - observation.portfolio.holdings.length;
  if (openSlots <= 0 || observation.portfolio.cash < 1) return [];

  const candidates = aliveCoins(observation)
    .filter((c) => !heldIds.has(c.coinId))
    .filter((c) =>
      c.phase === 'DIP' ||
      (c.phase === 'RISE' && c.recentChangePct !== null && c.recentChangePct <= 2)
    )
    .sort((a, b) => a.recentChangePct - b.recentChangePct);

  const actions = [];
  let cash = observation.portfolio.cash;
  for (const candidate of candidates.slice(0, Math.min(openSlots, maxBuys))) {
    const spend = Math.floor(cash * spendFraction * 100) / 100;
    if (spend >= 1) {
      actions.push({ action: 'buy', coinId: candidate.coinId, spend });
      cash -= spend;
    }
  }
  return actions;
}

const STRATEGIES = {
  RANDOM: {
    id: 'RANDOM',
    description: 'Trades without any understanding of market phases.',
    usesFuture: false,
    usesOwnRandom: true,
    decide(observation, ctx) {
      const u = ctx.rng();
      const holdings = observation.portfolio.holdings.filter((h) => !findSignal(observation, h.coinId).dead);
      if (u < 0.35 && observation.portfolio.cash >= 5 && observation.portfolio.holdings.length < 6) {
        const pool = aliveCoins(observation);
        if (pool.length === 0) return [];
        const coin = pool[Math.floor(ctx.rng() * pool.length)];
        const spend = Math.floor(observation.portfolio.cash * (0.05 + ctx.rng() * 0.25) * 100) / 100;
        return spend >= 1 ? [{ action: 'buy', coinId: coin.coinId, spend }] : [];
      }
      if (u < 0.6 && holdings.length > 0) {
        const holding = holdings[Math.floor(ctx.rng() * holdings.length)];
        return [sellAllAction(holding)];
      }
      return [];
    }
  },

  DIP_BOOM: {
    id: 'DIP_BOOM',
    description: 'Enters DIP / very early RISE, exits into BOOM; cuts deep losers.',
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation) {
      const actions = [];
      for (const holding of observation.portfolio.holdings) {
        const signal = findSignal(observation, holding.coinId);
        if (signal.dead) continue;
        if (signal.phase === 'BOOM') {
          actions.push(sellAllAction(holding));
        } else if (signal.phase === 'FALL' && holding.unrealizedPct <= -8) {
          actions.push(sellAllAction(holding)); // the boom did not come — cut
        }
      }
      return actions.concat(dipEntries(observation, { maxPositions: 3, spendFraction: 0.3, maxBuys: 2 }));
    }
  },

  LATE_SELLER: {
    id: 'LATE_SELLER',
    description: 'Finds dips as well as DIP_BOOM but habitually exits after the fall is underway.',
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation) {
      const actions = [];
      for (const holding of observation.portfolio.holdings) {
        const signal = findSignal(observation, holding.coinId);
        if (signal.dead) continue;
        if (signal.phase === 'FALL' && signal.recentChangePct !== null && signal.recentChangePct <= -2) {
          actions.push(sellAllAction(holding)); // sells low, after giving gains back
        } else if (holding.unrealizedPct <= -15) {
          actions.push(sellAllAction(holding));
        }
      }
      return actions.concat(dipEntries(observation, { maxPositions: 3, spendFraction: 0.3, maxBuys: 2 }));
    }
  },

  HOLD_FOREVER: {
    id: 'HOLD_FOREVER',
    description: 'Buys a diversified basket at round start and never exits.',
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation) {
      // Deploy ~95% of starting cash across every alive coin, a few orders
      // per tick until fully invested; never sells anything, ever.
      if (observation.portfolio.cash < observation.startingCash * 0.05) return [];
      const heldIds = new Set(observation.portfolio.holdings.map((h) => h.coinId));
      const pool = aliveCoins(observation).filter((c) => !heldIds.has(c.coinId));
      if (pool.length === 0) return [];
      const perCoin = Math.floor((observation.startingCash * 0.95) / observation.coins.length * 100) / 100;
      if (perCoin < 1) return [];
      return pool.slice(0, 2).map((coin) => ({ action: 'buy', coinId: coin.coinId, spend: perCoin }));
    }
  },

  SPAM: {
    id: 'SPAM',
    description: 'Chases every upward twitch and flips positions at the first small move either way.',
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation) {
      const actions = [];
      for (const holding of observation.portfolio.holdings) {
        const signal = findSignal(observation, holding.coinId);
        if (signal.dead) continue;
        if (holding.unrealizedPct >= 4 || holding.unrealizedPct <= -4) {
          actions.push(sellAllAction(holding));
        }
      }
      const heldIds = new Set(observation.portfolio.holdings.map((h) => h.coinId));
      let cash = observation.portfolio.cash;
      let buys = 0;
      for (const coin of aliveCoins(observation)) {
        if (buys >= 2 || observation.portfolio.holdings.length + buys >= 5) break;
        if (heldIds.has(coin.coinId)) continue;
        if (coin.momentum !== 'UP') continue;
        const spend = Math.floor(cash * 0.1 * 100) / 100;
        if (spend >= 1) {
          actions.push({ action: 'buy', coinId: coin.coinId, spend });
          cash -= spend;
          buys += 1;
        }
      }
      return actions;
    }
  },

  PUBLIC_SIGNAL_EXPLOITER: {
    id: 'PUBLIC_SIGNAL_EXPLOITER',
    description: 'Adversarial: mechanically optimal use of every legal public signal, no future knowledge.',
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation) {
      const actions = [];
      for (const holding of observation.portfolio.holdings) {
        const signal = findSignal(observation, holding.coinId);
        if (signal.dead) continue;
        // Exit the instant the boom stalls, and never hold through a fall.
        if ((signal.phase === 'BOOM' && signal.momentum !== 'UP') || signal.phase === 'FALL') {
          actions.push(sellAllAction(holding));
        }
      }
      const heldIds = new Set(observation.portfolio.holdings.map((h) => h.coinId));
      const openSlots = 3 - observation.portfolio.holdings.length;
      if (openSlots <= 0 || observation.portfolio.cash < 1) return actions;
      // Enter only confirmed trough turns, preferring the largest legal
      // typical swings (archetype ranges are public information).
      const candidates = aliveCoins(observation)
        .filter((c) => !heldIds.has(c.coinId))
        .filter((c) =>
          (c.phase === 'DIP' && c.momentum === 'UP') ||
          (c.phase === 'RISE' && c.recentChangePct !== null && c.recentChangePct <= 1)
        )
        .sort((a, b) => b.typicalSwingPct[1] - a.typicalSwingPct[1]);
      let cash = observation.portfolio.cash;
      for (const candidate of candidates.slice(0, Math.min(openSlots, 2))) {
        const spend = Math.floor(cash * 0.45 * 100) / 100;
        if (spend >= 1) {
          actions.push({ action: 'buy', coinId: candidate.coinId, spend });
          cash -= spend;
        }
      }
      return actions;
    }
  },

  PERFECT_INFORMATION: {
    id: 'PERFECT_INFORMATION',
    description: 'SIMULATION-ONLY upper benchmark with future knowledge. Never legal for gameplay or bots.',
    usesFuture: true,
    usesOwnRandom: false,
    decide(observation, ctx) {
      const future = ctx.perfect;
      const actions = [];
      // Exit any holding that has no better future exit point.
      for (const holding of observation.portfolio.holdings) {
        const signal = findSignal(observation, holding.coinId);
        if (signal.dead) continue;
        const outlook = future.bestFuture(holding.coinId, observation.t);
        if (!outlook || outlook.price <= signal.currentPrice * 1.005) {
          actions.push(sellAllAction(holding));
        }
      }
      const openSlots = 3 - observation.portfolio.holdings.length + actions.filter((a) => a.action === 'sell').length;
      if (openSlots <= 0 || observation.portfolio.cash < 1) return actions;
      // Enter the single best upcoming rise.
      let best = null;
      for (const coin of aliveCoins(observation)) {
        const outlook = future.bestFuture(coin.coinId, observation.t);
        if (!outlook) continue;
        const gain = outlook.price / coin.currentPrice - 1;
        if (gain > 0.02 && (!best || gain > best.gain)) {
          best = { coinId: coin.coinId, gain };
        }
      }
      if (best) {
        const spend = Math.floor(observation.portfolio.cash * 0.5 * 100) / 100;
        if (spend >= 1) actions.push({ action: 'buy', coinId: best.coinId, spend });
      }
      return actions;
    }
  },

  // -----------------------------------------------------------------------
  // V2-2 Power-era strategies. Each still acts ONLY on the legal public
  // observation (which now includes the player's own Power balance).
  // -----------------------------------------------------------------------

  CONSERVATIVE_POWER: {
    id: 'CONSERVATIVE_POWER',
    description: 'Power-conscious DIP_BOOM: smaller stakes, keeps a Power reserve, exits earlier.',
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation) {
      const actions = [];
      for (const holding of observation.portfolio.holdings) {
        const signal = findSignal(observation, holding.coinId);
        if (signal.dead) continue;
        if (signal.phase === 'BOOM' || (signal.phase === 'RISE' && signal.momentum !== 'UP' && holding.unrealizedPct >= 5)) {
          actions.push(sellAllAction(holding)); // banks gains early
        } else if (holding.unrealizedPct <= -10) {
          actions.push(sellAllAction(holding));
        }
      }
      // Reserve policy: never dip below 20 Power if the balance is visible.
      const power = observation.portfolio.power;
      if (power && power.current < 20) return actions;
      return actions.concat(dipEntries(observation, { maxPositions: 3, spendFraction: 0.15, maxBuys: 1 }));
    }
  },

  AGGRESSIVE_POWER: {
    id: 'AGGRESSIVE_POWER',
    description: 'Maximum deployment: large stakes into every dip, adds on every re-dip, no Power reserve.',
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation) {
      const actions = [];
      for (const holding of observation.portfolio.holdings) {
        const signal = findSignal(observation, holding.coinId);
        if (signal.dead) continue;
        if (signal.phase === 'BOOM' && signal.momentum !== 'UP') {
          actions.push(sellAllAction(holding));
        } else if (signal.phase === 'DIP' && observation.portfolio.cash >= 10) {
          // Averaging down on every re-dip: repeated Power spend on adds.
          const spend = Math.floor(observation.portfolio.cash * 0.25 * 100) / 100;
          if (spend >= 1) actions.push({ action: 'buy', coinId: holding.coinId, spend });
        }
      }
      return actions.concat(dipEntries(observation, { maxPositions: 3, spendFraction: 0.45, maxBuys: 2 }));
    }
  },

  SPLITTER: {
    id: 'SPLITTER',
    description: 'Adversarial trade-splitting attacker: identical DIP_BOOM decisions, but every buy chopped into fragments to dodge Power.',
    usesFuture: false,
    usesOwnRandom: false,
    decide(observation) {
      const base = STRATEGIES.DIP_BOOM.decide(observation);
      const fragmented = [];
      for (const action of base) {
        if (action.action !== 'buy') {
          fragmented.push(action);
          continue;
        }
        // Split each intended buy into two equal fragments (the per-tick
        // client cap is 2 buys — the attacker fragments as far as one tick
        // allows, paying a separate ceiling + minimum on every piece).
        const piece = Math.floor((action.spend / 2) * 100) / 100;
        if (piece >= 1) {
          fragmented.push({ action: 'buy', coinId: action.coinId, spend: piece });
          fragmented.push({ action: 'buy', coinId: action.coinId, spend: round2Down(action.spend - piece) });
        } else {
          fragmented.push(action);
        }
      }
      return fragmented.filter((a) => a.action !== 'buy' || a.spend >= 1);
    }
  }
};

function round2Down(value) {
  return Math.floor(value * 100) / 100;
}

module.exports = { STRATEGIES };
