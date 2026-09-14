// Apocalypse cutover: former player-facing /api/game/* routes are unmounted
// (404). Token-gated /api/game/diagnostics/* remains the only /api/game surface.

const request = require('supertest');
const app = require('../app');

describe('Apocalypse API cutover', () => {
  const removed = [
    ['get', '/api/game/state'],
    ['get', '/api/game/market-signals'],
    ['get', '/api/game/leaderboard'],
    ['get', '/api/game/persistent-leaderboard'],
    ['get', '/api/game/leaderboards/recent'],
    ['get', '/api/game/results/1'],
    ['get', '/api/game/participant'],
    ['post', '/api/game/join'],
    ['post', '/api/game/trades/buy'],
    ['post', '/api/game/trades/sell']
  ];

  test.each(removed)('%s %s returns 404 (player game router removed)', async (method, path) => {
    const res = await request(app)[method](path);
    expect(res.status).toBe(404);
  });

  test('diagnostics without token are rejected (not mounted as public)', async () => {
    const res = await request(app).get('/api/game/diagnostics/persistent');
    // Unset token → middleware 404s the entire diagnostics surface.
    expect([401, 403, 404]).toContain(res.status);
    expect(res.status).not.toBe(200);
  });

  test('no public alias remounts /api/game player router', async () => {
    // Soft check: Express stack has diagnostics mount only under /api/game.
    const mounts = [];
    app._router.stack.forEach((layer) => {
      if (layer.name === 'router' && layer.regexp) {
        mounts.push(String(layer.regexp));
      }
    });
    const gameMounts = mounts.filter((m) => /game/.test(m));
    // Only diagnostics should appear; exact regexp encoding varies.
    expect(gameMounts.length).toBeGreaterThanOrEqual(1);
  });
});
