// Post-migration schema verification for Crypto Chaos Core 1 + Core 3.
//
// Verifies every application assumption about:
//   * public.apocalypse_cycles (Core 1): columns (name/type/nullability), the
//     sequence default on cycle_id, the now() defaults on
//     created_at/updated_at, the primary key, the unique apocalypse_id
//     constraint, all CHECK constraints, the partial unique index enforcing
//     the single-active-cycle invariant, and — for live data — the invariant
//     itself (at most one ACTIVE row, end_time > start_time).
//   * public.coins.cycle_baseline_price (Core 3): the durable restoration
//     baseline column, its NOT NULL and positive CHECK.
//   * Canonical coin catalogue (migrations 013 + 014): the exact
//     player-facing (coin_id, name, symbol) identities for coin_ids 1..10,
//     the coins.retired column shape, exactly the canonical 10 active
//     (non-retired extra rows are player-facing and flagged; retired legacy
//     rows are preserved history, not catalogue), and live symbol
//     uniqueness.
//   * public.coin_collapse_schedule (legacy Core 3, retired in Wave 4):
//     columns, PK, both FKs, both UNIQUE constraints (cycle/coin and
//     cycle/rank), all CHECK constraints, the partial due-reconciliation
//     index, and the historical-data invariant (no execution before its
//     scheduled time). The table is preserved data only — no runtime path
//     writes or reads it now.
//   * public.apocalypse_coin_collapses (SIM-13/14): the dynamic collapse
//     death record — columns, PK, both FKs, both UNIQUE constraints
//     (cycle/coin and cycle/rank), CHECK constraints, and live-data
//     invariants (no collapsed coin with a non-zero live price in the
//     ACTIVE/SETTLING cycle, no zero-priced coin without a persisted death
//     record, no duplicate deaths or ranks).
//   * Core 4 round state: apocalypse_participants, apocalypse_holdings and
//     apocalypse_transactions — columns, PKs, FKs (including the composite
//     participant FKs), uniqueness, CHECK constraints, lookup indexes, and
//     live-data invariants (no ACTIVE participant on a COMPLETED cycle,
//     final_cash consistency, no negative cash/holdings).
//   * Core 5 bots: users.is_bot (public bot marker), apocalypse_bots
//     (durable bot identities) and apocalypse_bot_ticks (the duplicate-tick
//     ledger) — columns, PKs, FKs, uniqueness, CHECK constraints, and
//     live-data invariants (bot identities backed by is_bot users, no
//     orphaned/negative tick claims).
//   * Core 6 settlement: the SETTLING lifecycle (widened status CHECK, the
//     single-settling partial unique index, settlement_started_at/settled_at
//     observability columns and their live-data invariants) and
//     apocalypse_results (the immutable per-participant snapshot) — columns,
//     PK, FKs (including the composite participant FK), uniqueness of
//     (cycle_id, participant_id) and (cycle_id, rank), CHECK constraints
//     (monetary precision, net_profit identity, rank/count consistency), the
//     immutability triggers, and live-data invariants (results only on
//     COMPLETED cycles, gapless 1..N ranks, settled-cycle completeness).
//   * Wave 1 (SIM-03/04/05): apocalypse_coin_events (columns, PK, FKs,
//     UNIQUE identity, CHECK constraints, lookup index, and live-data
//     invariants: positive windows, direction/modifier sign consistency,
//     the configured 0-5 active-per-coin overlap cap) and
//     apocalypse_market_phases (columns, PK, FK, UNIQUE chain identity,
//     CHECK constraints, lookup index, and live-data invariants: positive
//     windows, phase/modifier sign consistency, no overlapping primary
//     phases within a cycle).
//   * Wave 2 (SIM-06/07): apocalypse_market_state (columns, PK, FK, UNIQUE
//     one-row-per-cycle identity, CHECK constraints — lifecycle vocabulary,
//     non-negative index values, monotonic peak, drawdown in [0, 1],
//     momentum >= -1, plateau target at/above the starting index — and
//     live-data invariants for the same rules).
//
// Exits non-zero with an explicit problem list on any mismatch.
//
// Usage: node db/verify-game-schema.js   (uses db/connection env configuration)

const db = require('./connection');
const { resolveSimulationConfig } = require('../game/simulationConfig');

const EXPECTED_COLUMNS = [
  ['cycle_id', 'integer', 'NO'],
  ['apocalypse_id', 'character varying', 'NO'],
  ['seed', 'text', 'NO'],
  ['start_time', 'timestamp with time zone', 'NO'],
  ['end_time', 'timestamp with time zone', 'NO'],
  ['duration_ms', 'bigint', 'NO'],
  ['status', 'character varying', 'NO'],
  ['settlement_started_at', 'timestamp with time zone', 'YES'],
  ['settled_at', 'timestamp with time zone', 'YES'],
  ['created_at', 'timestamp with time zone', 'NO'],
  ['updated_at', 'timestamp with time zone', 'NO']
];

