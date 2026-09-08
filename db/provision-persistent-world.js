// Intentional FIRST-TIME ops CLI for the persistent market world.
//
// Never auto-run from server, writers, workers, or deploy.yml. Creates the
// single active world only when none exists. If any active world is already
// present, refuses loudly (first-time only).

const db = require('./connection');
const { provisionWorld } = require('../game/persistentWorld');

function printHelp() {
  console.log(`Usage:
  NODE_ENV=production node db/provision-persistent-world.js --seed <seed>
  NODE_ENV=production PERSISTENT_WORLD_SEED=<seed> node db/provision-persistent-world.js

Options:
  --seed <value>   Non-empty world seed (also accepts --seed=<value>)
  --help           Show this help

Environment:
  PERSISTENT_WORLD_SEED  Used when --seed is omitted

First-time only. If an active world already exists it refuses.
Deploy/server/writer paths never call this automatically.`);
}

function parseArgs(argv, env = process.env) {
  const args = { seed: null, help: false };
  const list = Array.isArray(argv) ? argv.slice() : [];
  let i = 0;
  if (list[0] && /node/.test(list[0])) i = 2;
  else if (list[0] && list[0].endsWith('provision-persistent-world.js')) i = 1;

  for (; i < list.length; i += 1) {
    const token = list[i];
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--seed') {
      const value = list[i + 1];
      if (value == null || String(value).startsWith('--')) {
        throw new Error('--seed requires a non-empty value');
      }
      args.seed = value;
      i += 1;
      continue;
    }
    if (token.startsWith('--seed=')) {
      args.seed = token.slice('--seed='.length);
      continue;
    }
    throw new Error(`unknown argument ${token}`);
  }

  if (!args.seed && typeof env.PERSISTENT_WORLD_SEED === 'string' && env.PERSISTENT_WORLD_SEED.length > 0) {
    args.seed = env.PERSISTENT_WORLD_SEED;
  }

  if (args.seed != null && args.seed.length === 0) {
    throw new Error('seed must be a non-empty string');
  }

  return args;
}

async function provisionPersistentWorldOnce({ seed, queryable } = {}) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error('provisionPersistentWorldOnce requires a non-empty seed');
  }
  const q = queryable || db;
  const { rows } = await q.query(
    'SELECT world_id FROM market_worlds WHERE active ORDER BY world_id'
  );
  if (rows.length > 0) {
    throw new Error(
      `refuse: active persistent world already exists (world_id=${rows[0].world_id}); ` +
      'provision:persistent-world is first-time only and will not rotate or replace identity'
    );
  }
  return provisionWorld(q, { seed });
}

if (require.main === module) {
  (async () => {
    let args;
    try {
      args = parseArgs(process.argv, process.env);
    } catch (err) {
      console.error(err.message);
      await db.end();
      process.exit(1);
      return;
    }

    if (args.help) {
      printHelp();
      await db.end();
      return;
    }

    if (!args.seed) {
      console.error('missing seed: pass --seed <value> or set PERSISTENT_WORLD_SEED');
      printHelp();
      await db.end();
      process.exit(1);
      return;
    }

    try {
      const world = await provisionPersistentWorldOnce({ seed: args.seed, queryable: db });
      console.log(`persistent world provisioned world_id=${world.worldId}`);
      await db.end();
    } catch (err) {
      console.error(`provision:persistent-world failed: ${err.message}`);
      await db.end();
      process.exit(1);
    }
  })();
}

module.exports = {
  parseArgs,
  provisionPersistentWorldOnce
};
