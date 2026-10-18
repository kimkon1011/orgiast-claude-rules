import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweep, fetchPending, normalizeItem, appConfig, resolveRef } from './feedback-zero-sweep.mjs';

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

test('FEEDBACK_KIM_DISCORD_ID 未設定でも ORGIAST_DISCORD_USER_ID があれば notify を呼び none 以外を返す', async () => {
  const { home, opts, calls } = setup(pending);
  const config = { ...opts.config }; delete config.FEEDBACK_KIM_DISCORD_ID;
  const seen = [];
  const notify = async (text, args) => { seen.push(args); return { delivered: 'dm' }; };
  try {
    const result = await sweep({ ...opts, config, notify });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].userId, undefined);
    assert.notEqual(result.notification.delivered, 'none');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('refs は文字列と配列に対応し、最初の設定済み候補を採用する', () => {
  assert.equal(resolveRef(entry, { T_URL: 'legacy' }, 'url'), 'legacy');
  const e = { refs: { url: ['FIRST', 'SECOND', 'THIRD'] } };
  assert.equal(resolveRef(e, { FIRST: 'first', SECOND: 'second' }, 'url'), 'first');
  assert.equal(resolveRef(e, { FIRST: '', SECOND: 'second', THIRD: 'third' }, 'url'), 'second');
  assert.equal(resolveRef(e, {}, 'url'), undefined);
  assert.equal(resolveRef({ refs: { url: ['bad-key', 'SECOND'] } }, { 'bad-key': 'bad', SECOND: 'ok' }, 'url'), 'ok');
});

test('appDir の候補と汎用キーの衝突はアプリの fallback 値を優先する', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-refs-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'NEXT_PUBLIC_SUPABASE_URL=https://old.invalid\n');
    fs.writeFileSync(path.join(dir, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://app.invalid\nSUPABASE_SERVICE_ROLE_KEY=app-dummy\n');
    const e = { intake: 'supabase', refs: { appDir: ['FIRST_DIR', 'APP_DIR'], url: ['AUJUST_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'], secret: ['AUJUST_SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] } };
    const config = { APP_DIR: dir, NEXT_PUBLIC_SUPABASE_URL: 'https://other.invalid', SUPABASE_SERVICE_ROLE_KEY: 'other-dummy' };
    const merged = appConfig(e, config);
    await fetchPending(e, merged, async (url, opts) => {
      assert.equal(url.hostname, 'app.invalid');
      assert.equal(opts.headers.apikey, 'app-dummy');
      return { ok: true, json: async () => [] };
    });
    assert.equal(resolveRef(e, appConfig(e, { ...config, AUJUST_SUPABASE_URL: 'explicit' }), 'url'), 'explicit');
    assert.equal(appConfig({ refs: { appDir: 'APP_DIR', url: 'NEXT_PUBLIC_SUPABASE_URL' } }, config).NEXT_PUBLIC_SUPABASE_URL, 'https://other.invalid');
    assert.equal(resolveRef(e, appConfig(e, { NEXT_PUBLIC_SUPABASE_URL: 'shared' }), 'url'), 'shared');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('supabase page_path の包含・除外とフィルタ未指定、ページングを保つ', async () => {
  const registry = JSON.parse(fs.readFileSync(new URL('./feedback-zero-registry.json', import.meta.url), 'utf8'));
  const sales = registry.apps.find(e => e.appName === 'aujust／営業自動化');
  const paths = ['/dashboard', '/customers/1', '/deals/1', '/admin/inquiries/1', '/cases/1', '/help/【購買部】備品', '/requests/self-purchase', null];
  const rows = paths.map((page_path, i) => ({ id: String(i), page_path, status: 'open' }));
  rows.push({ id: 'done', page_path: '/dashboard', status: 'done' });
  const config = { AUJUST_SUPABASE_URL: 'https://app.invalid', AUJUST_SUPABASE_SERVICE_ROLE_KEY: 'dummy' };
  const fetchImpl = async () => ({ ok: true, json: async () => rows });
  assert.deepEqual((await fetchPending(sales, config, fetchImpl)).items.map(r => r.id), ['0', '1', '2', '7']);
  assert.equal((await fetchPending({ ...sales, filter: undefined }, config, fetchImpl)).items.length, 8);
  const included = { ...sales, filter: { pagePathInclude: ['/customers', '/deals'], pagePathExclude: ['/deals'] } };
  assert.deepEqual((await fetchPending(included, config, fetchImpl)).items.map(r => r.id), ['1']);
  let calls = 0;
  const paged = await fetchPending(sales, config, async () => {
    calls++;
    return { ok: true, json: async () => calls === 1 ? Array.from({ length: 500 }, (_, i) => ({ id: `excluded-${i}`, page_path: '/cases/1' })) : [rows[0]] };
  });
  assert.equal(calls, 2);
  assert.deepEqual(paged.items, [rows[0]]);
});
