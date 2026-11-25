import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import test from 'node:test';
const helperUrl = new URL('./hook-stdin.mjs', import.meta.url).href;

function run(input, { end = true, timeout = 100 } = {}) {
  return new Promise((resolve, reject) => {
    const code = `import { readStdinWithTimeout } from ${JSON.stringify(helperUrl)}; process.stdout.write(await readStdinWithTimeout(${timeout}));`;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', code], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (exitCode) => resolve({ exitCode, stdout, stderr }));
    if (input) child.stdin.write(input);
    if (end) child.stdin.end();
  });
}

test('timeout時はstdinを閉じて空文字を返す', async () => {
  const result = await run('', { end: false, timeout: 50 });
  assert.deepEqual(result, { exitCode: 0, stdout: '', stderr: '' });
});

test('通常入力をそのまま返す', async () => {
  const result = await run('通常入力\n');
  assert.deepEqual(result, { exitCode: 0, stdout: '通常入力\n', stderr: '' });
});
