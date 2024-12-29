const { execSync } = require('child_process');
const path = require('path');

try {
  // Set environment to development
  process.env.NODE_ENV = 'development';

  console.log('Setting up development environment...');
  
  // Run database setup
  console.log('\nCreating databases...');
  execSync('psql -f ./db/setup.sql', { stdio: 'inherit' });

  // Run seed script
  console.log('\nSeeding development database...');
  require('./db/seed.js');

} catch (error) {
  console.error('Error during setup:', error);
  process.exit(1);
}
