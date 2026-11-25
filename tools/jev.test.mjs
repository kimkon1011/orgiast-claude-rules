import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { askJev, choose, noul, main } from './jev.mjs';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-test-'));
  const env = { ...process.env }, original = globalThis.fetch;
  process.env.ORGIAST_HOME = home;
  process.env.TYPESAFE_API_KEY = 'secret-jev-test-key';
  globalThis.fetch = async () => { throw new Error('unexpected network'); };
  t.after(() => { process.env = env; globalThis.fetch = original; fs.rmSync(home, { recursive: true, force: true }); });
  return home;
}
const payload = { model: 'jev-1.14.0', answers: { choice: { type: 'choice', choice: 'a', confidence: 1 } }, usage: { input_tokens: 358, output_tokens: 55 } };
test('choice のリクエストと使用量、env ファイルの鍵を確認', async t => {
  const home = fixture(t);
  delete process.env.TYPESAFE_API_KEY;
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'typesafe.env'), 'TYPESAFE_API_KEY=secret-jev-test-key');
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(init.headers.Authorization, 'Bearer secret-jev-test-key');
    assert.equal(init.method, 'POST');
    assert.deepEqual(JSON.parse(init.body), { model: 'jev-latest', state: { task: 'test' }, questions: { choice: { type: 'choice', instructions: 'select', criteria: { a: null } } } });
    return { ok: true, json: async () => payload };
  };
  assert.equal((await choose({ task: 'test' }, 'select', { a: null })).ok, true);
  const log = fs.readFileSync(path.join(home, '.claude', 'jev-usage.jsonl'), 'utf8');
  assert.doesNotMatch(log, /secret-jev-test-key/);
  assert.equal(JSON.parse(log).input_tokens, 358);
  assert.equal(JSON.parse(log).label, 'choice');
});
test('キー無しは通信しない', async t => {
  fixture(t); delete process.env.TYPESAFE_API_KEY;
  assert.deepEqual(await askJev({}), { ok: false, reason: 'missing_key' });
  assert.equal((await main(['doctor'])).keyPresent, false);
});
test('401 本文と例外に含まれるキーを返さない', async t => {
  fixture(t);
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => { throw new Error(process.env.TYPESAFE_API_KEY); } });
  assert.deepEqual(await askJev({}), { ok: false, reason: 'http_401' });
  globalThis.fetch = async () => { throw new Error(process.env.TYPESAFE_API_KEY); };
  assert.deepEqual(await noul('x', 'y'), { ok: false, reason: 'request_failed' });
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ answers: { leaked: process.env.TYPESAFE_API_KEY } }) });
  const result = await askJev({});
  assert.equal(result.ok, false);
  assert.doesNotMatch(JSON.stringify(result), /secret-jev-test-key/);
});
test('fetch と本文のタイムアウトを中断しフォールバックできる', async t => {
  fixture(t);
  for (const bodyPending of [false, true]) {
    let signal;
    globalThis.fetch = async (_, init) => { signal = init.signal; return bodyPending ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {}); };
    assert.deepEqual(await askJev({ timeoutMs: 15 }), { ok: false, reason: 'timeout' });
    assert.equal(signal.aborted, true);
  }
});
test('CLI choice/noul/doctor と score を扱う', async t => {
  fixture(t);
  const requests = [];
  globalThis.fetch = async (_, init) => { requests.push(JSON.parse(init.body)); return { ok: true, json: async () => payload }; };
  assert.equal((await main(['choice', '--state', 'x', '--instructions', 'y', '--option', 'a=説明', '--option', 'b'])).ok, true);
  assert.deepEqual(requests[0].questions.choice.criteria, { a: '説明', b: null });
  assert.equal((await main(['noul', '--state', 'x', '--instructions', 'y'])).ok, true);
  assert.equal(requests[1].questions.noul.type, 'noul');
  assert.equal((await main(['doctor'])).keyPresent, true);
  await askJev({ state: 'x', questions: { score: { type: 'score', instructions: 'y', criteria: ['low', 'high'] } } });
  assert.equal(requests.at(-1).questions.score.type, 'score');
});
