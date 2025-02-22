const isDev = process.env.NODE_ENV === 'development';

const logger = {
  log: (...args) => {
    if (isDev) {
      console.log(...args);
    }
  },
  error: (...args) => {
    if (isDev) {
      console.error(...args);
    }
  },
  // Always log fatal errors regardless of environment
  fatal: (...args) => {
    console.error('[FATAL]', ...args);
  },
  // Always log market simulator messages in dev mode
  market: (...args) => {
    if (isDev) {
      console.log('[MARKET]', ...args);
    }
  }
};

module.exports = logger;
