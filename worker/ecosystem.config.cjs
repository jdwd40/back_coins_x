# PM2 ecosystem template — Coins market worker (STAGING EXAMPLE)
# Deploy exactly ONE instance (instances: 1). The DB advisory lock + sequence
# check make accidental duplicates safe, but ops should still run one.
#
# Env is injected by the deployment host (PM2 env vars / systemd / .env loaded
# by a wrapper). NEVER commit real connection strings.

module.exports = {
  apps: [
    {
      name: 'coins-market-worker',
      script: 'src/index.js',
      cwd: '/home/jd/back_coins_x/worker',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      time: true,
      env: {
        NODE_ENV: 'staging',
        MARKET_WORKER_ID: 'coins-worker-staging-1',
        TICK_INTERVAL_MS: '30000',
        // COINS_WORKER_DATABASE_URL is provided out-of-band (never committed):
        // postgresql://coins_worker:...@<supabase-host>:5432/postgres
      },
    },
  ],
};
