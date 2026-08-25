// Deterministic injectable random source: SHA-256 counter mode keyed by a
// seed string. Same seed -> identical stream, in every process, forever.
//
// This is the canonical seeded-RNG convention used by every replayable game
// decision (Core 3 collapse schedules, Core 5 bots, the economy event
// schedule, and the V2 cyclical market). It lives in its own pure module so
// gameplay-domain code (game/marketDomain.js) can stay free of database
// imports. collapseScheduleService re-exports it; existing callers are
// unaffected. Math.random() is never an acceptable substitute.

const crypto = require('crypto');

function createSeededRandom(seed) {
  if (typeof seed !== 'string' || seed.length === 0) {
    throw new Error(`seeded random seed must be a non-empty string; received ${typeof seed === 'string' ? JSON.stringify(seed) : String(seed)}`);
  }
  let counter = 0;
  return function seededRandom() {
    const digest = crypto.createHash('sha256').update(`${seed}:${counter}`).digest();
    counter += 1;
    return digest.readUInt32BE(0) / 0x100000000; // [0, 1)
  };
}

module.exports = { createSeededRandom };
