#!/usr/bin/env node
// V2-1 headless accelerated simulator CLI.
//
// Usage:
//   node simulation/run.js [--mode tune|gate|power|v2-3|bots|multi-cycle]
//                          [--rounds N] [--base-seed S]
//                          [--economy on|off] [--observation-ms MS]
//                          [--strategies A,B,C] [--out PATH] [--json]
//                          [--cycles N] [--scenarios market,pressure,events]
//
// Defaults: --mode tune --rounds 200 (tune) / 2000 (gate), economy on,
// 15s observation cadence (a realistic client), all seven strategies.
// --mode multi-cycle (SIM-18/19): --cycles 200 default (use 10-20 for a
// smoke run; a real validation run uses hundreds/thousands), all three
// scenario sections.
//
// The simulator is intentionally DB-free: it only uses pure domain modules.
// Some shared modules (dynamicCollapseService, economyService) require the
// app's pg pool module at load time; the pool is lazily connected and never
// queried here, so a placeholder database name keeps module loading hermetic
// without touching any real database.
process.env.PGDATABASE = process.env.PGDATABASE || 'coins_sim_offline';
process.env.PGUSER = process.env.PGUSER || 'jd';
process.env.PGHOST = process.env.PGHOST || 'localhost';

const fs = require('fs');
const path = require('path');
const { runBatch, buildReport, DEFAULT_BASE_SEED, ALL_STRATEGY_IDS } = require('./batch');
const { runPowerStudy, buildPowerReport, POWER_STUDY_BASE_SEED, ALL_PLAYER_IDS } = require('./powerStudy');
const {
  runEscalationStudy,
  buildEscalationReport,
  ESCALATION_STUDY_BASE_SEED,
  V2_ECONOMY_SCALE,
  ALL_PLAYER_IDS: ESCALATION_PLAYER_IDS
} = require('./escalationStudy');
const {
  runBotStudy,
  buildBotReport,
  BOT_STUDY_BASE_SEED,
  ALL_PLAYER_IDS: BOT_PLAYER_IDS
} = require('./botStudy');
const {
  runMultiCycle,
  buildMultiCycleReport,
  MULTI_CYCLE_BASE_SEED,
  SCENARIO_IDS
} = require('./multiCycle');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

