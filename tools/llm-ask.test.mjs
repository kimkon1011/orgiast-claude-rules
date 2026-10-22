import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

const execute = promisify(execFile);
test('LLM CLI reads a long UTF-8 prompt file verbatim without interpreting its contents as arguments', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ask-file-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const prompt = JSON.stringify({ text: '明日12時 --provider wrong "引用"\n'.repeat(2000) });
  const promptFile = path.join(dir, 'prompt with spaces.json');
  fs.writeFileSync(promptFile, prompt);
  const mock = path.join(dir, 'mock.mjs');
  fs.writeFileSync(mock, `globalThis.fetch = async (url, init) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.parse(init.body).messages.at(-1).content } }], usage: {} }));`);
  const { stdout } = await execute(process.execPath, ['--import', pathToFileURL(mock).href, fileURLToPath(new URL('./llm-ask.mjs', import.meta.url)), '--provider', 'groq', '--no-fallback', '--no-persist', '--prompt-file', promptFile], { env: { ...process.env, ORGIAST_HOME: dir, GROQ_API_KEY: 'test-only' }, maxBuffer: 1024 * 1024 });
  assert.equal(stdout.trimEnd(), prompt);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
});
