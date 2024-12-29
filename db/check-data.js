const db = require('./connection');

async function checkData() {
    try {
        // First check if we can connect to the database
        console.log('Attempting to connect to database...');
        await db.query('SELECT current_database()');
        console.log('Successfully connected to database');

        // Check if tables exist
        console.log('\nChecking if tables exist:');
        const tableCheck = await db.query(`
            SELECT table_name 
            FROM information_schema.tables 
            WHERE table_schema = 'public'
        `);
        console.log('Available tables:', tableCheck.rows.map(row => row.table_name));

        // Now check each table's data
        console.log('\nChecking Coins table:');
        const coins = await db.query('SELECT * FROM "coins"');
        console.log('Found', coins.rows.length, 'coins:');
        console.log(JSON.stringify(coins.rows, null, 2));

        console.log('\nChecking Users table:');
        const users = await db.query('SELECT user_id, username, email FROM "users"');
        console.log('Found', users.rows.length, 'users:');
        console.log(JSON.stringify(users.rows, null, 2));

        console.log('\nChecking Transactions table:');
        const transactions = await db.query('SELECT * FROM "transactions"');
        console.log('Found', transactions.rows.length, 'transactions:');
        console.log(JSON.stringify(transactions.rows, null, 2));

        console.log('\nChecking Portfolios table:');
        const portfolios = await db.query('SELECT * FROM "portfolios"');
        console.log('Found', portfolios.rows.length, 'portfolios:');
        console.log(JSON.stringify(portfolios.rows, null, 2));

    } catch (error) {
        console.error('Error checking data:', error);
    } finally {
        await db.end();
    }
}

checkData();
