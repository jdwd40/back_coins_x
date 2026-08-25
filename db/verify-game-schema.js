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
//   * public.coin_collapse_schedule (Core 3): columns, PK, both FKs, both
//     UNIQUE constraints (cycle/coin and cycle/rank), all CHECK constraints,
//     the partial due-reconciliation index, and live-data invariants (no
//     executed collapse with a non-zero live price in the ACTIVE cycle, no
//     zero-priced coin without an executed collapse in the ACTIVE cycle, no
//     execution before its scheduled time).
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
//
// Exits non-zero with an explicit problem list on any mismatch.
//
// Usage: node db/verify-game-schema.js   (uses db/connection env configuration)

const db = require('./connection');

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

  // Live-data invariants (only when the columns exist to evaluate them).
  // These join apocalypse_cycles; when that table is absent its own shape
  // problems above are the report, so the joined invariants are skipped
  // rather than crashing.
  const cyclesPresent = await q(`SELECT to_regclass('public.apocalypse_cycles') AS reg`);
  if (byName.has('executed_at') && byName.has('scheduled_at')) {
    const early = await q(
      `SELECT count(*)::int AS n FROM coin_collapse_schedule
       WHERE executed_at IS NOT NULL AND executed_at < scheduled_at`
    );
    if (early.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${early.rows[0].n} collapses executed before their scheduled time`);
  }
  if (byName.has('executed_at') && cyclesPresent.rows[0].reg) {
    // Milestone 1: the authoritative live window is ACTIVE **or SETTLING**.
    // A coin collapsed at the end of a round stays £0 through settlement (the
    // freeze window has no ACTIVE cycle), matching the runtime death rule in
    // collapseScheduleService.getCollapsedCoinIds/isCoinCollapsed.
    // A collapsed coin in the live window must be exactly £0 (never revived).
    const revived = await q(
      `SELECT count(*)::int AS n
       FROM coin_collapse_schedule cs
       JOIN apocalypse_cycles ac ON ac.cycle_id = cs.cycle_id
       JOIN coins c ON c.coin_id = cs.coin_id
       WHERE ac.status IN ('ACTIVE', 'SETTLING') AND cs.executed_at IS NOT NULL AND c.current_price <> 0`
    );
    if (revived.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${revived.rows[0].n} collapsed coins in the ACTIVE/SETTLING cycle have a non-zero live price`);

    // A zero live price must be backed by an executed collapse in the
    // ACTIVE or SETTLING cycle — death is never inferred from price alone,
    // and a mid-settlement £0 (no ACTIVE cycle exists then) is legitimate.
    const unexplained = await q(
      `SELECT count(*)::int AS n FROM coins c
       WHERE c.current_price = 0 AND NOT EXISTS (
         SELECT 1 FROM coin_collapse_schedule cs
         JOIN apocalypse_cycles ac ON ac.cycle_id = cs.cycle_id
         WHERE ac.status IN ('ACTIVE', 'SETTLING') AND cs.coin_id = c.coin_id AND cs.executed_at IS NOT NULL
       )`
    );
    if (unexplained.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${unexplained.rows[0].n} zero-priced coins have no executed collapse row in the ACTIVE/SETTLING cycle`);
  }
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

  return { ok: problems.length === 0, problems };
}

if (require.main === module) {
  verifyGameSchema()
    .then(async ({ ok, problems }) => {
      if (ok) {
        console.log('game schema verification PASSED (apocalypse_cycles [SETTLING lifecycle + settlement observability], coins.cycle_baseline_price, canonical coin catalogue [migrations 013 + 014 retirement], coin_collapse_schedule, apocalypse_participants, apocalypse_holdings, apocalypse_transactions, users.is_bot, apocalypse_bots, apocalypse_bot_ticks, apocalypse_cash_events, apocalypse_economy_ticks, apocalypse_economy_events, apocalypse_results [immutable])');
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
