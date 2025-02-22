const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

const setupDev = async () => {
  try {
    console.log('Setting up development environment...');

    // Create databases
    console.log('\nCreating databases...');
    await execPromise('node setup-dbs.js');

    // Seed development database
    console.log('\nSeeding development database...');
    process.env.NODE_ENV = 'development';
    await execPromise('node db/seed.js');

  } catch (error) {
    console.error('Error setting up development environment:', error);
    process.exit(1);
  }
};

setupDev();
