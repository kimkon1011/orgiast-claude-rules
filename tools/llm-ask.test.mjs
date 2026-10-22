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

test('CLI pins Gemini despite extraction routing and falls back when it hangs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-ask-timeout-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const mock = path.join(dir, 'mock.mjs');
  fs.writeFileSync(mock, `
    globalThis.fetch = async (url, init) => {
      console.error('FETCH ' + new URL(url).hostname);
      if (url.includes('generativelanguage')) return new Promise(() => {});
      const prompt = JSON.parse(init.body).messages.at(-1).content;
      return new Response(JSON.stringify({ choices: [{ message: { content: prompt } }] }));
    };
  `);
  const base = ['--import', pathToFileURL(mock).href, fileURLToPath(new URL('./llm-ask.mjs', import.meta.url)), '--provider', 'gemini', '--category', 'extraction', '--prefer-provider', '--per-provider-timeout-ms', '40', '--no-persist', 'exact prompt'];
  const options = { timeout: 10000, env: { ...process.env, ORGIAST_HOME: dir, GEMINI_API_KEY: 'test-only', GROQ_API_KEY: 'test-only' } };
  const { stdout, stderr } = await execute(process.execPath, base, options);
  assert.equal(stdout.trim(), 'exact prompt');
  const calls = stderr.split(/\r?\n/).filter(line => line.startsWith('FETCH '));
  assert.deepEqual(calls, ['FETCH generativelanguage.googleapis.com', 'FETCH api.groq.com']);
  assert.match(stderr, /timeout after 40ms/);
  assert.equal(fs.existsSync(path.join(dir, '.claude')), false);
  await assert.rejects(execute(process.execPath, [...base, '--no-fallback'], options), error => {
    assert.match(error.stderr, /timeout after 40ms/);
    assert.doesNotMatch(error.stderr, /FETCH api.groq.com/);
    return error.code === 1;
  });
});

test('CLI rejects invalid per-provider timeout values before making requests', async () => {
  for (const value of ['0', '-1', '1.2', 'NaN', '2147483648', undefined]) {
    await assert.rejects(execute(process.execPath, [fileURLToPath(new URL('./llm-ask.mjs', import.meta.url)), '--provider', 'gemini', '--per-provider-timeout-ms', ...(value === undefined ? [] : [value])]), error => {
      assert.match(error.stderr, /requires a positive timer-safe integer/);
      return error.code === 2;
    });
  }
});
