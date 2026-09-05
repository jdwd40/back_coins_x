// Persistent-market Stage 2: explicit persistent-world identity.
//
// Exactly ONE active market world exists at a time (enforced by the
// market_worlds_single_active partial unique index, migration 024). The
// world carries the persistent market timeline's identity: its version, its
// deterministic seed (server-internal — never serialised into any public
// response) and its epoch origin instant. Every persistent pricing,
// checkpoint, condition and (later) economy row is scoped to this identity;
// a wrong-identity state fails loudly rather than silently pricing against
// the wrong timeline.
//
// Legacy Apocalypse cycles remain historical/archive. This module never
// reads or writes apocalypse_* tables.

const WORLD_VERSION = 1;

function assertWorldRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) {
    throw new Error('persistent world row must be an object');
  }
  if (!Number.isInteger(Number(row.world_id)) || Number(row.world_id) <= 0) {
    throw new Error(`persistent world id must be a positive integer; received ${String(row.world_id)}`);
  }
  if (!Number.isInteger(Number(row.version)) || Number(row.version) < 1) {
    throw new Error(`persistent world version must be a positive integer; received ${String(row.version)}`);
  }
  if (Number(row.version) > WORLD_VERSION) {
    throw new Error(`persistent world version ${row.version} is newer than this server understands (${WORLD_VERSION}); refusing to run against a future world`);
  }
  if (typeof row.seed !== 'string' || row.seed.length === 0) {
    throw new Error('persistent world seed must be a non-empty string');
  }
  const epochMs = new Date(row.epoch_started_at).getTime();
  if (!Number.isFinite(epochMs)) {
    throw new Error(`persistent world epoch_started_at is invalid; received ${String(row.epoch_started_at)}`);
  }
  return {
    worldId: Number(row.world_id),
    version: Number(row.version),
    seed: row.seed,
    epochStartedAtMs: epochMs,
    active: row.active === true
  };
}

// Resolve THE active persistent world, failing loudly when there is none
// (the world is provisioned explicitly — never silently invented mid-batch)
// or when the row is corrupt. Runs on the caller's client when provided so
// it can participate in a surrounding transaction.
async function resolveActiveWorld(dbOrClient) {
  const { rows } = await dbOrClient.query(
    'SELECT world_id, version, seed, epoch_started_at, active FROM market_worlds WHERE active ORDER BY world_id'
  );
  if (rows.length === 0) {
    throw new Error('persistent world: no active market world is provisioned; refusing to fabricate one implicitly');
  }
  if (rows.length > 1) {
    // The partial unique index makes this unreachable; belt-and-braces —
    // multiple active worlds would violate the single-economy invariant.
    throw new Error(`persistent world: ${rows.length} active market worlds found; the single-active-world invariant is broken`);
  }
  return assertWorldRow(rows[0]);
}

// Provision the persistent world explicitly and idempotently:
//   * no active world           -> create it with the given identity;
//   * active world, same seed   -> return it (provisioning replay is safe);
//   * active world, other seed  -> HARD FAILURE: the world's identity is
//     immutable; rotating it would silently orphan every persisted timeline
//     accumulator. A new world is a deliberate, separately-approved event.
async function provisionWorld(dbOrClient, { seed, epochStartedAt = new Date() } = {}) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('persistent world provisioning requires a non-empty seed');
  }
  const epochMs = new Date(epochStartedAt).getTime();
  if (!Number.isFinite(epochMs)) {
    throw new Error(`persistent world provisioning epoch is invalid; received ${String(epochStartedAt)}`);
  }
  let existing;
  try {
    existing = await resolveActiveWorld(dbOrClient);
  } catch (err) {
    if (!/no active market world/.test(err.message)) throw err;
    existing = null;
  }
  if (existing) {
    if (existing.seed !== seed) {
      throw new Error(`persistent world: an active world already exists with a different seed (world ${existing.worldId}); refusing to rotate world identity`);
    }
    return existing;
  }
  const { rows } = await dbOrClient.query(
    `INSERT INTO market_worlds (version, seed, epoch_started_at, active)
     VALUES ($1, $2, $3, true)
     RETURNING world_id, version, seed, epoch_started_at, active`,
    [WORLD_VERSION, seed, new Date(epochMs).toISOString()]
  );
  return assertWorldRow(rows[0]);
}

module.exports = {
  WORLD_VERSION,
  assertWorldRow,
  resolveActiveWorld,
  provisionWorld
};