function formatMoney(value) {
  return `£${Number(value).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function printSummary(report) {
  const { config, gate, strategies, paired } = report;
  console.log('=== Crypto Chaos V2-1 paired seeded simulation ===');
  console.log(`rounds: ${config.rounds} | baseSeed: ${config.baseSeed} | economy: ${config.economy ? 'on' : 'off'} | observation: ${config.observationMs}ms | starting cash: ${formatMoney(config.startingCash)}`);
  console.log('');
  const header = ['strategy', 'medianFinal', 'meanFinal', 'medianROI', 'meanROI', 'profitable%', 'trades', 'timeInMkt', 'meanMaxDD'];
  console.log(header.map((h) => h.padStart(14)).join(''));
  for (const [id, s] of Object.entries(strategies)) {
    console.log([
      id.padEnd(14),
      formatMoney(s.medianFinalCash).padStart(14),
      formatMoney(s.meanFinalCash).padStart(14),
      `${s.medianRoi}%`.padStart(14),
      `${s.meanRoi}%`.padStart(14),
      `${s.profitableRoundPct}%`.padStart(14),
      String(s.meanTradesPerRound).padStart(14),
      String(s.meanTimeInMarket).padStart(14),
      String(s.meanMaxDrawdown).padStart(14)
    ].join(''));
  }
  console.log('');
  console.log(`DIP_BOOM vs RANDOM paired win rate: ${paired.DIP_BOOM.RANDOM.winRatePct}% (median diff ${formatMoney(paired.DIP_BOOM.RANDOM.medianDiff)})`);
  console.log('');
  console.log('=== V2-1 gate ===');
  for (const [name, criterion] of Object.entries(gate)) {
    if (name === 'pass') continue;
    console.log(`${criterion.pass ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(criterion)}`);
  }
  console.log('');
  console.log(`GATE VERDICT: ${gate.pass ? 'PASS' : 'FAIL'}`);
}

function printPowerSummary(report) {
  const { config, gate, players, paired } = report;
  console.log('=== Crypto Chaos V2-2 multi-round Power study ===');
  console.log(`sequences: ${config.sequences} x ${config.roundsPerSequence} consecutive rounds | baseSeed: ${config.baseSeed} | economy: ${config.economy ? 'on' : 'off'} | observation: ${config.observationMs}ms | starting cash: ${formatMoney(config.startingCash)}`);
  const pc = config.powerConfig;
  console.log(`power: max ${pc.maxPower}, +1 per ${pc.regenMsPerPoint / 1000}s, buy cost max(1, ceil(total/${pc.buyCostDivisor})), max open positions ${pc.maxOpenPositions}`);
  console.log('');
  const header = ['player', 'medianROI', 'meanROI', 'profit%', 'trades/r', 'startPow', 'endPow', 'starved%', 'blkPow', 'blkPos', 'pow/£'];
  console.log(header.map((h) => h.padStart(11)).join(''));
  for (const [id, p] of Object.entries(players)) {
    console.log([
      id.padEnd(11),
      `${p.medianRoi}%`.padStart(11),
      `${p.meanRoi}%`.padStart(11),
      `${p.profitableRoundPct}%`.padStart(11),
      String(p.tradesPerRound).padStart(11),
      String(p.powerAtRoundStart.mean).padStart(11),
      String(p.powerAtRoundEnd.mean).padStart(11),
      `${p.starvedTickPct}%`.padStart(11),
      String(p.opportunitiesSkippedByPower).padStart(11),
      String(p.positionLimitBlocked).padStart(11),
      String(p.powerPerPoundDeployed).padStart(11)
    ].join(''));
  }
  console.log('');
  if (paired.DIP_BOOM && paired.DIP_BOOM.RANDOM) {
    console.log(`DIP_BOOM vs RANDOM paired win rate: ${paired.DIP_BOOM.RANDOM.winRatePct}% (median diff ${formatMoney(paired.DIP_BOOM.RANDOM.medianDiff)})`);
  }
  if (paired.LATE_ENTRANT && paired.LATE_ENTRANT.RANDOM) {
    console.log(`LATE_ENTRANT vs RANDOM paired win rate: ${paired.LATE_ENTRANT.RANDOM.winRatePct}% (median ROI ${players.LATE_ENTRANT.medianRoi}%)`);
  }
  if (players.RETURNING && players.AGGRESSIVE_POWER && players.CONSERVATIVE_POWER) {
    console.log(`RETURNING median ROI: ${players.RETURNING.medianRoi}% | AGGRESSIVE mean start Power: ${players.AGGRESSIVE_POWER.powerAtRoundStart.mean} | CONSERVATIVE mean end Power: ${players.CONSERVATIVE_POWER.powerAtRoundEnd.mean}`);
  }
  console.log('');
  console.log('=== V2-2 gate ===');
  for (const [name, criterion] of Object.entries(gate)) {
    if (name === 'pass') continue;
    console.log(`${criterion.pass === null ? 'SKIP' : criterion.pass ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(criterion)}`);
  }
  console.log('');
  console.log(`GATE VERDICT: ${gate.pass === null ? 'SKIPPED (partial roster)' : gate.pass ? 'PASS' : 'FAIL'}`);
}

function printEscalationSummary(report) {
  const { config, gate, market, players, paired } = report;
  console.log('=== Crypto Chaos V2-3 escalation / risk / economy study ===');
  console.log(`sequences: ${config.sequences} x ${config.roundsPerSequence} consecutive rounds | baseSeed: ${config.baseSeed} | observation: ${config.observationMs}ms | starting cash: ${formatMoney(config.startingCash)}`);
  console.log(`economy variants: legacy Core 7 (scale 1) vs selected V2 (scale ${config.v2EconomyScale}) on identical market paths`);
  const pc = config.powerConfig;
  console.log(`power: max ${pc.maxPower}, +1 per ${pc.regenMsPerPoint / 1000}s, buy cost 1 + floor(total/${pc.buyCostDivisor}), max open positions ${pc.maxOpenPositions}`);
  console.log('');
  console.log('--- escalation bands (market-wide; medians, equal 3-minute swing windows) ---');
  const bandHeader = ['band', 'medMove%', 'medSwing%', 'floorTick%', 'oppTick%', 'liveCoins', 'riskOrd'];
  console.log(bandHeader.map((h) => h.padStart(12)).join(''));
  for (const [bandId, b] of Object.entries(market.bands)) {
    console.log([
      bandId.padEnd(12),
      String(b.medianTickMovePct).padStart(12),
      String(b.medianSwingPct).padStart(12),
      String(b.floorTickPct).padStart(12),
      String(b.opportunityTickPct).padStart(12),
      String(b.meanLiveCoins).padStart(12),
      String(b.meanRiskOrdinal).padStart(12)
    ].join(''));
  }
  console.log(`risk classifier: accuracy ${market.classifier.accuracyPct}% vs chance ${market.classifier.chanceAccuracyPct}% over ${market.classifier.samples} samples`);
  console.log('');
  for (const variant of ['v2', 'legacy']) {
    console.log(`--- players (${variant === 'v2' ? `selected V2 economy, scale ${config.v2EconomyScale}` : 'legacy Core 7 economy, scale 1'}) ---`);
    const header = ['player', 'medianROI', 'meanROI', 'profit%', 'trades/r', 'debits/r', 'erased%', 'collLoss/r', 'blkPow', 'blkPos'];
    console.log(header.map((h) => h.padStart(11)).join(''));
    for (const [id, p] of Object.entries(players[variant])) {
      console.log([
        id.padEnd(11),
        `${p.medianRoi}%`.padStart(11),
        `${p.meanRoi}%`.padStart(11),
        `${p.profitableRoundPct}%`.padStart(11),
        String(p.meanTradesPerRound).padStart(11),
        formatMoney(p.medianDebitsPerRound).padStart(11),
        `${p.erasedGainRoundPct}%`.padStart(11),
        formatMoney(p.meanCollapseLossPerRound).padStart(11),
        String(p.blockedByPower).padStart(11),
        String(p.blockedByPosition).padStart(11)
      ].join(''));
    }
    console.log('');
  }
  console.log(`DIP_BOOM vs RANDOM paired win rate (v2): ${paired.v2.DIP_BOOM.RANDOM.winRatePct}% (median diff ${formatMoney(paired.v2.DIP_BOOM.RANDOM.medianDiff)})`);
  console.log(`DIP_BOOM vs OVERSTAYER paired win rate (v2): ${paired.v2.DIP_BOOM.OVERSTAYER.winRatePct}%`);
  console.log(`LATE_ENTRANT vs RANDOM paired win rate (v2): ${paired.v2.LATE_ENTRANT.RANDOM.winRatePct}% (median ROI ${players.v2.LATE_ENTRANT.medianRoi}%)`);
  console.log('');
  console.log('=== V2-3 gate ===');
  for (const [name, criterion] of Object.entries(gate)) {
    if (name === 'pass') continue;
    console.log(`${criterion.pass === null ? 'SKIP' : criterion.pass ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(criterion)}`);
  }
  console.log('');
  console.log(`GATE VERDICT: ${gate.pass === null ? 'SKIPPED (partial roster)' : gate.pass ? 'PASS' : 'FAIL'}`);
}

function printBotSummary(report) {
  const { config, gate, players, paired, roundWins, hiddenInfoEvidence } = report;
  console.log('=== Crypto Chaos V2-4 canonical bot study ===');
  console.log(`sequences: ${config.sequences} x ${config.roundsPerSequence} consecutive rounds | baseSeed: ${config.baseSeed} | observation: ${config.observationMs}ms | starting cash: ${formatMoney(config.startingCash)} | economy scale: ${config.economyScale}`);
  const pc = config.powerConfig;
  console.log(`power: max ${pc.maxPower}, +1 per ${pc.regenMsPerPoint / 1000}s, buy cost 1 + floor(total/${pc.buyCostDivisor}), max open positions ${pc.maxOpenPositions}`);
  console.log('');
  const header = ['player', 'medianROI', 'meanROI', 'profit%', 'trades/r', 'buys/r', 'sells/r', 'win%', 'startPow', 'blkPow', 'blkPos', 'collLoss/r'];
  console.log(header.map((h) => h.padStart(11)).join(''));
  for (const [id, p] of Object.entries(players)) {
    console.log([
      id.padEnd(11),
      `${p.medianRoi}%`.padStart(11),
      `${p.meanRoi}%`.padStart(11),
      `${p.profitableRoundPct}%`.padStart(11),
      String(p.tradesPerRound).padStart(11),
      String(p.buysPerRound).padStart(11),
      String(p.sellsPerRound).padStart(11),
      `${roundWins.winPct[id]}%`.padStart(11),
      String(p.powerAtRoundStart.mean).padStart(11),
      String(p.blockedByPower).padStart(11),
      String(p.blockedByPosition).padStart(11),
      formatMoney(p.collapseLossPerRound.mean).padStart(11)
    ].join(''));
  }
  console.log('');
  console.log('--- entry phase / risk distribution (executed buys) ---');
  for (const [id, p] of Object.entries(players)) {
    console.log(`${id}: phases ${JSON.stringify(p.entryPhases.sharesPct)} | risks ${JSON.stringify(p.entryRisks.sharesPct)}`);
  }
  console.log('');
  if (paired.BOT_DIP_BUYER && paired.BOT_DIP_BUYER.DIP_BOOM) {
    console.log(`BOT_DIP_BUYER vs DIP_BOOM paired win rate: ${paired.BOT_DIP_BUYER.DIP_BOOM.winRatePct}% (median diff ${formatMoney(paired.BOT_DIP_BUYER.DIP_BOOM.medianDiff)})`);
  }
  console.log(`hidden-info evidence: ${hiddenInfoEvidence.decisionInputsChecked} decision inputs verified, ${hiddenInfoEvidence.hiddenFieldViolations} violations`);
  console.log('');
  console.log('=== V2-4 gate ===');
  for (const [name, criterion] of Object.entries(gate)) {
    if (name === 'pass') continue;
    console.log(`${criterion.pass === null ? 'SKIP' : criterion.pass ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(criterion)}`);
  }
  console.log('');
  console.log(`GATE VERDICT: ${gate.pass === null ? 'SKIPPED (partial roster)' : gate.pass ? 'PASS' : 'FAIL'}`);
}

function printMultiCycleSummary(report) {
  const { config, scenarios, flags, verdict, replay } = report;
  const market = scenarios.market;
  console.log('=== Crypto Chaos SIM-18/19 multi-cycle harness ===');
  console.log(`cycles: ${config.cycles} complete deterministic cycles | baseSeed: ${config.baseSeed} | economy: ${config.economy ? 'on' : 'off'} | observation: ${config.observationMs}ms | scenarios: ${config.scenarios.join(',')}`);
  console.log('');
  console.log('--- market shape (no-trade) ---');
  console.log(`peak index: median ${market.peakIndex.median} (start ${market.startingIndex.median}) at median ${market.peakPositionPct.median}% of the cycle`);
  console.log(`crashes/cycle: median ${market.crashCount.median} (largest median ${market.largestCrashPct.median}%) | rallies/cycle: median ${market.rallyCount.median} (largest median ${market.largestRallyPct.median}%)`);
  console.log(`first Plateau at median ${Math.round(market.firstPlateauAtMs.median / 60000)}min | first Decline at median ${Math.round(market.firstDeclineAtMs.median / 60000)}min | first collapse at median ${Math.round(market.firstCollapseAtMs.median / 60000)}min | collapse spread median ${Math.round(market.collapseSpreadMs.median / 60000)}min`);
  console.log(`forced safety collapses: mean ${market.forcedSafetyCollapses.mean}/cycle | path divergence median ${market.pathDivergence.median} | peak growth max ${market.peakGrowthMultiple.max}x | identical collapse-order pairs ${market.collapseOrderVariation.identicalOrderPairPct}%`);
  const events = scenarios.events;
  console.log('');
  console.log('--- event bias / variety ---');
  console.log(`events/cycle: median ${events.eventCount.median} (+${events.positiveEventCount.median}/-${events.negativeEventCount.median}) | negative:positive modifier ratio ${events.negativeToPositiveRatio} | distinct events ${events.distinctEventNames.length} | distinct phases ${events.distinctPhaseIds.length} | zero-event cycles ${events.zeroEventCycles}`);
  if (scenarios.pressure) {
    const pressure = scenarios.pressure;
    console.log('');
    console.log(`--- trading pressure / bots (${pressure.strategyIds.join(', ')}, two-pass tape feedback) ---`);
    console.log(`tape: median ${pressure.tapeEntries.median} trades/cycle (buys £${pressure.buyNotional.median} / sells £${pressure.sellNotional.median}) | pressure modifier mean ${pressure.meanAbsPressureModifier.mean} max ${pressure.maxAbsPressureModifier} | price divergence ${pressure.priceDivergencePct.mean}% | collapse-order shift mean ${pressure.collapseOrderShift.mean} pairs`);
    const header = ['player', 'medianROI', 'meanROI', 'profit%', 'trades/r', 'buys/r', 'sells/r'];
    console.log(header.map((h) => h.padStart(11)).join(''));
    for (const [id, p] of Object.entries(pressure.players)) {
      console.log([
        id.padStart(11),
        `${p.medianRoi}%`.padStart(11),
        `${p.meanRoi}%`.padStart(11),
        `${p.profitableRoundPct}%`.padStart(11),
        String(p.meanTradesPerRound).padStart(11),
        String(p.meanBuysPerRound).padStart(11),
        String(p.meanSellsPerRound).padStart(11)
      ].join(''));
    }
  }
  console.log('');
  console.log(`replay: ${replay.cyclesChecked} cycles re-captured, ${replay.mismatches.length} mismatches`);
  console.log('');
  console.log('=== SIM-19 quality flags ===');
  for (const [name, flag] of Object.entries(flags)) {
    console.log(`${flag.pass ? 'PASS' : 'FAIL'}  ${name}: ${JSON.stringify(flag.measured)}`);
  }
  console.log('');
  console.log(`HARNESS VERDICT: ${verdict.pass ? 'PASS' : 'FAIL'}`);
}

function main() {
  const args = parseArgs(process.argv);
  const mode = args.mode || 'tune';

  if (mode === 'multi-cycle') {
    const cycles = Number(args.cycles || args.rounds || 200);
    const baseSeed = args['base-seed'] || MULTI_CYCLE_BASE_SEED;
    const economy = args.economy !== 'off';
    const observationMs = Number(args['observation-ms'] || 15000);
    const scenarios = args.scenarios
      ? String(args.scenarios).split(',').map((s) => s.trim())
      : SCENARIO_IDS.slice();
    if (!scenarios.includes('market')) scenarios.unshift('market'); // every analysis consumes market cycles

    const startedAt = Date.now();
    const run = runMultiCycle({
      cycles,
      baseSeed,
      observationMs,
      economy,
      scenarios,
      onProgress: (done, total) => {
        if (!args.json) process.stdout.write(`\rprogress: ${done}/${total} cycles`);
      }
    });
    if (!args.json) process.stdout.write('\n');
    const report = buildMultiCycleReport(run);
    report.runtimeMs = Date.now() - startedAt; // explicitly separate runtime field
    report.mode = mode;

    const outPath = args.out || path.join(__dirname, 'output', `${mode}-latest.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    if (args.json) {
      console.log(JSON.stringify(report));
    } else {
      printMultiCycleSummary(report);
      console.log(`\nreport written to ${outPath} (${report.runtimeMs}ms)`);
    }
    process.exit(report.verdict.pass ? 0 : 1);
  }

  if (mode === 'bots') {
    const sequences = Number(args.sequences || 24);
    const roundsPerSequence = Number(args['rounds-per-sequence'] || args.rounds || 16);
    const baseSeed = args['base-seed'] || BOT_STUDY_BASE_SEED;
    const economy = args.economy !== 'off';
    const economyScale = args['economy-scale'] !== undefined ? Number(args['economy-scale']) : V2_ECONOMY_SCALE;
    const observationMs = Number(args['observation-ms'] || 15000);
    const playerIds = args.players ? String(args.players).split(',') : BOT_PLAYER_IDS;

    const startedAt = Date.now();
    const study = runBotStudy({
      sequences,
      roundsPerSequence,
      baseSeed,
      observationMs,
      economy,
      economyScale,
      playerIds,
      onProgress: (done, total) => {
        if (!args.json) process.stdout.write(`\rprogress: ${done}/${total} sequence-rounds`);
      }
    });
    if (!args.json) process.stdout.write('\n');
    const report = buildBotReport(study);
    report.runtimeMs = Date.now() - startedAt;
    report.mode = mode;

    const outPath = args.out || path.join(__dirname, 'output', `${mode}-latest.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    if (args.json) {
      console.log(JSON.stringify(report));
    } else {
      printBotSummary(report);
      console.log(`\nreport written to ${outPath} (${report.runtimeMs}ms)`);
    }
    process.exit(report.gate.pass ? 0 : 1);
  }

  if (mode === 'v2-3') {
    const sequences = Number(args.sequences || 30);
    const roundsPerSequence = Number(args['rounds-per-sequence'] || args.rounds || 24);
    const baseSeed = args['base-seed'] || ESCALATION_STUDY_BASE_SEED;
    const observationMs = Number(args['observation-ms'] || 15000);
    const v2EconomyScale = args['economy-scale'] !== undefined ? Number(args['economy-scale']) : V2_ECONOMY_SCALE;
    const playerIds = args.players ? String(args.players).split(',') : ESCALATION_PLAYER_IDS;

    const startedAt = Date.now();
    const study = runEscalationStudy({
      sequences,
      roundsPerSequence,
      baseSeed,
      observationMs,
      v2EconomyScale,
      playerIds,
      onProgress: (done, total) => {
        if (!args.json) process.stdout.write(`\rprogress: ${done}/${total} sequence-rounds`);
      }
    });
    if (!args.json) process.stdout.write('\n');
    const report = buildEscalationReport(study);
    report.runtimeMs = Date.now() - startedAt;
    report.mode = mode;

    const outPath = args.out || path.join(__dirname, 'output', `${mode}-latest.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    if (args.json) {
      console.log(JSON.stringify(report));
    } else {
      printEscalationSummary(report);
      console.log(`\nreport written to ${outPath} (${report.runtimeMs}ms)`);
    }
    process.exit(report.gate.pass ? 0 : 1);
  }

  if (mode === 'power') {
    const sequences = Number(args.sequences || 40);
    const roundsPerSequence = Number(args['rounds-per-sequence'] || args.rounds || 24);
    const baseSeed = args['base-seed'] || POWER_STUDY_BASE_SEED;
    const economy = args.economy !== 'off';
    const observationMs = Number(args['observation-ms'] || 15000);
    const playerIds = args.players ? String(args.players).split(',') : ALL_PLAYER_IDS;
    const powerConfig = {};
    if (args['power-max'] !== undefined) powerConfig.maxPower = Number(args['power-max']);
    if (args['power-regen-ms'] !== undefined) powerConfig.regenMsPerPoint = Number(args['power-regen-ms']);
    if (args['power-divisor'] !== undefined) powerConfig.buyCostDivisor = Number(args['power-divisor']);
    if (args['max-positions'] !== undefined) powerConfig.maxOpenPositions = Number(args['max-positions']);

    const startedAt = Date.now();
    const study = runPowerStudy({
      sequences,
      roundsPerSequence,
      baseSeed,
      observationMs,
      economy,
      playerIds,
      powerConfig: Object.keys(powerConfig).length > 0 ? powerConfig : null,
      onProgress: (done, total) => {
        if (!args.json) process.stdout.write(`\rprogress: ${done}/${total} sequence-rounds`);
      }
    });
    if (!args.json) process.stdout.write('\n');
    const report = buildPowerReport(study);
    report.runtimeMs = Date.now() - startedAt;
    report.mode = mode;

    const outPath = args.out || path.join(__dirname, 'output', `${mode}-latest.json`);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

    if (args.json) {
      console.log(JSON.stringify(report));
    } else {
      printPowerSummary(report);
      console.log(`\nreport written to ${outPath} (${report.runtimeMs}ms)`);
    }
    process.exit(report.gate.pass ? 0 : 1);
  }

  const rounds = Number(args.rounds || (mode === 'gate' ? 2000 : 200));
  const baseSeed = args['base-seed'] || DEFAULT_BASE_SEED;
  const economy = args.economy !== 'off';
  const observationMs = Number(args['observation-ms'] || 15000);
  const strategyIds = args.strategies ? String(args.strategies).split(',') : ALL_STRATEGY_IDS;

  const startedAt = Date.now();
  const batch = runBatch({
    rounds,
    strategyIds,
    baseSeed,
    observationMs,
    economy,
    onProgress: (done, total) => {
      if (!args.json) process.stdout.write(`\rprogress: ${done}/${total} rounds`);
    }
  });
  if (!args.json) process.stdout.write('\n');
  const report = buildReport(batch);
  report.runtimeMs = Date.now() - startedAt;
  report.mode = mode;

  const outPath = args.out || path.join(__dirname, 'output', `${mode}-latest.json`);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  if (args.json) {
    console.log(JSON.stringify(report));
  } else {
    printSummary(report);
    console.log(`\nreport written to ${outPath} (${report.runtimeMs}ms)`);
  }

  process.exit(mode === 'gate' && !report.gate.pass ? 1 : 0);
}

main();
