const { spawnSync } = require('node:child_process');
const { version } = require('./package.json');
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a release version');
const result = spawnSync('npx', ['--yes', '@vscode/vsce', 'package', '--out', `orgiast-next-session-${version}.vsix`], {
  stdio: 'inherit', shell: process.platform === 'win32',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
