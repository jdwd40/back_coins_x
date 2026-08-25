#!/usr/bin/env node
// V2-1 headless accelerated simulator CLI.
//
// Usage:
//   node simulation/run.js [--mode tune|gate] [--rounds N] [--base-seed S]
//                          [--economy on|off] [--observation-ms MS]
//                          [--strategies A,B,C] [--out PATH] [--json]
//
// Defaults: --mode tune --rounds 200 (tune) / 2000 (gate), economy on,
// 15s observation cadence (a realistic client), all seven strategies.
//
// The simulator is intentionally DB-free: it only uses pure domain modules.
// Some shared modules (collapseScheduleService, economyService) require the
// app's pg pool module at load time; the pool is lazily connected and never
// queried here, so a placeholder database name keeps module loading hermetic
// without touching any real database.
process.env.PGDATABASE = process.env.PGDATABASE || 'coins_sim_offline';
process.env.PGUSER = process.env.PGUSER || 'jd';
process.env.PGHOST = process.env.PGHOST || 'localhost';

const fs = require('fs');
const path = require('path');
const { runBatch, buildReport, DEFAULT_BASE_SEED, ALL_STRATEGY_IDS } = require('./batch');

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

function main() {
  const args = parseArgs(process.argv);
  const mode = args.mode || 'tune';
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
