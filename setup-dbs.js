const { execSync } = require('child_process');

try {
  // Run the setup.sql file
  execSync('psql -f ./db/setup.sql');
  console.log('Databases created successfully!');
} catch (error) {
  console.error('Error creating databases:', error);
  process.exit(1);
}
