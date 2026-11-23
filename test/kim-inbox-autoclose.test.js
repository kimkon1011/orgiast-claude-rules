import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findAutocloseCandidates, runAutoclose } from '../tools/kim-inbox-autoclose.mjs';

const url = number => `https://github.com/acme/widgets/pull/${number}`;
const item = (id, text, extra = {}) => ({ id, text, title: '', kind: 'ask', status: 'open', ...extra });
const fetchWith = states => async pr => {
  const value = states[pr.number];
  if (value instanceof Error) throw value;
  return { number: pr.number, state: value, mergedAt: value === 'MERGED' ? '2026-11-20T00:00:00Z' : null, closedAt: value === 'CLOSED' ? '2026-11-21T00:00:00Z' : null };
};

test('PR URL が無い ask はスキップされる', async () => {
  const result = await findAutocloseCandidates([item('ki-none', '判断してください')], { fetchState: fetchWith({}) });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skipped[0].reason, 'PR URLなし');
});

test('OPEN の ask は対象外', async () => {
  const result = await findAutocloseCandidates([item('ki-open', url(1))], { fetchState: fetchWith({ 1: 'OPEN' }) });
  assert.equal(result.candidates.length, 0);
});

test('MERGED の ask は対象', async () => {
  const result = await findAutocloseCandidates([item('ki-merged', url(2))], { fetchState: fetchWith({ 2: 'MERGED' }) });
  assert.deepEqual(result.candidates.map(row => row.id), ['ki-merged']);
});

test('CLOSED の ask も対象', async () => {
  const result = await findAutocloseCandidates([item('ki-closed', url(3))], { fetchState: fetchWith({ 3: 'CLOSED' }) });
  assert.deepEqual(result.candidates.map(row => row.id), ['ki-closed']);
});

test('複数 PR のうち 1 つでも OPEN なら対象外', async () => {
  const result = await findAutocloseCandidates([item('ki-many', `${url(1)}\n${url(2)}`)], { fetchState: fetchWith({ 1: 'MERGED', 2: 'OPEN' }) });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skipped[0].reason, 'OPENのPRあり');
});

test('同一 PR の状態取得は複数エントリでも 1 回', async () => {
  let calls = 0;
  const result = await findAutocloseCandidates([item('ki-a', url(4)), item('ki-b', url(4))], {
    fetchState: async pr => { calls++; return fetchWith({ 4: 'MERGED' })(pr); },
  });
  assert.equal(result.candidates.length, 2);
  assert.equal(calls, 1);
});

test('dry-run は一時台帳を一切書き換えない', async t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kim-inbox-autoclose-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, '.claude', 'kim-inbox');
  fs.mkdirSync(dir, { recursive: true });
  const id = 'ki-20261123000000-abcd';
  const file = path.join(dir, `${id}.json`);
  const record = { ...item(id, url(5)), createdAt: '2026-11-20T00:00:00Z', shownSessions: [], shownCount: 0 };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
  const before = fs.readFileSync(file, 'utf8');
  let answers = 0;
  const result = await runAutoclose({ home, fetchState: fetchWith({ 5: 'MERGED' }), answer: () => { answers++; } });
  assert.equal(result.candidates.length, 1);
  assert.equal(answers, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('gh 取得失敗は対象外になり理由を保持する', async () => {
  const result = await findAutocloseCandidates([item('ki-fail', url(6))], { fetchState: fetchWith({ 6: new Error('gh timeout') }) });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].reason, /gh timeout/);
});
