import test from 'node:test';
import assert from 'node:assert/strict';
import { main, checkReport, jstDate, buildWarning } from './claude-pace-report-watch.mjs';

const res = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const silent = () => {};

function spyAdd() {
  const calls = [];
  return { calls, fn: async (home, options) => { calls.push({ home, options }); } };
}

test('報告があれば警告しない', async () => {
  const add = spyAdd();
  const out = await main([], { fetchImpl: async () => res(200, { size: 1234 }), addItem: add.fn, print: silent, host: '018' });
  assert.equal(out.ok, true);
  assert.equal(out.size, 1234);
  assert.equal(add.calls.length, 0);
});

test('報告が無ければ kim-inbox に警告を積む', async () => {
  const add = spyAdd();
  const out = await main(['--date', '2026-11-28'], { fetchImpl: async () => res(404, {}), addItem: add.fn, print: silent, host: '018' });
  assert.equal(out.ok, false);
  assert.equal(out.warned, true);
  assert.equal(add.calls.length, 1);
  assert.equal(add.calls[0].options.kind, 'ask');
  assert.match(add.calls[0].options.text, /2026-11-28/);
  assert.match(add.calls[0].options.text, /reports\/claude-pace/);
});

test('size が 0 なら無い扱い', async () => {
  const add = spyAdd();
  const out = await main([], { fetchImpl: async () => res(200, { size: 0 }), addItem: add.fn, print: silent, host: '018' });
  assert.equal(out.ok, false);
  assert.equal(add.calls.length, 1);
});

test('取得に失敗したら「無い」と断定せず警告する', async () => {
  const add = spyAdd();
  const out = await main([], { fetchImpl: async () => { throw new TypeError('network down'); }, addItem: add.fn, print: silent, host: '018' });
  assert.equal(out.ok, false);
  assert.equal(add.calls.length, 1);
  assert.match(add.calls[0].options.text, /分かっていません/);
});

test('HTTP 500 でも断定せず警告する', async () => {
  const add = spyAdd();
  const out = await main([], { fetchImpl: async () => res(500, {}), addItem: add.fn, print: silent, host: '018' });
  assert.equal(out.ok, false);
  assert.match(add.calls[0].options.text, /分かっていません/);
});

test('--dry-run は何も積まず本文を出す', async () => {
  const add = spyAdd();
  const lines = [];
  const out = await main(['--dry-run', '--date', '2026-11-27'], { fetchImpl: async () => res(404, {}), addItem: add.fn, print: (s) => lines.push(s), host: '018' });
  assert.equal(out.dryRun, true);
  assert.equal(add.calls.length, 0);
  assert.match(lines.join('\n'), /2026-11-27/);
});

test('jstDate は JST で日付を返す', () => {
  assert.equal(jstDate(Date.parse('2026-11-27T16:00:00Z')), '2026-11-28');
  assert.equal(jstDate(Date.parse('2026-11-27T14:59:00Z')), '2026-11-27');
});

test('checkReport は 404 を exists=false、500 を exists=null で返す', async () => {
  assert.deepEqual(await checkReport('2026-11-28', { fetchImpl: async () => res(404, {}), token: '' }), { exists: false, reason: 'GitHub API が 404' });
  const err = await checkReport('2026-11-28', { fetchImpl: async () => res(500, {}), token: '' });
  assert.equal(err.exists, null);
});

test('buildWarning は出し直し方を含む', () => {
  const text = buildWarning('2026-11-28', { exists: false, reason: 'GitHub API が 404' }, '018');
  assert.match(text, /claude-pace-report\.mjs --force/);
  assert.match(text, /018/);
});
