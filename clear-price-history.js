const db = require('./db/connection');

async function clearPriceHistory() {
  try {
    await db.query('TRUNCATE price_history CASCADE');
    console.log('Successfully cleared price history database');
    await db.end();
  } catch (err) {
    console.error('Error clearing price history:', err);
    process.exit(1);
  }
}

clearPriceHistory();
