const { spawnSync } = require('child_process');

// Get command line arguments
const args = process.argv.slice(2);

// Convert Windows paths to WSL paths
const convertPath = (winPath) => {
  if (winPath.startsWith('//wsl.localhost')) {
    return winPath.replace('//wsl.localhost/Ubuntu', '');
  }
  return winPath;
};

// Convert all file paths in arguments
const wslArgs = args.map(arg => {
  if (arg.includes('wsl.localhost')) {
    return convertPath(arg);
  }
  return arg;
});

// Run Jest in WSL using powershell
const result = spawnSync('powershell.exe', [
  'wsl',
  '-e',
  'bash',
  '-c',
  `cd /home/jd/projects/coins/back_coins_x && NODE_ENV=test jest ${wslArgs.join(' ')}`
], {
  stdio: 'inherit'
});

process.exit(result.status);
