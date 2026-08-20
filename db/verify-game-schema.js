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
  if (!defs.some((d) => /ACTIVE/.test(d) && /COMPLETED/.test(d))) {
    problems.push("missing CHECK (status IN ('ACTIVE', 'COMPLETED'))");
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

  // Live-data invariants (only when rows exist and the needed columns do).
  if (byName.has('status')) {
    const active = await q(`SELECT count(*)::int AS n FROM apocalypse_cycles WHERE status = 'ACTIVE'`);
    if (active.rows[0].n > 1) problems.push(`INVARIANT VIOLATION: ${active.rows[0].n} ACTIVE rows`);
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
  if (byName.has('executed_at') && byName.has('scheduled_at')) {
    const early = await q(
      `SELECT count(*)::int AS n FROM coin_collapse_schedule
       WHERE executed_at IS NOT NULL AND executed_at < scheduled_at`
    );
    if (early.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${early.rows[0].n} collapses executed before their scheduled time`);
  }
  if (byName.has('executed_at')) {
    // A coin collapsed in the ACTIVE cycle must be exactly £0 (never revived).
    const revived = await q(
      `SELECT count(*)::int AS n
       FROM coin_collapse_schedule cs
       JOIN apocalypse_cycles ac ON ac.cycle_id = cs.cycle_id
       JOIN coins c ON c.coin_id = cs.coin_id
       WHERE ac.status = 'ACTIVE' AND cs.executed_at IS NOT NULL AND c.current_price <> 0`
    );
    if (revived.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${revived.rows[0].n} collapsed coins in the ACTIVE cycle have a non-zero live price`);

    // A zero live price must be backed by an executed collapse in the ACTIVE
    // cycle — death is never inferred from price alone.
    const unexplained = await q(
      `SELECT count(*)::int AS n FROM coins c
       WHERE c.current_price = 0 AND NOT EXISTS (
         SELECT 1 FROM coin_collapse_schedule cs
         JOIN apocalypse_cycles ac ON ac.cycle_id = cs.cycle_id
         WHERE ac.status = 'ACTIVE' AND cs.coin_id = c.coin_id AND cs.executed_at IS NOT NULL
       )`
    );
    if (unexplained.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${unexplained.rows[0].n} zero-priced coins have no executed collapse row in the ACTIVE cycle`);
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
      { label: "status IN ('ACTIVE', 'FINALIZED')", pattern: 'ACTIVE.*FINALIZED' },
      { label: 'final_cash consistency with status', pattern: 'final_cash IS NULL.*FINALIZED' }
    ],
    nowDefaults: ['joined_at', 'created_at', 'updated_at']
  });

  await verifyCore4Table(q, problems, 'apocalypse_holdings', 'holding_id', EXPECTED_HOLDING_COLUMNS, {
    uniques: ['^UNIQUE \\(participant_id, coin_id\\)'],
    fks: [
      { target: 'apocalypse_participants', pattern: '^FOREIGN KEY \\(participant_id, cycle_id, user_id\\)' },
      { target: 'coins', pattern: '^FOREIGN KEY \\(coin_id\\)' }
    ],
    checks: [{ label: 'quantity >= 0', pattern: 'quantity >= \\(??0' }]
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
  if (tables.rows[0].t && await hasColumns('apocalypse_transactions', ['quantity', 'price', 'total_amount', 'type'])) {
    const badTx = await q(
      `SELECT count(*)::int AS n FROM apocalypse_transactions
       WHERE quantity <= 0 OR price < 0 OR total_amount < 0 OR type NOT IN ('BUY', 'SELL')`
    );
    if (badTx.rows[0].n > 0) problems.push(`INVARIANT VIOLATION: ${badTx.rows[0].n} round transactions with invalid quantity/price/total/type`);
  }
}

async function verifyGameSchema({ query } = {}) {
  const q = query || ((...args) => db.query(...args));
  const problems = [];

  await verifyApocalypseCycles(q, problems);
  await verifyBaselineColumn(q, problems);
  await verifyCollapseSchedule(q, problems);
  await verifyRoundState(q, problems);

  return { ok: problems.length === 0, problems };
}

if (require.main === module) {
  verifyGameSchema()
    .then(async ({ ok, problems }) => {
      if (ok) {
        console.log('game schema verification PASSED (apocalypse_cycles, coins.cycle_baseline_price, coin_collapse_schedule, apocalypse_participants, apocalypse_holdings, apocalypse_transactions)');
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