async function verifyApocalypseCycles(q, problems) {
  // Table presence.
  const table = await q(`SELECT to_regclass('public.apocalypse_cycles') AS reg`);
  if (!table.rows[0].reg) {
    problems.push('table public.apocalypse_cycles does not exist');
    return;
  }

  // Columns: name, type, nullability.
  const cols = await q(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'apocalypse_cycles'`
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const [name, dtype, nullable] of EXPECTED_COLUMNS) {
    const col = byName.get(name);
    if (!col) {
      problems.push(`missing column: ${name}`);
    } else {
      if (col.data_type !== dtype) problems.push(`column ${name}: type ${col.data_type}, expected ${dtype}`);
      if (col.is_nullable !== nullable) problems.push(`column ${name}: nullable=${col.is_nullable}, expected ${nullable}`);
    }
  }

  // Defaults the application depends on.
  const cycleId = byName.get('cycle_id');
  if (cycleId && !(cycleId.column_default || '').startsWith('nextval(')) {
    problems.push('column cycle_id: missing sequence default (nextval)');
  }
  for (const name of ['created_at', 'updated_at']) {
    const col = byName.get(name);
    if (col && !(col.column_default || '').startsWith('now()')) {
      problems.push(`column ${name}: missing default now()`);
    }
  }

  // Primary key on cycle_id.
  const pk = await q(
    `SELECT 1 FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema = 'public' AND tc.table_name = 'apocalypse_cycles'
       AND tc.constraint_type = 'PRIMARY KEY' AND kcu.column_name = 'cycle_id'`
  );
  if (pk.rowCount === 0) problems.push('missing PRIMARY KEY on cycle_id');

  // Unique constraint on apocalypse_id.
  const uq = await q(
    `SELECT 1 FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema = 'public' AND tc.table_name = 'apocalypse_cycles'
       AND tc.constraint_type = 'UNIQUE' AND kcu.column_name = 'apocalypse_id'`
  );
  if (uq.rowCount === 0) problems.push('missing UNIQUE constraint on apocalypse_id');

  // CHECK constraints.
  const checks = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'public.apocalypse_cycles'::regclass AND contype = 'c'`
  );
  const defs = checks.rows.map((r) => r.def);
  if (!defs.some((d) => /duration_ms > 0/.test(d))) problems.push('missing CHECK (duration_ms > 0)');
  if (!defs.some((d) => /ACTIVE/.test(d) && /SETTLING/.test(d) && /COMPLETED/.test(d))) {
    problems.push("missing CHECK (status IN ('ACTIVE', 'SETTLING', 'COMPLETED'))");
  }
  if (!defs.some((d) => /end_time > start_time/.test(d))) problems.push('missing CHECK (end_time > start_time)');

  // Single-active-cycle partial unique index.
  const idx = await q(
    `SELECT i.indisunique, i.indpred IS NOT NULL AS is_partial,
            pg_get_expr(i.indpred, i.indrelid) AS predicate, a.attname
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE c.relname = 'apocalypse_cycles_single_active'
       AND i.indrelid = 'public.apocalypse_cycles'::regclass`
  );
  if (idx.rowCount === 0) {
    problems.push('missing index apocalypse_cycles_single_active');
  } else {
    const { indisunique, is_partial, predicate, attname } = idx.rows[0];
    if (!indisunique || !is_partial || attname !== 'status' || !/status.*ACTIVE/i.test(predicate || '')) {
      problems.push('index apocalypse_cycles_single_active is not the expected partial UNIQUE index on (status) WHERE status = ACTIVE');
    }
  }

  // Single-settling-cycle partial unique index (Core 6): at most one cycle
  // may be mid-settlement; a stuck SETTLING cycle blocks any successor.
  const idxSettling = await q(
    `SELECT i.indisunique, i.indpred IS NOT NULL AS is_partial,
            pg_get_expr(i.indpred, i.indrelid) AS predicate, a.attname
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE c.relname = 'apocalypse_cycles_single_settling'
       AND i.indrelid = 'public.apocalypse_cycles'::regclass`
  );
  if (idxSettling.rowCount === 0) {
    problems.push('missing index apocalypse_cycles_single_settling');
  } else {
    const { indisunique, is_partial, predicate, attname } = idxSettling.rows[0];
    if (!indisunique || !is_partial || attname !== 'status' || !/status.*SETTLING/i.test(predicate || '')) {
      problems.push('index apocalypse_cycles_single_settling is not the expected partial UNIQUE index on (status) WHERE status = SETTLING');
    }
  }

  // Live-data invariants (only when rows exist and the needed columns do).
  if (byName.has('status')) {
    const active = await q(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'ACTIVE'`);
    if (active.rows[0].n > 1) problems.push(`INVARIANT VIOLATION: ${active.rows[0].n} ACTIVE rows`);
    const settling = await q(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'SETTLING'`);
    if (settling.rows[0].n > 1) problems.push(`INVARIANT VIOLATION: ${settling.rows[0].n} SETTLING rows`);
  }
  if (byName.has('status') && byName.has('settlement_started_at')) {
    // A SETTLING cycle always carries its durable freeze timestamp — that is
    // what makes an incomplete/failed settlement observable.
    const unstamped = await q(
      `SELECT count(*)::int AS n FROM apocalypse_cycles
       WHERE status = 'SETTLING' AND settlement_started_at IS NULL`
    );
    if (unstamped.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${unstamped.rows[0].n} SETTLING cycles without settlement_started_at`);
  }
  if (byName.has('status') && byName.has('settled_at')) {
    // settled_at exists exactly on Core-6-settled COMPLETED cycles (legacy
    // pre-Core-6 COMPLETED rows legitimately have it NULL and are exempt).
    const badSettled = await q(
      `SELECT count(*)::int AS n FROM apocalypse_cycles
       WHERE settled_at IS NOT NULL AND status <> 'COMPLETED'`
    );
    if (badSettled.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badSettled.rows[0].n} non-COMPLETED cycles carrying settled_at`);
  }
  if (byName.has('start_time') && byName.has('end_time')) {
    const badWindows = await q(
      `SELECT count(*)::int AS n FROM apocalypse_cycles WHERE end_time <= start_time`
    );
    if (badWindows.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badWindows.rows[0].n} rows with end_time <= start_time`);
  }
}

// --- Core 3: coins.cycle_baseline_price -----------------------------------

async function verifyBaselineColumn(q, problems) {
  const col = await q(
    `SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'coins'
       AND column_name = 'cycle_baseline_price'`
  );
  if (col.rowCount === 0) {
    problems.push('missing column: coins.cycle_baseline_price');
    return;
  }
  if (col.rows[0].data_type !== 'numeric') {
    problems.push(`column coins.cycle_baseline_price: type ${col.rows[0].data_type}, expected numeric`);
  }
  if (col.rows[0].is_nullable !== 'NO') {
    problems.push(`column coins.cycle_baseline_price: nullable=${col.rows[0].is_nullable}, expected NO`);
  }

  const check = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'public.coins'::regclass AND contype = 'c'`
  );
  if (!check.rows.some((r) => /cycle_baseline_price > \(?0/.test(r.def))) {
    problems.push('missing CHECK (cycle_baseline_price > 0) on coins');
  }

  // Live-data invariant: every coin has a usable restoration baseline.
  if (col.rows[0].data_type === 'numeric') {
    const bad = await q(
      `SELECT count(*)::int AS n FROM coins WHERE cycle_baseline_price IS NULL OR cycle_baseline_price <= 0`
    );
    if (bad.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${bad.rows[0].n} coins rows with NULL or non-positive cycle_baseline_price`);
  }
}

// --- Migration 013: canonical coin catalogue --------------------------------

// The player-facing catalogue renamed in place by migration 013. Mapping
// authority: stable coin_id ordering 1..10 onto the documented catalogue
// order. Rows outside ids 1..10 are not part of the canonical catalogue.
const CANONICAL_COIN_CATALOGUE = [
  [1, 'FutureCoin', 'FTR'],
  [2, 'NovaCash', 'NVC'],
  [3, 'Byteon', 'BYT'],
  [4, 'DigitalVault', 'DGV'],
  [5, 'Cybercore', 'CYB'],
  [6, 'BlockNation', 'BLN'],
  [7, 'StellaFortune', 'STF'],
  [8, 'JD Coin', 'JDC'],
  [9, 'MeteorCoin', 'MTC'],
  [10, 'CryptoZen', 'CZN']
];

async function verifyCoinCatalogue(q, problems) {
  const table = await q(`SELECT to_regclass('public.coins') AS reg`);
  if (!table.rows[0].reg) {
    problems.push('table public.coins does not exist');
    return;
  }

  // Migration 014 column shape: retirement semantics underpin the catalogue
  // checks below, so a missing/incompatible column is reported on its own.
  const retiredCol = await q(
    `SELECT data_type, is_nullable FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'coins' AND column_name = 'retired'`
  );
  if (retiredCol.rows.length === 0) {
    problems.push('coins.retired column missing — migration 014 (retire legacy coins) has not been applied');
    return;
  }
  if (retiredCol.rows[0].data_type !== 'boolean' || retiredCol.rows[0].is_nullable !== 'NO') {
    problems.push(`coins.retired has an incompatible shape (type=${retiredCol.rows[0].data_type}, nullable=${retiredCol.rows[0].is_nullable}) — expected boolean NOT NULL`);
  }

  const { rows } = await q('SELECT coin_id, name, symbol, retired FROM coins ORDER BY coin_id');
  const byId = new Map(rows.map((r) => [r.coin_id, r]));

  // Exact canonical identity at each stable coin_id (catches legacy names
  // left behind by an unapplied migration 013, or any drifted identity).
  for (const [id, name, symbol] of CANONICAL_COIN_CATALOGUE) {
    const row = byId.get(id);
    if (!row) {
      problems.push(`canonical coin missing: coin_id ${id} (${name}/${symbol})`);
    } else if (row.name !== name || row.symbol !== symbol) {
      problems.push(`canonical coin_id ${id}: found ${row.name}/${row.symbol}, expected ${name}/${symbol}`);
    } else if (row.retired) {
      problems.push(`canonical coin_id ${id} (${name}/${symbol}) is retired — canonical coins must stay active`);
    }
  }

  // The ACTIVE catalogue is exactly the canonical 10. Extra rows are only
  // tolerated when retired (migration 014's soft-retirement path) — a
  // non-retired extra is still player-facing and is flagged.
  const canonicalIds = new Set(CANONICAL_COIN_CATALOGUE.map(([id]) => id));
  const activeExtras = rows.filter((r) => !r.retired && !canonicalIds.has(r.coin_id));
  if (activeExtras.length > 0) {
    problems.push(`coin catalogue: ${activeExtras.length} non-canonical coin row(s) are not retired (${activeExtras.map((r) => `${r.coin_id}:${r.name}/${r.symbol}`).join(', ')}) — extra rows are player-facing`);
  }

  // Live-data mirror of the coins.symbol UNIQUE constraint.
  const dup = await q(
    `SELECT count(*)::int AS n FROM (
       SELECT symbol FROM coins GROUP BY symbol HAVING count(*) > 1
     ) d`
  );
  if (dup.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${dup.rows[0].n} coin symbols are duplicated`);
}

// --- Core 3: coin_collapse_schedule ----------------------------------------

const EXPECTED_SCHEDULE_COLUMNS = [
  ['schedule_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['coin_id', 'integer', 'NO'],
  ['collapse_rank', 'integer', 'NO'],
  ['scheduled_at', 'timestamp with time zone', 'NO'],
  ['baseline_price', 'numeric', 'NO'],
  ['executed_at', 'timestamp with time zone', 'YES'],
  ['created_at', 'timestamp with time zone', 'NO']
];

async function verifyCollapseSchedule(q, problems) {
  // Table presence.
  const table = await q(`SELECT to_regclass('public.coin_collapse_schedule') AS reg`);
  if (!table.rows[0].reg) {
    problems.push('table public.coin_collapse_schedule does not exist');
    return;
  }

  // Columns: name, type, nullability.
  const cols = await q(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'coin_collapse_schedule'`
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const [name, dtype, nullable] of EXPECTED_SCHEDULE_COLUMNS) {
    const col = byName.get(name);
    if (!col) {
      problems.push(`missing column: coin_collapse_schedule.${name}`);
    } else {
      if (col.data_type !== dtype) problems.push(`column coin_collapse_schedule.${name}: type ${col.data_type}, expected ${dtype}`);
      if (col.is_nullable !== nullable) problems.push(`column coin_collapse_schedule.${name}: nullable=${col.is_nullable}, expected ${nullable}`);
    }
  }

  // Defaults the application depends on.
  const scheduleId = byName.get('schedule_id');
  if (scheduleId && !(scheduleId.column_default || '').startsWith('nextval(')) {
    problems.push('column coin_collapse_schedule.schedule_id: missing sequence default (nextval)');
  }
  const createdAt = byName.get('created_at');
  if (createdAt && !(createdAt.column_default || '').startsWith('now()')) {
    problems.push('column coin_collapse_schedule.created_at: missing default now()');
  }

  // Primary key on schedule_id.
  const pk = await q(
    `SELECT 1 FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema = 'public' AND tc.table_name = 'coin_collapse_schedule'
       AND tc.constraint_type = 'PRIMARY KEY' AND kcu.column_name = 'schedule_id'`
  );
  if (pk.rowCount === 0) problems.push('missing PRIMARY KEY on coin_collapse_schedule.schedule_id');

  // Foreign keys.
  const fks = await q(
    `SELECT pg_get_constraintdef(oid) AS def, confrelid::regclass::text AS target
     FROM pg_constraint
     WHERE conrelid = 'public.coin_collapse_schedule'::regclass AND contype = 'f'`
  );
  if (!fks.rows.some((r) => r.target === 'apocalypse_cycles' && /^FOREIGN KEY \(cycle_id\)/.test(r.def))) {
    problems.push('missing FOREIGN KEY coin_collapse_schedule.cycle_id -> apocalypse_cycles');
  }
  if (!fks.rows.some((r) => r.target === 'coins' && /^FOREIGN KEY \(coin_id\)/.test(r.def))) {
    problems.push('missing FOREIGN KEY coin_collapse_schedule.coin_id -> coins');
  }

  // Unique constraints: one schedule entry per cycle/coin, one rank per cycle.
  const uniques = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'public.coin_collapse_schedule'::regclass AND contype = 'u'`
  );
  const uqDefs = uniques.rows.map((r) => r.def);
  if (!uqDefs.some((d) => /^UNIQUE \(cycle_id, coin_id\)/.test(d))) {
    problems.push('missing UNIQUE constraint on coin_collapse_schedule (cycle_id, coin_id)');
  }
  if (!uqDefs.some((d) => /^UNIQUE \(cycle_id, collapse_rank\)/.test(d))) {
    problems.push('missing UNIQUE constraint on coin_collapse_schedule (cycle_id, collapse_rank)');
  }

  // CHECK constraints.
  const checks = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
     WHERE conrelid = 'public.coin_collapse_schedule'::regclass AND contype = 'c'`
  );
  const defs = checks.rows.map((r) => r.def);
  if (!defs.some((d) => /collapse_rank >= 0/.test(d))) problems.push('missing CHECK (collapse_rank >= 0)');
  if (!defs.some((d) => /baseline_price > \(?0/.test(d))) problems.push('missing CHECK (baseline_price > 0)');
  if (!defs.some((d) => /executed_at IS NULL/.test(d) && /scheduled_at/.test(d))) {
    problems.push('missing CHECK (executed_at IS NULL OR executed_at >= scheduled_at)');
  }

  // Partial due-reconciliation index.
  const idx = await q(
    `SELECT i.indisunique, i.indpred IS NOT NULL AS is_partial,
            pg_get_expr(i.indpred, i.indrelid) AS predicate, a.attname
     FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
     WHERE c.relname = 'idx_coin_collapse_schedule_due'
       AND i.indrelid = 'public.coin_collapse_schedule'::regclass`
  );
  if (idx.rowCount === 0) {
    problems.push('missing index idx_coin_collapse_schedule_due');
  } else {
    const { is_partial, predicate, attname } = idx.rows[0];
    if (!is_partial || attname !== 'scheduled_at' || !/executed_at.*IS NULL/i.test(predicate || '')) {
      problems.push('index idx_coin_collapse_schedule_due is not the expected partial index on (scheduled_at) WHERE executed_at IS NULL');
    }
  }

  // Live-data invariant for the legacy table only (preserved historical
  // rows must remain self-consistent). The ACTIVE/SETTLING death
  // invariants moved to verifyDynamicCollapses with the SIM-13/14 runtime
  // death authority.
  if (byName.has('executed_at') && byName.has('scheduled_at')) {
    const early = await q(
      `SELECT count(*)::int AS n FROM coin_collapse_schedule
       WHERE executed_at IS NOT NULL AND executed_at < scheduled_at`
    );
    if (early.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${early.rows[0].n} collapses executed before their scheduled time`);
  }
}

// --- Wave 4 (SIM-13/14): the dynamic collapse death record ---------------
// apocalypse_coin_collapses: exactly one row per (cycle, coin), written
// only at the moment of death by the dynamic collapse engine. A row's
// existence IS the death record — there are no future-dated rows. The
// ACTIVE/SETTLING zero-price invariants live here (the runtime death rule
// in dynamicCollapseService.getCollapsedCoinIds/isCoinCollapsed).

const EXPECTED_COIN_COLLAPSE_COLUMNS = [
  ['collapse_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['coin_id', 'integer', 'NO'],
  ['collapse_rank', 'integer', 'NO'],
  ['collapsed_at', 'timestamp with time zone', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO']
];

async function verifyDynamicCollapses(q, problems) {
  await verifyCore4Table(q, problems, 'apocalypse_coin_collapses', 'collapse_id', EXPECTED_COIN_COLLAPSE_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id, coin_id\\)', '^UNIQUE \\(cycle_id, collapse_rank\\)'],
    fks: [
      { target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' },
      { target: 'coins', pattern: '^FOREIGN KEY \\(coin_id\\)' }
    ],
    checks: [
      { label: 'collapse_rank >= 0', pattern: 'collapse_rank >= \\(??0' }
    ],
    nowDefaults: ['created_at']
  });

  // Live-data death invariants (only when the table exists AND carries the
  // columns the invariants read — an incompatible stub table must produce
  // shape problems above, not a crash here).
  const reg = await q(`SELECT to_regclass('public.apocalypse_coin_collapses') AS r`);
  if (!reg.rows[0].r) return;
  const cols = await q(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'apocalypse_coin_collapses'
       AND column_name = ANY('{cycle_id,coin_id,collapse_rank,collapsed_at}')`
  );
  if (cols.rows[0].n !== 4) return;
  const cyclesPresent = await q(`SELECT to_regclass('public.apocalypse_cycles') AS reg`);
  if (!cyclesPresent.rows[0].reg) return;
  // A malformed pre-Core-1 stub table can have the right name but no
  // lifecycle columns. Its own shape errors are already reported; never let
  // the dynamic-death data checks turn that into a verifier crash.
  const cycleStatusColumn = await q(
    `SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'apocalypse_cycles'
       AND column_name = 'status'`
  );
  if (cycleStatusColumn.rowCount === 0) return;

  // One death per (cycle, coin) and per (cycle, rank) — the UNIQUE
  // constraints enforce this; the checks catch any historical anomaly.
  const duplicateDeaths = await q(
    `SELECT count(*)::int AS n FROM (
       SELECT cycle_id, coin_id FROM apocalypse_coin_collapses
       GROUP BY cycle_id, coin_id HAVING count(*) > 1
     ) d`
  );
  if (duplicateDeaths.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${duplicateDeaths.rows[0].n} coins with more than one death record in a cycle`);
  const duplicateRanks = await q(
    `SELECT count(*)::int AS n FROM (
       SELECT cycle_id, collapse_rank FROM apocalypse_coin_collapses
       GROUP BY cycle_id, collapse_rank HAVING count(*) > 1
     ) d`
  );
  if (duplicateRanks.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${duplicateRanks.rows[0].n} duplicated collapse execution ranks within a cycle`);

  // Milestone 1: the authoritative live window is ACTIVE **or SETTLING**.
  // A coin collapsed at the end of a round stays £0 through settlement (the
  // freeze window has no ACTIVE cycle), matching the runtime death rule in
  // dynamicCollapseService.getCollapsedCoinIds/isCoinCollapsed.
  // A collapsed coin in the live window must be exactly £0 (never revived).
  const revived = await q(
    `SELECT count(*)::int AS n
     FROM apocalypse_coin_collapses cc
     JOIN apocalypse_cycles ac ON ac.cycle_id = cc.cycle_id
     JOIN coins c ON c.coin_id = cc.coin_id
     WHERE ac.status IN ('ACTIVE', 'SETTLING') AND c.current_price <> 0`
  );
  if (revived.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${revived.rows[0].n} collapsed coins in the ACTIVE/SETTLING cycle have a non-zero live price`);

  // A zero live price must be backed by a persisted death record in the
  // ACTIVE or SETTLING cycle — death is never inferred from price alone,
  // and a mid-settlement £0 (no ACTIVE cycle exists then) is legitimate.
  const unexplained = await q(
    `SELECT count(*)::int AS n FROM coins c
     WHERE c.current_price = 0 AND NOT EXISTS (
       SELECT 1 FROM apocalypse_coin_collapses cc
       JOIN apocalypse_cycles ac ON ac.cycle_id = cc.cycle_id
       WHERE ac.status IN ('ACTIVE', 'SETTLING') AND cc.coin_id = c.coin_id
     )`
  );
  if (unexplained.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${unexplained.rows[0].n} zero-priced coins have no executed collapse row in the ACTIVE/SETTLING cycle`);
}

// --- Core 4: round state (participants / holdings / round transactions) ---

// Generic shape verifier for one Core 4 table: columns (name/type/
// nullability), sequence default on the PK, PK presence, required FK targets
// and required UNIQUE/CHECK constraint definition patterns.
async function verifyCore4Table(q, problems, table, pkColumn, expectedColumns, {
  uniques = [],
  fks = [],
  checks = [],
  nowDefaults = []
}) {
  const present = await q(`SELECT to_regclass('public.${table}') AS reg`);
  if (!present.rows[0].reg) {
    problems.push(`table public.${table} does not exist`);
    return;
  }

  const cols = await q(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${table}'`
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const [name, dtype, nullable] of expectedColumns) {
    const col = byName.get(name);
    if (!col) {
      problems.push(`missing column: ${table}.${name}`);
    } else {
      if (col.data_type !== dtype) problems.push(`column ${table}.${name}: type ${col.data_type}, expected ${dtype}`);
      if (col.is_nullable !== nullable) problems.push(`column ${table}.${name}: nullable=${col.is_nullable}, expected ${nullable}`);
    }
  }

  const pk = byName.get(pkColumn);
  if (pk && !(pk.column_default || '').startsWith('nextval(')) {
    problems.push(`column ${table}.${pkColumn}: missing sequence default (nextval)`);
  }
  for (const name of nowDefaults) {
    const col = byName.get(name);
    if (col && !(col.column_default || '').startsWith('now()')) {
      problems.push(`column ${table}.${name}: missing default now()`);
    }
  }

  const pkCheck = await q(
    `SELECT 1 FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema = 'public' AND tc.table_name = '${table}'
       AND tc.constraint_type = 'PRIMARY KEY' AND kcu.column_name = '${pkColumn}'`
  );
  if (pkCheck.rowCount === 0) problems.push(`missing PRIMARY KEY on ${table}.${pkColumn}`);

  const constraints = await q(
    `SELECT contype, pg_get_constraintdef(oid) AS def, confrelid::regclass::text AS target
     FROM pg_constraint WHERE conrelid = 'public.${table}'::regclass`
  );
  for (const pattern of uniques) {
    if (!constraints.rows.some((r) => r.contype === 'u' && new RegExp(pattern, 'i').test(r.def))) {
      problems.push(`missing UNIQUE constraint on ${table}: ${pattern}`);
    }
  }
  for (const { target, pattern } of fks) {
    if (!constraints.rows.some((r) => r.contype === 'f' && r.target === target && new RegExp(pattern, 'i').test(r.def))) {
      problems.push(`missing FOREIGN KEY on ${table} -> ${target}: ${pattern}`);
    }
  }
  for (const { label, pattern } of checks) {
    if (!constraints.rows.some((r) => r.contype === 'c' && new RegExp(pattern, 'i').test(r.def))) {
      problems.push(`missing CHECK constraint on ${table}: ${label}`);
    }
  }
}

const EXPECTED_PARTICIPANT_COLUMNS = [
  ['participant_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['user_id', 'integer', 'NO'],
  ['joined_at', 'timestamp with time zone', 'NO'],
  ['starting_cash', 'numeric', 'NO'],
  ['current_cash', 'numeric', 'NO'],
  ['peak_wealth', 'numeric', 'NO'],
  ['status', 'character varying', 'NO'],
  ['final_cash', 'numeric', 'YES'],
  ['power', 'integer', 'NO'],
  ['power_updated_at', 'timestamp with time zone', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO'],
  ['updated_at', 'timestamp with time zone', 'NO']
];

const EXPECTED_HOLDING_COLUMNS = [
  ['holding_id', 'integer', 'NO'],
  ['participant_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['user_id', 'integer', 'NO'],
  ['coin_id', 'integer', 'NO'],
  ['quantity', 'numeric', 'NO'],
  ['cost_basis', 'numeric', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO'],
  ['updated_at', 'timestamp with time zone', 'NO']
];

const EXPECTED_ROUND_TX_COLUMNS = [
  ['round_transaction_id', 'integer', 'NO'],
  ['participant_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['user_id', 'integer', 'NO'],
  ['coin_id', 'integer', 'NO'],
  ['type', 'character varying', 'NO'],
  ['quantity', 'numeric', 'NO'],
  ['price', 'numeric', 'NO'],
  ['total_amount', 'numeric', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO']
];

async function verifyRoundState(q, problems) {
  await verifyCore4Table(q, problems, 'apocalypse_participants', 'participant_id', EXPECTED_PARTICIPANT_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id, user_id\\)', '^UNIQUE \\(participant_id, cycle_id, user_id\\)'],
    fks: [
      { target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' },
      { target: 'users', pattern: '^FOREIGN KEY \\(user_id\\)' }
    ],
    checks: [
      { label: 'starting_cash > 0', pattern: 'starting_cash > \\(??0' },
      { label: 'current_cash >= 0', pattern: 'current_cash >= \\(??0' },
      { label: 'peak_wealth >= 0', pattern: 'peak_wealth >= \\(??0' },
      { label: 'power >= 0', pattern: 'power >= \\(??0' },
      { label: "status IN ('ACTIVE', 'FINALIZED')", pattern: 'ACTIVE.*FINALIZED' },
      { label: 'final_cash consistency with status', pattern: 'final_cash IS NULL.*FINALIZED' }
    ],
    nowDefaults: ['joined_at', 'power_updated_at', 'created_at', 'updated_at']
  });

  await verifyCore4Table(q, problems, 'apocalypse_holdings', 'holding_id', EXPECTED_HOLDING_COLUMNS, {
    uniques: ['^UNIQUE \\(participant_id, coin_id\\)'],
    fks: [
      { target: 'apocalypse_participants', pattern: '^FOREIGN KEY \\(participant_id, cycle_id, user_id\\)' },
      { target: 'coins', pattern: '^FOREIGN KEY \\(coin_id\\)' }
    ],
    checks: [
      { label: 'quantity >= 0', pattern: 'quantity >= \\(??0' },
      { label: 'cost_basis >= 0', pattern: 'cost_basis >= \\(??0' }
    ]
  });

  await verifyCore4Table(q, problems, 'apocalypse_transactions', 'round_transaction_id', EXPECTED_ROUND_TX_COLUMNS, {
    fks: [
      { target: 'apocalypse_participants', pattern: '^FOREIGN KEY \\(participant_id, cycle_id, user_id\\)' },
      { target: 'coins', pattern: '^FOREIGN KEY \\(coin_id\\)' }
    ],
    checks: [
      { label: "type IN ('BUY', 'SELL')", pattern: 'BUY.*SELL' },
      { label: 'quantity > 0', pattern: 'quantity > \\(??0' },
      { label: 'price >= 0', pattern: 'price >= \\(??0' },
      { label: 'total_amount >= 0', pattern: 'total_amount >= \\(??0' }
    ],
    nowDefaults: ['created_at']
  });

  // Lookup indexes.
  for (const { name, table } of [
    { name: 'idx_apocalypse_participants_user', table: 'apocalypse_participants' },
    { name: 'idx_apocalypse_holdings_cycle', table: 'apocalypse_holdings' },
    { name: 'idx_apocalypse_transactions_cycle', table: 'apocalypse_transactions' }
  ]) {
    const idx = await q(
      `SELECT 1 FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = '${name}' AND i.indrelid = to_regclass('public.${table}')`
    );
    if (idx.rowCount === 0) problems.push(`missing index ${name}`);
  }

  // Live-data invariants (only evaluated when the tables exist AND carry the
  // columns the invariants read — an incompatible stub table must produce
  // shape problems above, not a crash here).
  const tables = await q(
    `SELECT to_regclass('public.apocalypse_participants') AS p,
            to_regclass('public.apocalypse_holdings') AS h,
            to_regclass('public.apocalypse_transactions') AS t`
  );
  const hasColumns = async (table, names) => {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${table}'
         AND column_name = ANY('{${names.join(',')}}')`
    );
    return rows[0].n === names.length;
  };

  // Migration 012 shape: round-trade quantities are DECIMAL(18,8) —
  // crypto-style fractional coin precision (0.004 JDC trades are exact).
  // Money columns stay DECIMAL(18,2); only quantity carries 8 decimals.
  for (const table of ['apocalypse_holdings', 'apocalypse_transactions']) {
    if (await hasColumns(table, ['quantity'])) {
      const { rows } = await q(
        `SELECT numeric_precision, numeric_scale FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = '${table}' AND column_name = 'quantity'`
      );
      const column = rows[0];
      if (!column || Number(column.numeric_precision) !== 18 || Number(column.numeric_scale) !== 8) {
        problems.push(
          `wrong column type on ${table}: quantity must be DECIMAL(18,8)` +
          (column ? ` (found numeric(${column.numeric_precision},${column.numeric_scale}))` : '')
        );
      }
    }
  }
  if (tables.rows[0].p && await hasColumns('apocalypse_participants', ['cycle_id', 'status', 'final_cash', 'current_cash', 'peak_wealth', 'starting_cash'])) {
    // No participant stays ACTIVE once its cycle is COMPLETED: finalization
    // runs inside the Core 1 lifecycle transaction.
    const staleActive = await q(
      `SELECT count(*)::int AS n FROM apocalypse_participants p
       JOIN apocalypse_cycles ac ON ac.cycle_id = p.cycle_id
       WHERE ac.status = 'COMPLETED' AND p.status = 'ACTIVE'`
    );
    if (staleActive.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${staleActive.rows[0].n} ACTIVE participants on COMPLETED cycles`);

    // FINALIZED rows always carry their final cash; ACTIVE rows never do.
    const badFinal = await q(
      `SELECT count(*)::int AS n FROM apocalypse_participants
       WHERE (status = 'FINALIZED' AND final_cash IS NULL)
          OR (status = 'ACTIVE' AND final_cash IS NOT NULL)`
    );
    if (badFinal.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badFinal.rows[0].n} participants with final_cash inconsistent with status`);

    // Cash and peak can never go negative.
    const negative = await q(
      `SELECT count(*)::int AS n FROM apocalypse_participants
       WHERE current_cash < 0 OR peak_wealth < 0 OR starting_cash <= 0`
    );
    if (negative.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${negative.rows[0].n} participants with negative cash/peak or non-positive starting cash`);
  }
  if (tables.rows[0].h && await hasColumns('apocalypse_holdings', ['quantity'])) {
    const negativeHoldings = await q(
      `SELECT count(*)::int AS n FROM apocalypse_holdings WHERE quantity < 0`
    );
    if (negativeHoldings.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${negativeHoldings.rows[0].n} holdings with negative quantity`);
  }
  // V2-2 (migration 018): stored Power is never negative, and a holding's
  // remaining cost basis is never negative and is exactly £0 once the
  // position is fully closed (a zero-quantity row is history, not value).
  if (tables.rows[0].p && await hasColumns('apocalypse_participants', ['power', 'power_updated_at'])) {
    const badPower = await q(
      `SELECT count(*)::int AS n FROM apocalypse_participants WHERE power < 0`
    );
    if (badPower.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badPower.rows[0].n} participants with negative stored Power`);
  }
  if (tables.rows[0].h && await hasColumns('apocalypse_holdings', ['quantity', 'cost_basis'])) {
    const badBasis = await q(
      `SELECT count(*)::int AS n FROM apocalypse_holdings
       WHERE cost_basis < 0 OR (quantity = 0 AND cost_basis <> 0)`
    );
    if (badBasis.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badBasis.rows[0].n} holdings with negative cost basis or residual basis on a closed position`);
  }
  if (tables.rows[0].t && await hasColumns('apocalypse_transactions', ['quantity', 'price', 'total_amount', 'type'])) {
    const badTx = await q(
      `SELECT count(*)::int AS n FROM apocalypse_transactions
       WHERE quantity <= 0 OR price < 0 OR total_amount < 0 OR type NOT IN ('BUY', 'SELL')`
    );
    if (badTx.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badTx.rows[0].n} round transactions with invalid quantity/price/total/type`);
  }
}

// --- Core 5: bots (users.is_bot, apocalypse_bots, apocalypse_bot_ticks) ---

async function verifyBots(q, problems) {
  // users.is_bot: the persisted public bot marker.
  const { rows: markerCols } = await q(
    `SELECT data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'is_bot'`
  );
  if (markerCols.length === 0) {
    problems.push('missing column: users.is_bot');
  } else {
    const col = markerCols[0];
    if (col.data_type !== 'boolean') problems.push(`column users.is_bot: type ${col.data_type}, expected boolean`);
    if (col.is_nullable !== 'NO') problems.push(`column users.is_bot: nullable=${col.is_nullable}, expected NO`);
    if ((col.column_default || '') !== 'false') {
      problems.push(`column users.is_bot: default ${col.column_default}, expected false`);
    }
  }

  await verifyCore4Table(q, problems, 'apocalypse_bots', 'bot_id', [
    ['bot_id', 'integer', 'NO'],
    ['bot_key', 'character varying', 'NO'],
    ['strategy', 'character varying', 'NO'],
    ['user_id', 'integer', 'NO'],
    ['last_action_at', 'timestamp with time zone', 'YES'],
    ['created_at', 'timestamp with time zone', 'NO']
  ], {
    uniques: ['^UNIQUE \\(bot_key\\)', '^UNIQUE \\(user_id\\)'],
    fks: [{ target: 'users', pattern: '^FOREIGN KEY \\(user_id\\)' }],
    checks: [{ label: 'strategy roster', pattern: 'conservative.*momentum.*dip_buyer.*reckless' }],
    nowDefaults: ['created_at']
  });

  await verifyCore4Table(q, problems, 'apocalypse_bot_ticks', 'tick_pk', [
    ['tick_pk', 'integer', 'NO'],
    ['cycle_id', 'integer', 'NO'],
    ['tick_id', 'bigint', 'NO'],
    ['actions', 'jsonb', 'NO'],
    ['executed_at', 'timestamp with time zone', 'NO']
  ], {
    uniques: ['^UNIQUE \\(cycle_id, tick_id\\)'],
    fks: [{ target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' }],
    checks: [{ label: 'tick_id >= 0', pattern: 'tick_id >= \\(??0' }],
    nowDefaults: ['executed_at']
  });

  // Live-data invariants (only when the tables exist with the columns the
  // invariants read).
  const tables = await q(
    `SELECT to_regclass('public.apocalypse_bots') AS b,
            to_regclass('public.apocalypse_bot_ticks') AS t`
  );
  if (tables.rows[0].b) {
    // Every durable bot identity points at a user actually marked is_bot.
    const { rows: unmarked } = await q(
      `SELECT count(*)::int AS n FROM apocalypse_bots b
       JOIN users u ON u.user_id = b.user_id
       WHERE u.is_bot IS DISTINCT FROM true`
    );
    if (unmarked[0].n > 0) {
      problems.push(`INVARIANT VIOLATION: ${unmarked[0].n} bot identities backed by users without is_bot = true`);
    }
    // Persisted cooldown timestamps can never be in the future.
    const { rows: futureActions } = await q(
      `SELECT count(*)::int AS n FROM apocalypse_bots
       WHERE last_action_at IS NOT NULL AND last_action_at > now()`
    );
    if (futureActions[0].n > 0) {
      problems.push(`INVARIANT VIOLATION: ${futureActions[0].n} bot identities with a future last_action_at`);
    }
  }
  if (tables.rows[0].t) {
    // Tick rows can only ever belong to real cycles (FK-backed) and carry
    // non-negative tick ids (CHECK-backed); verify no orphan claims exist.
    // When apocalypse_cycles is itself absent, the shape problems recorded
    // above are the report — here only the local check remains.
    const cyclesPresent = await q(`SELECT to_regclass('public.apocalypse_cycles') AS reg`);
    const orphans = cyclesPresent.rows[0].reg
      ? await q(
        `SELECT count(*)::int AS n FROM apocalypse_bot_ticks bt
         WHERE NOT EXISTS (SELECT 1 FROM apocalypse_cycles ac WHERE ac.cycle_id = bt.cycle_id)
            OR bt.tick_id < 0`
      )
      : await q('SELECT count(*)::int AS n FROM apocalypse_bot_ticks WHERE tick_id < 0');
    if (orphans.rows[0].n > 0) {
      problems.push(`INVARIANT VIOLATION: ${orphans.rows[0].n} bot tick rows with orphaned cycle or negative tick id`);
    }
  }
}

// --- Issue #18: passive economy (cash-event ledger / tick claims / event
//     schedule) -----------------------------------------------------------

const EXPECTED_CASH_EVENT_COLUMNS = [
  ['cash_event_id', 'integer', 'NO'],
  ['participant_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['user_id', 'integer', 'NO'],
  ['type', 'character varying', 'NO'],
  ['amount', 'numeric', 'NO'],
  ['balance_before', 'numeric', 'NO'],
  ['balance_after', 'numeric', 'NO'],
  ['description', 'character varying', 'NO'],
  ['event_key', 'character varying', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO']
];

const EXPECTED_ECONOMY_TICK_COLUMNS = [
  ['tick_pk', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['kind', 'character varying', 'NO'],
  ['tick_id', 'bigint', 'NO'],
  ['executed_at', 'timestamp with time zone', 'NO']
];

const EXPECTED_ECONOMY_EVENT_COLUMNS = [
  ['event_pk', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['event_key', 'character varying', 'NO'],
  ['scheduled_at', 'timestamp with time zone', 'NO'],
  ['amount', 'numeric', 'NO'],
  ['description', 'character varying', 'NO'],
  ['executed_at', 'timestamp with time zone', 'YES'],
  ['created_at', 'timestamp with time zone', 'NO']
];

async function verifyEconomy(q, problems) {
  await verifyCore4Table(q, problems, 'apocalypse_cash_events', 'cash_event_id', EXPECTED_CASH_EVENT_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id, participant_id, type, event_key\\)'],
    fks: [
      { target: 'apocalypse_participants', pattern: '^FOREIGN KEY \\(participant_id, cycle_id, user_id\\)' }
    ],
    checks: [
      { label: "type IN ('FEE', 'TAX', 'EVENT')", pattern: 'FEE.*TAX.*EVENT' },
      { label: 'amount > 0', pattern: 'amount > \\(??0' },
      { label: 'balance_before >= 0', pattern: 'balance_before >= \\(??0' },
      { label: 'balance_after >= 0', pattern: 'balance_after >= \\(??0' },
      { label: 'balance_after = balance_before - amount', pattern: 'balance_after.*balance_before.*amount' }
    ],
    nowDefaults: ['created_at']
  });

  await verifyCore4Table(q, problems, 'apocalypse_economy_ticks', 'tick_pk', EXPECTED_ECONOMY_TICK_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id, kind, tick_id\\)'],
    fks: [{ target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' }],
    checks: [
      { label: "kind IN ('FEE', 'TAX')", pattern: 'FEE.*TAX' },
      { label: 'tick_id >= 0', pattern: 'tick_id >= \\(??0' }
    ],
    nowDefaults: ['executed_at']
  });

  await verifyCore4Table(q, problems, 'apocalypse_economy_events', 'event_pk', EXPECTED_ECONOMY_EVENT_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id, event_key\\)'],
    fks: [{ target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' }],
    checks: [{ label: 'amount > 0', pattern: 'amount > \\(??0' }],
    nowDefaults: ['created_at']
  });

  // Lookup/due indexes.
  for (const { name, table } of [
    { name: 'idx_apocalypse_cash_events_cycle', table: 'apocalypse_cash_events' },
    { name: 'idx_apocalypse_cash_events_participant', table: 'apocalypse_cash_events' },
    { name: 'idx_apocalypse_economy_events_due', table: 'apocalypse_economy_events' }
  ]) {
    const idx = await q(
      `SELECT 1 FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = '${name}' AND i.indrelid = to_regclass('public.${table}')`
    );
    if (idx.rowCount === 0) problems.push(`missing index ${name}`);
  }

  // Live-data invariants (only when the tables exist AND carry the columns
  // the invariants read — an incompatible stub table must produce shape
  // problems above, not a crash here).
  const tables = await q(
    `SELECT to_regclass('public.apocalypse_cash_events') AS ce,
            to_regclass('public.apocalypse_economy_ticks') AS et,
            to_regclass('public.apocalypse_economy_events') AS ee`
  );
  const hasColumns = async (table, names) => {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${table}'
         AND column_name = ANY('{${names.join(',')}}')`
    );
    return rows[0].n === names.length;
  };

  if (tables.rows[0].ce && await hasColumns('apocalypse_cash_events', ['type', 'amount', 'balance_before', 'balance_after'])) {
    // Every ledger row explains its mutation exactly and is never negative.
    const badLedger = await q(
      `SELECT count(*)::int AS n FROM apocalypse_cash_events
       WHERE amount <= 0 OR balance_before < 0 OR balance_after < 0
          OR balance_after <> balance_before - amount
          OR type NOT IN ('FEE', 'TAX', 'EVENT')`
    );
    if (badLedger.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badLedger.rows[0].n} cash events with invalid amount/balance chain/type`);
  }
  if (tables.rows[0].et && await hasColumns('apocalypse_economy_ticks', ['kind', 'tick_id'])) {
    const badTicks = await q(
      `SELECT count(*)::int AS n FROM apocalypse_economy_ticks
       WHERE tick_id < 0 OR kind NOT IN ('FEE', 'TAX')`
    );
    if (badTicks.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badTicks.rows[0].n} economy tick rows with negative tick id or invalid kind`);
  }
  if (tables.rows[0].ee && await hasColumns('apocalypse_economy_events', ['scheduled_at', 'executed_at', 'amount'])) {
    // An event can never execute before its scheduled instant, and persisted
    // amounts are always positive.
    const badEvents = await q(
      `SELECT count(*)::int AS n FROM apocalypse_economy_events
       WHERE amount <= 0 OR (executed_at IS NOT NULL AND executed_at < scheduled_at)`
    );
    if (badEvents.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badEvents.rows[0].n} economy events with non-positive amount or executed before their scheduled time`);
  }
}

// --- Core 6: settlement results (apocalypse_results + immutability) -------

const EXPECTED_RESULT_COLUMNS = [
  ['result_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['participant_id', 'integer', 'NO'],
  ['user_id', 'integer', 'NO'],
  ['apocalypse_id', 'character varying', 'NO'],
  ['username', 'character varying', 'NO'],
  ['is_bot', 'boolean', 'NO'],
  ['bot_personality', 'character varying', 'YES'],
  ['rank', 'integer', 'NO'],
  ['final_cash', 'numeric', 'NO'],
  ['peak_wealth', 'numeric', 'NO'],
  ['starting_cash', 'numeric', 'NO'],
  ['net_profit', 'numeric', 'NO'],
  ['joined_at', 'timestamp with time zone', 'NO'],
  ['trade_count', 'integer', 'NO'],
  ['buy_count', 'integer', 'NO'],
  ['sell_count', 'integer', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO'],
  // Issue #19: stored generated column — PostgreSQL reports generated
  // columns as is_nullable 'YES' even though the expression over two NOT
  // NULL columns can never yield NULL.
  ['leaderboard_eligible', 'boolean', 'YES']
];

async function verifyResults(q, problems) {
  await verifyCore4Table(q, problems, 'apocalypse_results', 'result_id', EXPECTED_RESULT_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id, participant_id\\)', '^UNIQUE \\(cycle_id, rank\\)'],
    fks: [
      { target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' },
      { target: 'users', pattern: '^FOREIGN KEY \\(user_id\\)' },
      { target: 'apocalypse_participants', pattern: '^FOREIGN KEY \\(participant_id, cycle_id, user_id\\)' }
    ],
    checks: [
      { label: 'rank > 0', pattern: 'rank > \\(??0' },
      { label: 'final_cash >= 0', pattern: 'final_cash >= \\(??0' },
      { label: 'peak_wealth >= 0', pattern: 'peak_wealth >= \\(??0' },
      { label: 'starting_cash > 0', pattern: 'starting_cash > \\(??0' },
      { label: 'net_profit = final_cash - starting_cash', pattern: 'net_profit.*final_cash.*starting_cash' },
      { label: 'bot_personality roster', pattern: 'bot_personality.*conservative.*momentum.*dip_buyer.*reckless' },
      { label: 'trade_count = buy_count + sell_count', pattern: 'trade_count.*buy_count.*sell_count' },
      { label: 'trade_count >= 0', pattern: 'trade_count >= \\(??0' }
    ],
    nowDefaults: ['created_at']
  });

  const present = await q(`SELECT to_regclass('public.apocalypse_results') AS reg`);
  if (!present.rows[0].reg) return; // shape problems already recorded

  // Immutability triggers: UPDATE, DELETE and TRUNCATE must all be blocked
  // by the apocalypse_results_immutable trigger function.
  const triggers = await q(
    `SELECT t.tgname, p.proname AS func
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_proc p ON p.oid = t.tgfoid
     WHERE n.nspname = 'public' AND c.relname = 'apocalypse_results' AND NOT t.tgisinternal`
  );
  for (const name of ['apocalypse_results_no_update', 'apocalypse_results_no_delete', 'apocalypse_results_no_truncate']) {
    const trig = triggers.rows.find((r) => r.tgname === name);
    if (!trig) {
      problems.push(`missing immutability trigger ${name} on apocalypse_results`);
    } else if (trig.func !== 'apocalypse_results_immutable') {
      problems.push(`trigger ${name} on apocalypse_results executes ${trig.func}, expected apocalypse_results_immutable`);
    }
  }

  // Lookup index.
  const idx = await q(
    `SELECT 1 FROM pg_class c
     JOIN pg_index i ON i.indexrelid = c.oid
     WHERE c.relname = 'idx_apocalypse_results_user'
       AND i.indrelid = to_regclass('public.apocalypse_results')`
  );
  if (idx.rowCount === 0) problems.push('missing index idx_apocalypse_results_user');

  // Live-data invariants. Every joined table is to_regclass-guarded first:
  // when a joined table is absent, its own shape problems above are the
  // report and the joined invariant is skipped rather than crashing.
  const joined = await q(
    `SELECT to_regclass('public.apocalypse_cycles') AS c,
            to_regclass('public.apocalypse_participants') AS p`
  );

  // Local-only: net_profit is exactly final_cash - starting_cash.
  const badProfit = await q(
    `SELECT count(*)::int AS n FROM apocalypse_results
     WHERE net_profit <> final_cash - starting_cash`
  );
  if (badProfit.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badProfit.rows[0].n} results with net_profit <> final_cash - starting_cash`);

  // Issue #19: the stored eligibility flag must exactly match the canonical
  // rule final_cash > starting_cash (the generated column guarantees this;
  // the check guards against any historical/manual anomaly). Column-guarded:
  // on a pre-015 schema the missing column is already a shape problem above.
  const hasEligibility = await q(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'apocalypse_results' AND column_name = 'leaderboard_eligible'`
  );
  if (hasEligibility.rows[0].n > 0) {
    const badEligibility = await q(
      `SELECT count(*)::int AS n FROM apocalypse_results
       WHERE leaderboard_eligible IS DISTINCT FROM (final_cash > starting_cash)`
    );
    if (badEligibility.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badEligibility.rows[0].n} results with leaderboard_eligible <> (final_cash > starting_cash)`);
  }

  const badCounts = await q(
    `SELECT count(*)::int AS n FROM apocalypse_results
     WHERE trade_count <> buy_count + sell_count
        OR trade_count < 0 OR buy_count < 0 OR sell_count < 0 OR rank <= 0`
  );
  if (badCounts.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badCounts.rows[0].n} results with inconsistent trade counts or non-positive rank`);

  if (joined.rows[0].c) {
    // A results snapshot can only ever belong to a COMPLETED cycle.
    const wrongCycle = await q(
      `SELECT count(*)::int AS n FROM apocalypse_results r
       JOIN apocalypse_cycles ac ON ac.cycle_id = r.cycle_id
       WHERE ac.status <> 'COMPLETED'`
    );
    if (wrongCycle.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${wrongCycle.rows[0].n} results attached to non-COMPLETED cycles`);

    // Rank uniqueness/completeness per cycle: no duplicate ranks and ranks
    // are exactly 1..N with no gaps (the UNIQUE (cycle_id, rank) constraint
    // is the enforcement; this catches any historical anomaly).
    const badRanks = await q(
      `SELECT count(*)::int AS n FROM (
         SELECT cycle_id FROM apocalypse_results
         GROUP BY cycle_id
         HAVING count(*) <> count(DISTINCT rank)
            OR max(rank) <> count(*) OR min(rank) <> 1
       ) bad`
    );
    if (badRanks.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badRanks.rows[0].n} cycles with duplicate or gapped result ranks`);

    // A Core-6-settled cycle (settled_at stamped) has exactly one result
    // per participant. Legacy pre-Core-6 COMPLETED cycles (settled_at NULL)
    // predate results and are exempt.
    if (joined.rows[0].p) {
      const incomplete = await q(
        `SELECT count(*)::int AS n FROM apocalypse_cycles ac
         WHERE ac.settled_at IS NOT NULL
           AND (SELECT count(*) FROM apocalypse_results r WHERE r.cycle_id = ac.cycle_id)
               <> (SELECT count(*) FROM apocalypse_participants p WHERE p.cycle_id = ac.cycle_id)`
      );
      if (incomplete.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${incomplete.rows[0].n} settled cycles whose result count differs from their participant count`);
    }
  }
}

// --- V2-1: price precision (migration 017) ----------------------------------
// Every column the V2 cyclical market writes per-unit coin prices into must
// persist 4 decimal places (money columns stay at 2dp). Each table is
// guarded independently so a missing table is reported, not crashed on.
const V2_PRICE_PRECISION_COLUMNS = [
  ['coins', 'current_price'],
  ['coins', 'cycle_baseline_price'],
  ['coin_collapse_schedule', 'baseline_price'],
  ['price_history', 'price'],
  ['market_history', 'total_value'],
  ['apocalypse_transactions', 'price'],
  ['transactions', 'price'],
  ['portfolios', 'average_purchase_price'],
  ['coin_statistics', 'all_time_high'],
  ['coin_statistics', 'all_time_low']
];

async function verifyV2PricePrecision(q, problems) {
  for (const [table, column] of V2_PRICE_PRECISION_COLUMNS) {
    const reg = await q(`SELECT to_regclass($1) AS r`, [`public.${table}`]);
    if (!reg.rows[0].r) {
      problems.push(`missing table (V2 price precision check): ${table}`);
      continue;
    }
    const col = await q(
      `SELECT data_type, numeric_scale FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
      [table, column]
    );
    if (col.rows.length === 0) {
      problems.push(`missing column (V2 price precision check): ${table}.${column}`);
      continue;
    }
    if (col.rows[0].data_type !== 'numeric' || col.rows[0].numeric_scale !== 4) {
      problems.push(`column ${table}.${column}: type ${col.rows[0].data_type} scale ${col.rows[0].numeric_scale}, expected numeric scale 4 (migration 017)`);
    }
  }
}

// --- Apocalypse Monitor foundation: price_history provenance (migration 019)
// Nullable cycle_id FK to apocalypse_cycles, nullable source provenance tag
// (MARKET_TICK/COLLAPSE; NULL for legacy rows), and the monitor read index.
// Legacy NULL rows are valid forever — the invariant checks only constrain
// rows that carry a source tag.
async function verifyPriceHistoryProvenance(q, problems) {
  const reg = await q(`SELECT to_regclass('public.price_history') AS r`);
  if (!reg.rows[0].r) {
    problems.push('missing table (price_history provenance check): price_history');
    return;
  }

  const cycleId = await q(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'price_history' AND column_name = 'cycle_id'`
  );
  if (cycleId.rows.length === 0) {
    problems.push('missing column (price_history provenance check): price_history.cycle_id');
  } else if (cycleId.rows[0].data_type !== 'integer' || cycleId.rows[0].is_nullable !== 'YES') {
    problems.push(`column price_history.cycle_id: type ${cycleId.rows[0].data_type} nullable ${cycleId.rows[0].is_nullable}, expected integer NULL (migration 019)`);
  }

  const fk = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.price_history'::regclass AND contype = 'f'
        AND conname = 'price_history_cycle_id_fkey'`
  );
  if (fk.rows.length === 0) {
    problems.push('missing constraint (migration 019): price_history_cycle_id_fkey');
  } else if (fk.rows[0].def !== 'FOREIGN KEY (cycle_id) REFERENCES apocalypse_cycles(cycle_id)') {
    problems.push(`constraint price_history_cycle_id_fkey: ${fk.rows[0].def}, expected FOREIGN KEY (cycle_id) REFERENCES apocalypse_cycles(cycle_id)`);
  }

  const source = await q(
    `SELECT data_type, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'price_history' AND column_name = 'source'`
  );
  if (source.rows.length === 0) {
    problems.push('missing column (price_history provenance check): price_history.source');
  } else if (source.rows[0].data_type !== 'character varying' || source.rows[0].is_nullable !== 'YES') {
    problems.push(`column price_history.source: type ${source.rows[0].data_type} nullable ${source.rows[0].is_nullable}, expected varchar NULL (migration 019)`);
  }

  const check = await q(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'public.price_history'::regclass AND contype = 'c'
        AND conname = 'price_history_source_allowed'`
  );
  if (check.rows.length === 0) {
    problems.push('missing constraint (migration 019): price_history_source_allowed');
  } else if (!check.rows[0].def.includes('MARKET_TICK') || !check.rows[0].def.includes('COLLAPSE')) {
    problems.push(`constraint price_history_source_allowed: ${check.rows[0].def}, expected CHECK admitting MARKET_TICK/COLLAPSE`);
  }

  const index = await q(
    `SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'price_history'
        AND indexname = 'idx_price_history_cycle_coin_created'`
  );
  if (index.rows.length === 0) {
    problems.push('missing index (migration 019): idx_price_history_cycle_coin_created');
  } else if (!index.rows[0].indexdef.includes('(cycle_id, coin_id, created_at)')) {
    problems.push(`index idx_price_history_cycle_coin_created: ${index.rows[0].indexdef}, expected (cycle_id, coin_id, created_at)`);
  }

  // Live-data invariants (local-only, no joins): persistent-world ticks are
  // world-scoped and intentionally use source MARKET_TICK with cycle_id NULL;
  // Apocalypse/cycle-owned rows carry a non-NULL cycle id. A COLLAPSE row is
  // always the £0 transition and remains cycle-owned. Legacy NULL rows are
  // exempt from both provenance checks.
  const badCollapseProvenance = await q(
    `SELECT count(*)::int AS n FROM price_history
      WHERE source = 'COLLAPSE' AND cycle_id IS NULL`
  );
  if (badCollapseProvenance.rows[0].n > 0) {
    problems.push(`INVARIANT VIOLATION: ${badCollapseProvenance.rows[0].n} COLLAPSE rows with NULL cycle_id; COLLAPSE provenance requires a non-NULL cycle_id`);
  }

  const badCollapse = await q(
    `SELECT count(*)::int AS n FROM price_history
      WHERE source = 'COLLAPSE' AND price <> 0`
  );
  if (badCollapse.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badCollapse.rows[0].n} COLLAPSE price_history rows with non-zero price`);
}

// --- Wave 1 (SIM-03/04/05): cycle-scoped coin events + market phases ------
// apocalypse_coin_events: the persisted deterministic per-coin event
// schedule (0-5 active per coin, seeded from the cycle's Core 1 seed, never
// rerolled; expiry is purely time-based and rows are immutable).
// apocalypse_market_phases: the persisted primary market-phase chain —
// exactly one phase covers any instant (contiguous chain, one row per
// (cycle_id, phase_seq)). Both tables are internal-only in Wave 1.

const EXPECTED_COIN_EVENT_COLUMNS = [
  ['event_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['coin_id', 'integer', 'NO'],
  ['event_seq', 'integer', 'NO'],
  ['name', 'character varying', 'NO'],
  ['direction', 'character varying', 'NO'],
  ['strength_category', 'character varying', 'NO'],
  ['modifier', 'numeric', 'NO'],
  ['starts_at', 'timestamp with time zone', 'NO'],
  ['ends_at', 'timestamp with time zone', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO']
];

const EXPECTED_MARKET_PHASE_COLUMNS = [
  ['phase_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['phase_seq', 'integer', 'NO'],
  ['phase', 'character varying', 'NO'],
  ['lifecycle_state', 'character varying', 'NO'],
  ['modifier', 'numeric', 'NO'],
  ['starts_at', 'timestamp with time zone', 'NO'],
  ['ends_at', 'timestamp with time zone', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO']
];

async function verifyCoinEventsAndMarketPhases(q, problems) {
  await verifyCore4Table(q, problems, 'apocalypse_coin_events', 'event_id', EXPECTED_COIN_EVENT_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id, coin_id, event_seq\\)'],
    fks: [
      { target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' },
      { target: 'coins', pattern: '^FOREIGN KEY \\(coin_id\\)' }
    ],
    checks: [
      { label: "direction IN ('POSITIVE', 'NEGATIVE')", pattern: 'direction.*POSITIVE.*NEGATIVE' },
      { label: "strength_category IN ('MINOR', 'MODERATE', 'MAJOR', 'EXTREME')", pattern: 'MINOR.*MODERATE.*MAJOR.*EXTREME' },
      { label: 'event_seq >= 1', pattern: 'event_seq >= \\(??1' },
      { label: 'ends_at > starts_at', pattern: 'ends_at > starts_at' },
      { label: 'modifier sign matches direction', pattern: 'POSITIVE.*modifier' }
    ],
    nowDefaults: ['created_at']
  });

  await verifyCore4Table(q, problems, 'apocalypse_market_phases', 'phase_id', EXPECTED_MARKET_PHASE_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id, phase_seq\\)'],
    fks: [{ target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' }],
    checks: [
      { label: "phase IN ('GOLDEN_AGE', 'BOOM', 'BULL', 'BEAR', 'BUST', 'RECESSION')", pattern: 'GOLDEN_AGE.*BOOM.*BULL.*BEAR.*BUST.*RECESSION' },
      { label: "lifecycle_state IN ('GROWTH', 'PLATEAU', 'DECLINE', 'COLLAPSE')", pattern: 'GROWTH.*PLATEAU.*DECLINE.*COLLAPSE' },
      { label: 'phase_seq >= 1', pattern: 'phase_seq >= \\(??1' },
      { label: 'ends_at > starts_at', pattern: 'ends_at > starts_at' },
      { label: 'modifier sign matches phase group', pattern: 'GOLDEN_AGE.*modifier' }
    ],
    nowDefaults: ['created_at']
  });

  // Lookup indexes.
  for (const { name, table } of [
    { name: 'idx_apocalypse_coin_events_active', table: 'apocalypse_coin_events' },
    { name: 'idx_apocalypse_market_phases_active', table: 'apocalypse_market_phases' }
  ]) {
    const idx = await q(
      `SELECT 1 FROM pg_class c
       JOIN pg_index i ON i.indexrelid = c.oid
       WHERE c.relname = '${name}' AND i.indrelid = to_regclass('public.${table}')`
    );
    if (idx.rowCount === 0) problems.push(`missing index ${name}`);
  }

  // Live-data invariants (only when the tables exist AND carry the columns
  // the invariants read — an incompatible stub table must produce shape
  // problems above, not a crash here).
  const tables = await q(
    `SELECT to_regclass('public.apocalypse_coin_events') AS ce,
            to_regclass('public.apocalypse_market_phases') AS mp`
  );
  const hasColumns = async (table, names) => {
    const { rows } = await q(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = '${table}'
         AND column_name = ANY('{${names.join(',')}}')`
    );
    return rows[0].n === names.length;
  };

  if (tables.rows[0].ce && await hasColumns('apocalypse_coin_events', ['event_id', 'cycle_id', 'coin_id', 'direction', 'modifier', 'starts_at', 'ends_at'])) {
    // Every event is well-formed: positive window, sign matching direction.
    const badEvents = await q(
      `SELECT count(*)::int AS n FROM apocalypse_coin_events
       WHERE ends_at <= starts_at
          OR (direction = 'POSITIVE' AND modifier <= 0)
          OR (direction = 'NEGATIVE' AND modifier >= 0)`
    );
    if (badEvents.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badEvents.rows[0].n} coin events with inverted window or direction/modifier sign mismatch`);

    // The 0-5 active-per-coin cap: no instant may have more than the
    // configured maximum concurrent events for one coin. Concurrency only
    // changes at event boundaries, so measuring at each event's starts_at
    // is exact.
    const cap = resolveSimulationConfig().coinEvents.maxActivePerCoin;
    const overCap = await q(
      `SELECT count(*)::int AS n FROM (
         SELECT e1.event_id
         FROM apocalypse_coin_events e1
         JOIN apocalypse_coin_events e2
           ON e2.cycle_id = e1.cycle_id AND e2.coin_id = e1.coin_id
          AND e2.starts_at <= e1.starts_at AND e2.ends_at > e1.starts_at
         GROUP BY e1.event_id
         HAVING count(*) > ${cap}
       ) d`
    );
    if (overCap.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${overCap.rows[0].n} coin events overlap more than the configured ${cap}-event active cap`);
  }

  if (tables.rows[0].mp && await hasColumns('apocalypse_market_phases', ['phase_id', 'cycle_id', 'phase_seq', 'phase', 'modifier', 'starts_at', 'ends_at'])) {
    // Every phase row is well-formed: positive window, sign matching group.
    const badPhases = await q(
      `SELECT count(*)::int AS n FROM apocalypse_market_phases
       WHERE ends_at <= starts_at
          OR (phase IN ('GOLDEN_AGE', 'BOOM', 'BULL') AND modifier <= 0)
          OR (phase IN ('BEAR', 'BUST', 'RECESSION') AND modifier >= 0)`
    );
    if (badPhases.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badPhases.rows[0].n} market phases with inverted window or phase/modifier sign mismatch`);

    // One-primary invariant: two phases of the same cycle may never
    // overlap in time.
    const overlaps = await q(
      `SELECT count(*)::int AS n FROM apocalypse_market_phases a
       JOIN apocalypse_market_phases b
         ON b.cycle_id = a.cycle_id AND a.phase_id < b.phase_id
        AND a.starts_at < b.ends_at AND b.starts_at < a.ends_at`
    );
    if (overlaps.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${overlaps.rows[0].n} overlapping market-phase pairs (one primary phase per cycle at a time)`);
  }
}

// --- Wave 2 (SIM-06/07): durable per-cycle market state -------------------
// apocalypse_market_state: exactly one row per cycle carrying the
// deterministic market index, the monotonic peak and its timestamp, the
// drawdown, the recent momentum, the hidden lifecycle state and the
// per-cycle generated plateau target. Internal-only in Wave 2.

const EXPECTED_MARKET_STATE_COLUMNS = [
  ['state_id', 'integer', 'NO'],
  ['cycle_id', 'integer', 'NO'],
  ['starting_index', 'numeric', 'NO'],
  ['current_index', 'numeric', 'NO'],
  ['peak_index', 'numeric', 'NO'],
  ['peak_at', 'timestamp with time zone', 'NO'],
  ['drawdown', 'numeric', 'NO'],
  ['momentum', 'numeric', 'NO'],
  ['lifecycle_state', 'character varying', 'NO'],
  ['plateau_target', 'numeric', 'NO'],
  ['last_evaluated_at', 'timestamp with time zone', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO'],
  ['updated_at', 'timestamp with time zone', 'NO']
];

async function verifyMarketState(q, problems) {
  await verifyCore4Table(q, problems, 'apocalypse_market_state', 'state_id', EXPECTED_MARKET_STATE_COLUMNS, {
    uniques: ['^UNIQUE \\(cycle_id\\)'],
    fks: [{ target: 'apocalypse_cycles', pattern: '^FOREIGN KEY \\(cycle_id\\)' }],
    checks: [
      { label: "lifecycle_state IN ('GROWTH', 'PLATEAU', 'DECLINE', 'COLLAPSE')", pattern: 'GROWTH.*PLATEAU.*DECLINE.*COLLAPSE' },
      { label: 'non-negative index values', pattern: 'starting_index >= \\(??0' },
      { label: 'peak monotonicity (peak >= starting, peak >= current)', pattern: 'peak_index >= starting_index' },
      { label: 'peak covers the current index', pattern: 'peak_index >= current_index' },
      { label: 'drawdown in [0, 1]', pattern: 'drawdown >= \\(??0' },
      { label: 'momentum bounded below at -1', pattern: "momentum >= .*'-1'" },
      { label: 'plateau target never below the starting index', pattern: 'plateau_target >= starting_index' }
    ],
    nowDefaults: ['created_at', 'updated_at']
  });

  // Live-data invariants (only when the table exists AND carries the
  // columns the invariants read — an incompatible stub table must produce
  // shape problems above, not a crash here).
  const reg = await q(`SELECT to_regclass('public.apocalypse_market_state') AS r`);
  if (!reg.rows[0].r) return;
  const cols = await q(
    `SELECT count(*)::int AS n FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'apocalypse_market_state'
       AND column_name = ANY('{starting_index,current_index,peak_index,drawdown,momentum,lifecycle_state,plateau_target}')`
  );
  if (cols.rows[0].n !== 7) return;

  // Every row is well-formed: non-negative finite-stored values, drawdown in
  // [0, 1], momentum >= -1, monotonic peak, target at/above the start.
  const badRows = await q(
    `SELECT count(*)::int AS n FROM apocalypse_market_state
     WHERE starting_index < 0 OR current_index < 0 OR peak_index < 0 OR plateau_target < 0
        OR drawdown < 0 OR drawdown > 1
        OR momentum < -1
        OR peak_index < starting_index OR peak_index < current_index
        OR plateau_target < starting_index`
  );
  if (badRows.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badRows.rows[0].n} market-state rows with negative values, out-of-range drawdown/momentum, a non-monotonic peak, or a plateau target below the starting index`);

  // One state row per cycle (the UNIQUE constraint enforces this; the check
  // catches any historical anomaly).
  const duplicates = await q(
    `SELECT count(*)::int AS n FROM (
       SELECT cycle_id FROM apocalypse_market_state
       GROUP BY cycle_id HAVING count(*) > 1
     ) d`
  );
  if (duplicates.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${duplicates.rows[0].n} cycles with more than one market-state row`);
}

// --- Persistent-market Stage 1: per-coin pricing checkpoints -------------
// market_price_checkpoints: exactly one row per (coin_id, seed) — the latest
// resumable pricing accumulator for one coin on one deterministic market
// timeline. Accumulator doubles are float8 (IEEE 754 binary64, exact
// node-pg round-trip), millisecond positions are bigint, and the CHECK
// constraints make structurally impossible accumulator state unwritable.

const EXPECTED_PRICE_CHECKPOINT_COLUMNS = [
  ['coin_id', 'integer', 'NO'],
  ['seed', 'text', 'NO'],
  ['checkpoint_ms', 'bigint', 'NO'],
  ['domain_cycle_index', 'integer', 'NO'],
  ['domain_cycle_start_ms', 'double precision', 'NO'],
  ['domain_anchor', 'double precision', 'NO'],
  ['domain_boundary', 'double precision', 'NO'],
  ['crash_episode_index', 'integer', 'NO'],
  ['crash_cursor_ms', 'double precision', 'NO'],
  ['crash_factor', 'double precision', 'NO'],
  ['activation_context', 'text', 'NO'],
  ['created_at', 'timestamp with time zone', 'NO'],
  ['updated_at', 'timestamp with time zone', 'NO']
];

async function verifyPricingCheckpoints(q, problems) {
  const table = 'market_price_checkpoints';
  const present = await q(`SELECT to_regclass('public.${table}') AS reg`);
  if (!present.rows[0].reg) {
    problems.push(`table public.${table} does not exist`);
    return;
  }

  const cols = await q(
    `SELECT column_name, data_type, is_nullable, column_default
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${table}'`
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const [name, dtype, nullable] of EXPECTED_PRICE_CHECKPOINT_COLUMNS) {
    const col = byName.get(name);
    if (!col) {
      problems.push(`missing column: ${table}.${name}`);
    } else {
      if (col.data_type !== dtype) problems.push(`column ${table}.${name}: type ${col.data_type}, expected ${dtype}`);
      if (col.is_nullable !== nullable) problems.push(`column ${table}.${name}: nullable=${col.is_nullable}, expected ${nullable}`);
    }
  }
  for (const name of ['created_at', 'updated_at']) {
    const col = byName.get(name);
    if (col && !(col.column_default || '').startsWith('now()')) {
      problems.push(`column ${table}.${name}: missing default now()`);
    }
  }

  // Composite PRIMARY KEY (coin_id, seed) — one accumulator per coin per
  // timeline, the idempotency backstop for batch replay.
  const pk = await q(
    `SELECT kcu.column_name FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON tc.constraint_name = kcu.constraint_name
      AND tc.table_schema = kcu.table_schema
      AND tc.table_name = kcu.table_name
     WHERE tc.table_schema = 'public' AND tc.table_name = '${table}'
       AND tc.constraint_type = 'PRIMARY KEY'
     ORDER BY kcu.ordinal_position`
  );
  const pkCols = pk.rows.map((r) => r.column_name);
  if (pkCols.length !== 2 || pkCols[0] !== 'coin_id' || pkCols[1] !== 'seed') {
    problems.push(`missing PRIMARY KEY on ${table}(coin_id, seed)`);
  }

  const constraints = await q(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def, confrelid::regclass::text AS target
     FROM pg_constraint WHERE conrelid = 'public.${table}'::regclass`
  );
  if (!constraints.rows.some((r) => r.contype === 'f' && r.target === 'coins' && /^FOREIGN KEY \(coin_id\)/i.test(r.def))) {
    problems.push(`missing FOREIGN KEY on ${table} -> coins (coin_id)`);
  }
  const expectedCheckNames = [
    'market_price_checkpoints_time_nonneg',
    'market_price_checkpoints_cycle_index_nonneg',
    'market_price_checkpoints_anchor_positive',
    'market_price_checkpoints_boundary_positive',
    'market_price_checkpoints_episode_index_positive',
    'market_price_checkpoints_factor_positive'
  ];
  for (const name of expectedCheckNames) {
    if (!constraints.rows.some((r) => r.contype === 'c' && r.conname === name)) {
      problems.push(`missing CHECK constraint on ${table}: ${name}`);
    }
  }
}

// --- Persistent-market Stage 2: world identity + per-coin market state ---
// market_worlds: the explicit persistent-world identity (one ACTIVE world
// at most, enforced by the partial unique index). market_coin_state: the
// separate per-coin persistent state (bidirectional bounded condition,
// positive structural reference, positive decaying peak reference,
// explicit permanent timestamped death).

async function verifyPersistentWorld(q, problems) {
  // market_worlds shape.
  const worldsReg = await q(`SELECT to_regclass('public.market_worlds') AS reg`);
  if (!worldsReg.rows[0].reg) {
    problems.push('table public.market_worlds does not exist');
  } else {
    const cols = await q(
      `SELECT column_name, data_type, is_nullable, column_default
       FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'market_worlds'`
    );
    const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
    for (const [name, dtype, nullable] of [
      ['world_id', 'integer', 'NO'],
      ['version', 'integer', 'NO'],
      ['seed', 'text', 'NO'],
      ['epoch_started_at', 'timestamp with time zone', 'NO'],
      ['active', 'boolean', 'NO'],
      ['created_at', 'timestamp with time zone', 'NO']
    ]) {
      const col = byName.get(name);
      if (!col) {
        problems.push(`missing column: market_worlds.${name}`);
      } else {
        if (col.data_type !== dtype) problems.push(`column market_worlds.${name}: type ${col.data_type}, expected ${dtype}`);
        if (col.is_nullable !== nullable) problems.push(`column market_worlds.${name}: nullable=${col.is_nullable}, expected ${nullable}`);
      }
    }
    const idCol = byName.get('world_id');
    if (idCol && !(idCol.column_default || '').startsWith('nextval(')) {
      problems.push('column market_worlds.world_id: missing sequence default (nextval)');
    }
    const createdCol = byName.get('created_at');
    if (createdCol && !(createdCol.column_default || '').startsWith('now()')) {
      problems.push('column market_worlds.created_at: missing default now()');
    }
    // Exactly one ACTIVE world at most — the partial unique index.
    const idx = await q(
      `SELECT c.relname, i.indisunique, pg_get_indexdef(i.indexrelid) AS def
         FROM pg_class c
         JOIN pg_index i ON i.indexrelid = c.oid
        WHERE c.relname = 'market_worlds_single_active'
          AND i.indrelid = 'public.market_worlds'::regclass`
    );
    if (idx.rowCount === 0 || !idx.rows[0].indisunique || !/WHERE active/i.test(idx.rows[0].def || '')) {
      problems.push('missing partial unique index market_worlds_single_active (one ACTIVE world at most)');
    }
    // Live-data invariant: never more than one active world.
    const active = await q(`SELECT count(*)::int AS n FROM market_worlds WHERE active`);
    if (active.rows[0].n > 1) problems.push(`INVARIANT VIOLATION: ${active.rows[0].n} active market worlds (single-economy invariant broken)`);
  }

  // market_coin_state shape + constraints.
  const stateReg = await q(`SELECT to_regclass('public.market_coin_state') AS reg`);
  if (!stateReg.rows[0].reg) {
    problems.push('table public.market_coin_state does not exist');
    return;
  }
  const cols = await q(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'market_coin_state'`
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const [name, dtype, nullable] of [
    ['coin_id', 'integer', 'NO'],
    ['world_id', 'integer', 'NO'],
    ['archetype', 'text', 'NO'],
    ['condition', 'double precision', 'NO'],
    ['structural_reference', 'double precision', 'NO'],
    ['peak_reference', 'double precision', 'NO'],
    ['status', 'text', 'NO'],
    ['died_at', 'timestamp with time zone', 'YES'],
    ['created_at', 'timestamp with time zone', 'NO'],
    ['updated_at', 'timestamp with time zone', 'NO']
  ]) {
    const col = byName.get(name);
    if (!col) {
      problems.push(`missing column: market_coin_state.${name}`);
    } else {
      if (col.data_type !== dtype) problems.push(`column market_coin_state.${name}: type ${col.data_type}, expected ${dtype}`);
      if (col.is_nullable !== nullable) problems.push(`column market_coin_state.${name}: nullable=${col.is_nullable}, expected ${nullable}`);
    }
  }
  const constraints = await q(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def, confrelid::regclass::text AS target
     FROM pg_constraint WHERE conrelid = 'public.market_coin_state'::regclass`
  );
  for (const name of [
    'market_coin_state_condition_bounded',
    'market_coin_state_structural_positive',
    'market_coin_state_peak_positive',
    'market_coin_state_status_known',
    'market_coin_state_death_consistent'
  ]) {
    if (!constraints.rows.some((r) => r.contype === 'c' && r.conname === name)) {
      problems.push(`missing CHECK constraint on market_coin_state: ${name}`);
    }
  }
  for (const { target, column } of [
    { target: 'coins', column: 'coin_id' },
    { target: 'market_worlds', column: 'world_id' }
  ]) {
    if (!constraints.rows.some((r) => r.contype === 'f' && r.target === target && new RegExp(`^FOREIGN KEY \\(${column}\\)`, 'i').test(r.def))) {
      problems.push(`missing FOREIGN KEY on market_coin_state -> ${target} (${column})`);
    }
  }
  // Live-data invariants: death is always explicit and timestamped (the
  // CHECK enforces it structurally; the query guards historical anomalies).
  const deadWithoutTime = await q(
    `SELECT count(*)::int AS n FROM market_coin_state WHERE status = 'DEAD' AND died_at IS NULL`
  );
  if (deadWithoutTime.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${deadWithoutTime.rows[0].n} DEAD coin states without died_at`);
}

// --- Persistent-market Stage 3: world-level Market Director state ---
// market_director_state: exactly one authoritative Director cursor per
// world (current public regime, regime timing, bounded intensity, monotone
// chain index).

async function verifyMarketDirectorState(q, problems) {
  const reg = await q(`SELECT to_regclass('public.market_director_state') AS reg`);
  if (!reg.rows[0].reg) {
    problems.push('table public.market_director_state does not exist');
    return;
  }
  const cols = await q(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'market_director_state'`
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const [name, dtype, nullable] of [
    ['world_id', 'integer', 'NO'],
    ['regime', 'text', 'NO'],
    ['regime_started_at', 'timestamp with time zone', 'NO'],
    ['intensity', 'double precision', 'NO'],
    ['regime_index', 'integer', 'NO'],
    ['created_at', 'timestamp with time zone', 'NO'],
    ['updated_at', 'timestamp with time zone', 'NO']
  ]) {
    const col = byName.get(name);
    if (!col) {
      problems.push(`missing column: market_director_state.${name}`);
    } else {
      if (col.data_type !== dtype) problems.push(`column market_director_state.${name}: type ${col.data_type}, expected ${dtype}`);
      if (col.is_nullable !== nullable) problems.push(`column market_director_state.${name}: nullable=${col.is_nullable}, expected ${nullable}`);
    }
  }
  const constraints = await q(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def, confrelid::regclass::text AS target
     FROM pg_constraint WHERE conrelid = 'public.market_director_state'::regclass`
  );
  for (const name of [
    'market_director_state_regime_known',
    'market_director_state_intensity_bounded',
    'market_director_state_regime_index_nonneg'
  ]) {
    if (!constraints.rows.some((r) => r.contype === 'c' && r.conname === name)) {
      problems.push(`missing CHECK constraint on market_director_state: ${name}`);
    }
  }
  if (!constraints.rows.some((r) => r.contype === 'f' && r.target === 'market_worlds' && /^FOREIGN KEY \(world_id\)/i.test(r.def))) {
    problems.push('missing FOREIGN KEY on market_director_state -> market_worlds (world_id)');
  }
  const pk = await q(
    `SELECT count(*)::int AS n FROM information_schema.table_constraints
     WHERE table_schema = 'public' AND table_name = 'market_director_state' AND constraint_type = 'PRIMARY KEY'`
  );
  if (pk.rows[0].n !== 1) problems.push('missing primary key on market_director_state (world_id)');
}

// ---------------------------------------------------------------------------
// Persistent economy (migration 026): persistent_accounts / _holdings /
// _transactions — the ONE writable persistent gameplay economy.
// ---------------------------------------------------------------------------
async function verifyPersistentEconomyTable(q, problems, table, expected, requiredConstraints) {
  const reg = await q(`SELECT to_regclass('public.${table}') AS reg`);
  if (!reg.rows[0].reg) {
    problems.push(`table public.${table} does not exist`);
    return;
  }
  const cols = await q(
    `SELECT column_name, data_type, is_nullable
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = '${table}'`
  );
  const byName = new Map(cols.rows.map((r) => [r.column_name, r]));
  for (const [name, dtype, nullable] of expected) {
    const col = byName.get(name);
    if (!col) {
      problems.push(`missing column: ${table}.${name}`);
    } else {
      if (col.data_type !== dtype) problems.push(`column ${table}.${name}: type ${col.data_type}, expected ${dtype}`);
      if (col.is_nullable !== nullable) problems.push(`column ${table}.${name}: nullable=${col.is_nullable}, expected ${nullable}`);
    }
  }
  const constraints = await q(
    `SELECT conname, contype, pg_get_constraintdef(oid) AS def, confrelid::regclass::text AS target
     FROM pg_constraint WHERE conrelid = 'public.${table}'::regclass`
  );
  for (const check of requiredConstraints) {
    if (!constraints.rows.some((r) => check(r))) {
      problems.push(`missing constraint on ${table}: ${check.describe}`);
    }
  }
}

async function verifyPersistentEconomy(q, problems) {
  const TS = 'timestamp with time zone';
  await verifyPersistentEconomyTable(q, problems, 'persistent_accounts', [
    ['account_id', 'integer', 'NO'],
    ['world_id', 'integer', 'NO'],
    ['user_id', 'integer', 'NO'],
    ['starting_cash', 'numeric', 'NO'],
    ['cash', 'numeric', 'NO'],
    ['debt', 'numeric', 'NO'],
    ['provisioned_at', TS, 'NO'],
    ['created_at', TS, 'NO'],
    ['updated_at', TS, 'NO']
  ], [
    Object.assign((r) => r.contype === 'p', { describe: 'primary key (account_id)' }),
    Object.assign((r) => r.contype === 'u' && /UNIQUE \(world_id, user_id\)/i.test(r.def), { describe: 'UNIQUE (world_id, user_id)' }),
    Object.assign((r) => r.contype === 'c' && /cash >= \(?0/.test(r.def), { describe: 'CHECK cash >= 0' }),
    Object.assign((r) => r.contype === 'c' && /debt >= \(?0/.test(r.def), { describe: 'CHECK debt >= 0' }),
    Object.assign((r) => r.contype === 'f' && r.target === 'market_worlds', { describe: 'FOREIGN KEY -> market_worlds' }),
    Object.assign((r) => r.contype === 'f' && r.target === 'users', { describe: 'FOREIGN KEY -> users' })
  ]);
  await verifyPersistentEconomyTable(q, problems, 'persistent_holdings', [
    ['holding_id', 'integer', 'NO'],
    ['account_id', 'integer', 'NO'],
    ['world_id', 'integer', 'NO'],
    ['user_id', 'integer', 'NO'],
    ['coin_id', 'integer', 'NO'],
    ['quantity', 'numeric', 'NO'],
    ['cost_basis', 'numeric', 'NO'],
    ['created_at', TS, 'NO'],
    ['updated_at', TS, 'NO']
  ], [
    Object.assign((r) => r.contype === 'p', { describe: 'primary key (holding_id)' }),
    Object.assign((r) => r.contype === 'u' && /UNIQUE \(account_id, coin_id\)/i.test(r.def), { describe: 'UNIQUE (account_id, coin_id)' }),
    Object.assign((r) => r.contype === 'c' && /quantity >= \(?0/.test(r.def), { describe: 'CHECK quantity >= 0' }),
    Object.assign((r) => r.contype === 'f' && r.target === 'persistent_accounts', { describe: 'FOREIGN KEY -> persistent_accounts' }),
    Object.assign((r) => r.contype === 'f' && r.target === 'coins', { describe: 'FOREIGN KEY -> coins' })
  ]);
  await verifyPersistentEconomyTable(q, problems, 'persistent_transactions', [
    ['persistent_transaction_id', 'integer', 'NO'],
    ['account_id', 'integer', 'NO'],
    ['world_id', 'integer', 'NO'],
    ['user_id', 'integer', 'NO'],
    ['coin_id', 'integer', 'NO'],
    ['type', 'character varying', 'NO'],
    ['quantity', 'numeric', 'NO'],
    ['price', 'numeric', 'NO'],
    ['total_amount', 'numeric', 'NO'],
    ['created_at', TS, 'NO']
  ], [
    Object.assign((r) => r.contype === 'p', { describe: 'primary key (persistent_transaction_id)' }),
    Object.assign((r) => r.contype === 'c' && /\(type\)::text = ANY/.test(r.def), { describe: "CHECK type IN ('BUY','SELL')" }),
    Object.assign((r) => r.contype === 'c' && /quantity > \(?0/.test(r.def), { describe: 'CHECK quantity > 0' }),
    Object.assign((r) => r.contype === 'f' && r.target === 'persistent_accounts', { describe: 'FOREIGN KEY -> persistent_accounts' })
  ]);
}

// Persistent bot debt (migration 027): the append-only loan ledger behind
// persistent_accounts.debt.
async function verifyPersistentLoans(q, problems) {
  const TS = 'timestamp with time zone';
  await verifyPersistentEconomyTable(q, problems, 'persistent_loans', [
    ['persistent_loan_id', 'integer', 'NO'],
    ['account_id', 'integer', 'NO'],
    ['world_id', 'integer', 'NO'],
    ['user_id', 'integer', 'NO'],
    ['type', 'character varying', 'NO'],
    ['amount', 'numeric', 'NO'],
    ['debt_after', 'numeric', 'NO'],
    ['created_at', TS, 'NO']
  ], [
    Object.assign((r) => r.contype === 'p', { describe: 'primary key (persistent_loan_id)' }),
    Object.assign((r) => r.contype === 'c' && /ISSUE/.test(r.def) && /REPAYMENT/.test(r.def), { describe: "CHECK type IN ('ISSUE','REPAYMENT')" }),
    Object.assign((r) => r.contype === 'c' && /amount > \(?0/.test(r.def), { describe: 'CHECK amount > 0' }),
    Object.assign((r) => r.contype === 'c' && /debt_after >= \(?0/.test(r.def), { describe: 'CHECK debt_after >= 0' }),
    Object.assign((r) => r.contype === 'f' && r.target === 'persistent_accounts', { describe: 'FOREIGN KEY -> persistent_accounts' })
  ]);
}

// Persistent bot ticks (migration 028): world-scoped tick identity — the
// duplicate-tick authority for runPersistentBotTick.
async function verifyPersistentBotTicks(q, problems) {
  await verifyPersistentEconomyTable(q, problems, 'persistent_bot_ticks', [
    ['world_id', 'integer', 'NO'],
    ['tick_id', 'bigint', 'NO'],
    ['created_at', 'timestamp with time zone', 'NO']
  ], [
    Object.assign((r) => r.contype === 'p' && /PRIMARY KEY \(world_id, tick_id\)/i.test(r.def), { describe: 'primary key (world_id, tick_id)' }),
    Object.assign((r) => r.contype === 'f' && r.target === 'market_worlds', { describe: 'FOREIGN KEY -> market_worlds' })
  ]);
}

async function verifyGameSchema({ query } = {}) {
  const q = query || ((...args) => db.query(...args));
  const problems = [];

  await verifyApocalypseCycles(q, problems);
  await verifyBaselineColumn(q, problems);
  await verifyCoinCatalogue(q, problems);
  await verifyCollapseSchedule(q, problems);
  await verifyRoundState(q, problems);
  await verifyBots(q, problems);
  await verifyEconomy(q, problems);
  await verifyResults(q, problems);
  await verifyV2PricePrecision(q, problems);
  await verifyPriceHistoryProvenance(q, problems);
  await verifyCoinEventsAndMarketPhases(q, problems);
  await verifyMarketState(q, problems);
  await verifyDynamicCollapses(q, problems);
  await verifyPricingCheckpoints(q, problems);
  await verifyPersistentWorld(q, problems);
  await verifyMarketDirectorState(q, problems);
  await verifyPersistentEconomy(q, problems);
  await verifyPersistentLoans(q, problems);
  await verifyPersistentBotTicks(q, problems);

  return { ok: problems.length === 0, problems };
}
if (require.main === module) {
  verifyGameSchema()
    .then(async ({ ok, problems }) => {
      if (ok) {
        console.log('game schema verification PASSED (apocalypse_cycles [SETTLING lifecycle + settlement observability], coins.cycle_baseline_price, canonical coin catalogue [migrations 013 + 014 retirement], coin_collapse_schedule [legacy], apocalypse_coin_collapses [dynamic death record], apocalypse_participants, apocalypse_holdings, apocalypse_transactions, users.is_bot, apocalypse_bots, apocalypse_bot_ticks, apocalypse_cash_events, apocalypse_economy_ticks, apocalypse_economy_events, apocalypse_results [immutable], apocalypse_coin_events [0-5 active cap], apocalypse_market_phases [one primary phase], apocalypse_market_state [one row per cycle, monotonic peak], market_price_checkpoints [per-coin resumable pricing accumulator, exact float8/bigint round-trip], market_worlds [single active persistent world], market_coin_state [bidirectional condition, decaying reference, explicit timestamped death], market_director_state [one Director cursor per world, bounded intensity], persistent_accounts/holdings/transactions [one world-scoped persistent economy, exactly-once starting cash], persistent_accounts.debt + persistent_loans [bot-only interest-free loan ledger, debt persistence], persistent_bot_ticks [world-scoped bot tick identity])');
        await db.end();
        return;
      }
      console.error('game schema verification FAILED:');
      for (const p of problems) console.error(`  - ${p}`);
      await db.end();
      process.exit(1);
    })
    .catch(async (err) => {
      console.error(`schema verification error: ${err.message}`);
      await db.end();
      process.exit(1);
    });
}

module.exports = { verifyGameSchema };
