// V2-1 simulation metrics: reproducible, machine-readable statistics over
// paired seeded rounds. All functions are pure.

function mean(values) {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

// Per-strategy summary over that strategy's per-round results.
function summarizeStrategy(roundResults, startingCash) {
  const finals = roundResults.map((r) => r.finalCash);
  const rois = roundResults.map((r) => r.roi);
  const trades = roundResults.map((r) => r.trades);
  const timeInMarket = roundResults.map((r) => r.timeInMarket);
  const drawdowns = roundResults.map((r) => r.maxDrawdown);

  let best = null;
  let worst = null;
  for (const r of roundResults) {
    if (!best || r.finalCash > best.finalCash) best = { roundIndex: r.roundIndex, finalCash: r.finalCash, roi: r.roi };
    if (!worst || r.finalCash < worst.finalCash) worst = { roundIndex: r.roundIndex, finalCash: r.finalCash, roi: r.roi };
  }

  return {
    rounds: roundResults.length,
    meanFinalCash: roundTo(mean(finals), 2),
    medianFinalCash: roundTo(median(finals), 2),
    meanRoi: roundTo(mean(rois), 2),
    medianRoi: roundTo(median(rois), 2),
    profitableRoundPct: roundTo((roundResults.filter((r) => r.profitable).length / roundResults.length) * 100, 2),
    percentiles: {
      p10: roundTo(percentile(finals, 10), 2),
      p25: roundTo(percentile(finals, 25), 2),
      p50: roundTo(percentile(finals, 50), 2),
      p75: roundTo(percentile(finals, 75), 2),
      p90: roundTo(percentile(finals, 90), 2)
    },
    best,
    worst,
    meanTradesPerRound: roundTo(mean(trades), 2),
    meanTimeInMarket: roundTo(mean(timeInMarket), 4),
    meanMaxDrawdown: roundTo(mean(drawdowns), 4),
    worstMaxDrawdown: roundTo(Math.max(...drawdowns), 4),
    startingCash
  };
}

// Paired win rate: over identical seeded rounds, the fraction of rounds
// where strategy A finishes strictly ahead of strategy B (ties count 0.5).
function pairedWinRate(aResults, bResults) {
  let wins = 0;
  let ties = 0;
  for (let i = 0; i < aResults.length; i++) {
    if (aResults[i].finalCash > bResults[i].finalCash) wins += 1;
    else if (aResults[i].finalCash === bResults[i].finalCash) ties += 1;
  }
  return roundTo(((wins + ties * 0.5) / aResults.length) * 100, 2);
}

// Median and mean paired skill advantage (A final - B final) per round.
function pairedAdvantage(aResults, bResults) {
  const diffs = aResults.map((r, i) => r.finalCash - bResults[i].finalCash);
  return {
    meanDiff: roundTo(mean(diffs), 2),
    medianDiff: roundTo(median(diffs), 2)
  };
}

module.exports = {
  mean,
  median,
  percentile,
  summarizeStrategy,
  pairedWinRate,
  pairedAdvantage
};
