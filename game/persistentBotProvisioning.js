// Persistent-market bot provisioning helpers.
//
// Shared by the live persistent bot tick path (game/persistentBots.js) and
// retained offline cycle-era tooling. These helpers create the stable
// roster users + apocalypse_bots identity rows and the deterministic
// SHA-256 PRNG used by bot decisions. They do NOT join rounds, mutate
// prices, or start timers.
//
// Live production bots must import from THIS module — not from the
// cycle-era game/botService.js decision engine.

const crypto = require('crypto');
const bcrypt = require('bcrypt');
const db = require('../db/connection');
const { BOT_ROSTER } = require('./botConfig');

function createBotRandom({ seed, botKey, tickId }) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error(`bot random seed must be a non-empty string; received ${typeof seed === 'string' ? JSON.stringify(seed) : String(seed)}`);
  }
  if (typeof botKey !== 'string' || botKey.length === 0) {
    throw new Error(`bot random botKey must be a non-empty string; received ${typeof botKey === 'string' ? JSON.stringify(botKey) : String(botKey)}`);
  }
  if (!Number.isInteger(tickId) || tickId < 0) {
    throw new Error(`bot random tickId must be a non-negative integer; received ${String(tickId)}`);
  }
  let counter = 0;
  return function botRandom() {
    const digest = crypto.createHash('sha256').update(`${seed}:core5:${botKey}:${tickId}:${counter}`).digest();
    counter += 1;
    return digest.readUInt32BE(0) / 0x100000000; // [0, 1)
  };
}

async function ensureBotsProvisioned({ queryable = db } = {}) {
  const provisioned = [];
  for (const bot of BOT_ROSTER) {
    // The password hash is a syntactically valid bcrypt hash of a random
    // secret generated here and NEVER stored anywhere: no candidate password
    // can ever authenticate as a bot. A fresh secret is generated only when
    // the row does not yet exist (ON CONFLICT DO NOTHING discards it).
    const unusableHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);
    await queryable.query(
      `INSERT INTO users (username, email, password_hash, funds, is_bot)
       VALUES ($1, $2, $3, 0.00, true)
       ON CONFLICT (username) DO NOTHING`,
      [bot.username, bot.email, unusableHash]
    );
    const { rows: userRows } = await queryable.query(
      'SELECT user_id, is_bot FROM users WHERE username = $1',
      [bot.username]
    );
    const user = userRows[0];
    if (!user) {
      throw new Error(`bot provisioning: failed to resolve roster user ${bot.username}`);
    }
    if (user.is_bot !== true) {
      // The roster username belongs to a pre-existing HUMAN account. That is
      // a deployment conflict, never something to silently take over.
      throw new Error(
        `bot provisioning: username ${bot.username} already exists and is not a bot; refusing to adopt a human account`
      );
    }

    await queryable.query(
      `INSERT INTO apocalypse_bots (bot_key, strategy, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (bot_key) DO NOTHING`,
      [bot.botKey, bot.strategy, user.user_id]
    );
    const { rows: identityRows } = await queryable.query(
      'SELECT bot_key, strategy, user_id, last_action_at FROM apocalypse_bots WHERE bot_key = $1',
      [bot.botKey]
    );
    const identity = identityRows[0];
    if (identity.user_id !== user.user_id) {
      throw new Error(
        `bot provisioning: identity ${bot.botKey} is pinned to user ${identity.user_id}, expected ${user.user_id}`
      );
    }
    if (identity.strategy !== bot.strategy) {
      throw new Error(
        `bot provisioning: identity ${bot.botKey} persists strategy ${identity.strategy}, roster now says ${bot.strategy}; reconcile manually`
      );
    }
    provisioned.push({
      botKey: bot.botKey,
      strategy: bot.strategy,
      userId: user.user_id,
      lastActionAt: identity.last_action_at ? new Date(identity.last_action_at) : null
    });
  }
  return provisioned;
}

module.exports = {
  createBotRandom,
  ensureBotsProvisioned
};
