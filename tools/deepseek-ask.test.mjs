import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
const execute = promisify(execFile);

test('deepseek-ask は同じ Flash モデルで推論なし/ありを切り替え、台帳も新名を記録', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deepseek-ask-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, '.claude'));
  const mock = path.join(dir, 'mock.mjs');
  fs.writeFileSync(mock, `import os from 'node:os'; os.homedir = () => process.env.ORGIAST_HOME;
    globalThis.fetch = async (url, init) => new Response(JSON.stringify({ choices: [{ message: { content: init.body } }], usage: {} }));`);
  for (const reasoner of [false, true]) {
    const { stdout } = await execute(process.execPath, ['--import', pathToFileURL(mock).href, fileURLToPath(new URL('./deepseek-ask.mjs', import.meta.url)), ...(reasoner ? ['--reasoner'] : []), '確認'], {
      env: { ...process.env, ORGIAST_HOME: dir, DEEPSEEK_API_KEY: 'test-only' },
    });
    const body = JSON.parse(stdout);
    assert.equal(body.model, 'deepseek-flash');
    assert.deepEqual(body.thinking, reasoner ? undefined : { type: 'disabled' });
  }
  const rows = fs.readFileSync(path.join(dir, '.claude', 'executor-usage.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.model), ['deepseek-flash', 'deepseek-flash']);
});
