const app = require('./app');
const db = require('./db/connection');

const PORT = process.env.PORT || 3000;

// Test database connection before starting server
const startServer = async () => {
  try {
    // Test the database connection
    await db.query('SELECT NOW()');
    console.log('Database connection successful');

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error('Failed to connect to database:', error);
    process.exit(1);
  }
};

startServer();
