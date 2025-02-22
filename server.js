// Immediate debugging
console.log('Starting server file execution');
console.log('Current NODE_ENV:', process.env.NODE_ENV);

const app = require('./app');
console.log('App loaded successfully');

const db = require('./db/connection');
console.log('DB module loaded successfully');

const logger = require('./utils/logger');
console.log('Logger loaded successfully');

const PORT = process.env.PORT || 3000;

// Test database connection before starting server
const startServer = async () => {
  console.log('Starting server initialization...');
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database host: ${process.env.PGHOST || 'localhost'}`);
  
  try {
    console.log('Testing database connection...');
    
    // Add timeout to database query
    const dbTimeout = new Promise((resolve, reject) => {
      setTimeout(() => reject(new Error('Database connection timeout after 5 seconds')), 5000);
    });
    
    const dbQuery = db.query('SELECT NOW()');
    const result = await Promise.race([dbQuery, dbTimeout]);
    
    console.log('Database connection successful:', result.rows[0]);
    
    app.listen(PORT, () => {
      console.log('Express server started successfully');
      console.log(`Server is running on port ${PORT}`);
      console.log('Ready to accept connections');
    });
  } catch (error) {
    console.error('Server startup error:');
    console.error(`Error name: ${error.name}`);
    console.error(`Error message: ${error.message}`);
    if (error.code) {
      console.error(`PostgreSQL error code: ${error.code}`);
    }
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
};

startServer();
