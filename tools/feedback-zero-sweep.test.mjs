import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweep, fetchPending, normalizeItem } from './feedback-zero-sweep.mjs';

const entry = { appName: 'テストアプリ', kind: 'next', intake: 'relay', refs: { url: 'T_URL', secret: 'T_SECRET', repo: 'T_REPO', appDir: 'T_DIR' } };

function setup(items, { fail = false } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-sweep-'));
  const work = path.join(home, 'work'); fs.mkdirSync(work);
  const registryFile = path.join(home, 'registry.json');
  fs.writeFileSync(registryFile, JSON.stringify({ version: 1, apps: [entry] }));
  const config = { T_URL: 'https://relay.invalid/x', T_SECRET: 'dummy', T_REPO: 'o/r', T_DIR: work, FEEDBACK_KIM_DISCORD_ID: '1' };
  const fetchImpl = async () => {
    if (fail) throw new Error('down');
    return { ok: true, json: async () => ({ ok: true, items }) };
  };
  const calls = { issue: 0, exec: 0, notify: [] };
  const opts = {
    registryFile, home, config, fetchImpl,
    gh: () => ({ status: 0, stdout: JSON.stringify({ state: 'OPEN', url: 'u', title: 't' }) }),
    ensureIssue: (item) => { calls.issue++; return { message_id: item.message_id, repo: 'o/r', number: 1, url: 'https://github.com/o/r/issues/1' }; },
    gate: () => ({}),
    execute: async () => { calls.exec++; return { status: 0, stdout: '' }; },
    notify: async (text) => { calls.notify.push(text); return { delivered: 'dm' }; },
    done: async () => {},
  };
  return { home, opts, calls };
}
const pending = [{ message_id: 'a1', app_name: 'テストアプリ', kind: 'bug', title: '壊れた', body: 'x' }];

test('--dry-run は残数を返すが Issue 化・実装・通知・状態保存をしない', async () => {
  const { home, opts, calls } = setup(pending);
  try {
    const result = await sweep({ ...opts, dryRun: true });
    assert.equal(result.remaining, 1);
    assert.equal(calls.issue + calls.exec + calls.notify.length, 0);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'feedback-zero-state.json')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('実行時は未対応を Issue 化→実装へ投入し、残数>0 なので kim へ通知する', async () => {
  const { home, opts, calls } = setup(pending);
  try {
    const result = await sweep(opts);
    assert.equal(result.launched, 1);
    assert.equal(calls.issue, 1);
    assert.equal(calls.exec, 1);
    assert.equal(calls.notify.length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'feedback-zero-state.json'), 'utf8'));
    assert.equal(Object.values(state.jobs)[0].status, 'awaiting-review');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('残0かつ取得成功なら kim へ通知しない', async () => {
  const { home, opts, calls } = setup([]);
  try {
    const result = await sweep(opts);
    assert.equal(result.remaining, 0);
    assert.equal(result.unknown, 0);
    assert.equal(calls.notify.length, 0);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('取得できない intake は 0 扱いにせず「未取得」として通知する', async () => {
  const { home, opts, calls } = setup(pending, { fail: true });
  try {
    const result = await sweep(opts);
    assert.equal(result.rows[0].remaining, null);
    assert.equal(result.rows[0].status, '未取得');
    assert.equal(result.unknown, 1);
    assert.equal(calls.notify.length, 1);
    assert.match(calls.notify[0], /未取得/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('予算ゲートが deferred なら実装せず翌日へ繰り越す', async () => {
  const { home, opts, calls } = setup(pending);
  try {
    const result = await sweep({ ...opts, gate: () => ({ deferred: true, reason: 'daily_limit' }) });
    assert.equal(calls.exec, 0);
    assert.equal(result.rows[0].deferred, 1);
    const state = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'feedback-zero-state.json'), 'utf8'));
    const job = Object.values(state.jobs)[0];
    assert.equal(job.status, 'deferred');
    assert.ok(job.retryAt > Date.now());
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('完了済み状態の原票は残数に数えない／種別不明は例外／参照キー未設定は取得失敗', async () => {
  const fetchDone = async () => ({ ok: true, json: async () => ({ ok: true, items: [{ message_id: 'z', app_name: 'テストアプリ', status: 'done' }, { message_id: 'y', app_name: 'テストアプリ', status: 'open' }] }) });
  const result = await fetchPending(entry, { T_URL: 'https://relay.invalid/x', T_SECRET: 's' }, fetchDone);
  assert.deepEqual(result.items.map(i => i.message_id), ['y']);
  assert.throws(() => normalizeItem(entry, { message_id: 'q', kind: '???' }), /種別/);
  await assert.rejects(() => fetchPending(entry, {}, fetchDone), /参照キー未設定/);
});
