const fs = require('fs');
const path = require('path');

const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'deploy.yml');
const workflow = fs.readFileSync(workflowPath, 'utf8');

describe('backend deployment workflow release gates', () => {
  test('runs production migration and schema verification before restarting PM2', () => {
    const orderedCommands = [
      'git fetch origin main',
      'git reset --hard origin/main',
      'npm install',
      'NODE_ENV=production npm run migrate',
      'NODE_ENV=production npm run verify:game-schema',
      'pm2 restart back_coins_x'
    ];

    const positions = orderedCommands.map((command) => {
      expect(workflow).toContain(command);
      return workflow.indexOf(command);
    });

    for (let index = 1; index < positions.length; index += 1) {
      expect(positions[index - 1]).toBeLessThan(positions[index]);
    }
  });

  test('fails fast and performs only non-secret localhost health verification after restart', () => {
    expect(workflow).toMatch(/script:\s*\|\n\s*set -e\n/);

    const restartPosition = workflow.indexOf('pm2 restart back_coins_x');
    const healthCommand = 'curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/api/coins';
    const healthPosition = workflow.indexOf(healthCommand);
    expect(healthPosition).toBeGreaterThan(restartPosition);

    const script = workflow.slice(workflow.indexOf('script: |'));
    expect(script).not.toMatch(/^\s*(?:env|printenv)\b/m);
    expect(script).not.toMatch(/^\s*set\s*$/m);
    expect(script).not.toMatch(/db\/seed\.js|npm run seed/);

    const curlCommands = script
      .split('\n')
      .filter((line) => line.includes('curl '));
    expect(curlCommands).toHaveLength(1);
    expect(curlCommands[0]).toContain('http://127.0.0.1:3000/api/coins');
    expect(curlCommands[0]).not.toMatch(/Authorization|JWT_SECRET|GAME_DIAGNOSTICS_TOKEN/);

    const secretReferences = [...workflow.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)]
      .map((match) => match[1])
      .sort();
    expect(secretReferences).toEqual(['SSH_PRIVATE_KEY', 'SSH_USERNAME']);
  });
});
