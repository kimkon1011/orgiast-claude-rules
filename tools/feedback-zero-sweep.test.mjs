import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sweep, sweepExitCode, unknownRowsLine, fetchPending, normalizeItem, appConfig, appDirectory, issueState } from './feedback-zero-sweep.mjs';

test('Issue状態は一時失敗後に再試行して成功する', () => {
  const calls = [], sleeps = [];
  const issue = { state: 'OPEN', url: 'u', title: 't' };
  const gh = args => {
    calls.push(args);
    return calls.length === 1 ? { status: 1 } : { status: 0, stdout: JSON.stringify(issue) };
  };
  assert.deepEqual(issueState({ number: 42, repo: 'o/r' }, gh, { sleep: ms => sleeps.push(ms) }), issue);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], ['issue', 'view', '42', '--repo', 'o/r', '--json', 'state,url,title']);
  assert.deepEqual(calls[1], calls[0]);
  assert.deepEqual(sleeps, [2000]);
});

test('Issue状態は3回失敗すると理由を含む例外を返す', () => {
  for(const [result, detail] of [
    [{ status: 1 }, 'status=1'],
    [{ status: 1, error: new Error('network down') }, 'status=1 / network down'],
    [{ error: new Error('spawn failed') }, 'spawn failed'],
  ]) {
    let calls = 0;
    const sleeps = [];
    assert.throws(() => issueState({ number: 42, repo: 'o/r' }, () => { calls++; return result; }, {
      sleep: ms => sleeps.push(ms),
    }), { message: `Issue状態 未取得 (${detail})` });
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [2000, 4000]);
  }
});

test('Issue状態は不正なJSONやstateを再試行しない', () => {
  for(const [stdout, message] of [['invalid JSON', /JSON/], ['{"state":"UNKNOWN"}', /Issue状態 不正/]]) {
    let calls = 0;
    const sleeps = [];
    assert.throws(() => issueState({ number: 42, repo: 'o/r' }, () => { calls++; return { status: 0, stdout }; }, {
      sleep: ms => sleeps.push(ms),
    }), message);
    assert.equal(calls, 1);
    assert.deepEqual(sleeps, []);
  }
});

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

test('終了コードは正常な0件を成功とし、実際の失敗を維持する', () => {
  const empty = { dryRun: false, remaining: 0, unknown: 0, notification: { delivered: 'dm' } };
  const cases = [
    ['0件・DM成功', {}, 0],
    ['0件・通知不要', { notification: { delivered: 'none' } }, 0],
    ['残件あり・DM成功', { remaining: 2 }, 0],
    ['0件・取得失敗・DM成功', { unknown: 1 }, 1],
    ['残件あり・通知未達', { remaining: 2, notification: { delivered: 'none' } }, 1],
    ['0件・通知失敗', { notification: { delivered: 'none', reason: '送信失敗' } }, 1],
    ['0件・宛先未設定', { notification: { delivered: 'none', reason: '宛先未設定' } }, 1],
    ['0件・DM以外', { notification: { delivered: 'webhook' } }, 1],
    ['dry-run・残件あり・通知なし', { dryRun: true, remaining: 2, notification: { delivered: 'none' } }, 0],
    ['dry-run・取得失敗', { dryRun: true, unknown: 1 }, 1],
  ];
  for(const [name, overrides, expected] of cases) {
    assert.equal(sweepExitCode({ ...empty, ...overrides }), expected, name);
  }
});

test('0件でも必須設定欠落・完了通知の例外は失敗になる', async () => {
  for(const failure of ['config', 'done']) {
    const { home, opts } = setup([]);
    try {
      if(failure === 'config') delete opts.config.T_SECRET;
      else opts.done = async () => { throw new Error('送信失敗'); };
      const result = await sweep(opts);
      assert.equal(result.remaining, 0);
      assert.equal(result.unknown, 1);
      assert.equal(result.notification.delivered, 'dm');
      assert.equal(sweepExitCode(result), 1);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

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
    assert.equal(sweepExitCode(result), 0);
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
    assert.equal(sweepExitCode(result), 1);
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


test('refs 配列は最初の設定値を採用し、文字列指定と appDir も互換', async () => {
  const { home, opts } = setup([]);
  try {
    const multi = { ...entry, refs: { ...entry.refs, url: ['PRIMARY_URL', 'T_URL'], secret: ['PRIMARY_SECRET', 'T_SECRET'], appDir: ['MISSING_DIR', 'T_DIR'] } };
    fs.writeFileSync(path.join(opts.config.T_DIR, '.env.local'), 'LOCAL_MARKER=loaded\n');
    assert.equal(appConfig(multi, opts.config).LOCAL_MARKER, 'loaded');
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push([url.hostname, options.headers.Authorization]);
      return { ok: true, json: async () => ({ ok: true, items: [] }) };
    };
    await fetchPending(multi, { ...opts.config, PRIMARY_URL: 'https://primary.invalid', PRIMARY_SECRET: 'primary' }, fetchImpl);
    await fetchPending(multi, { ...opts.config, PRIMARY_URL: '', PRIMARY_SECRET: '' }, fetchImpl);
    await fetchPending(entry, opts.config, fetchImpl);
    assert.deepEqual(seen, [['primary.invalid', 'Bearer primary'], ['relay.invalid', 'Bearer dummy'], ['relay.invalid', 'Bearer dummy']]);
    await assert.rejects(fetchPending(multi, {}, fetchImpl), /url 参照キー未設定/);
    assert.equal(appDirectory('C:\\Users\\app', 'linux'), '/mnt/c/Users/app');
    assert.equal(appDirectory('D:/app', 'linux'), '/mnt/d/app');
    assert.equal(appDirectory('C:\\Users\\app', 'win32'), 'C:\\Users\\app');
    assert.equal(appDirectory('/native/app', 'linux'), '/native/app');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('supabase page_path は前方一致で include 後に exclude、未指定なら全件', async () => {
  const registry = JSON.parse(fs.readFileSync(new URL('./feedback-zero-registry.json', import.meta.url), 'utf8'));
  const sales = registry.apps.find(e => e.appName === 'aujust／営業自動化');
  const rows = ['/dashboard', '/customers/1', '/deals/2', '/cases/1', '/help/【購買部】備品', '/requests/self-purchase', '/admin/inquiries/1', null, '/unknown'].map((page_path, id) => ({ id: String(id), page_path, status: 'open' }));
  rows.push({ id: 'done', page_path: '/dashboard', status: 'done' });
  const fetchImpl = async () => ({ ok: true, json: async () => rows });
  const config = { AUJUST_SUPABASE_URL: 'https://db.invalid', AUJUST_SUPABASE_SERVICE_ROLE_KEY: 'dummy' };
  assert.deepEqual((await fetchPending(sales, config, fetchImpl)).items.map(r => r.id), ['0', '1', '2']);
  assert.equal((await fetchPending({ ...sales, pagePathInclude: undefined, pagePathExclude: undefined }, config, fetchImpl)).items.length, 9);
  assert.deepEqual((await fetchPending({ ...sales, pagePathInclude: ['/'], pagePathExclude: ['/customers/', '/deals/', '/cases/', '/help/', '/requests/', '/admin/', '/unknown'] }, config, fetchImpl)).items.map(r => r.id), ['0']);
  assert.equal((await fetchPending({ ...sales, pagePathInclude: undefined }, config, fetchImpl)).items.length, 5);
});

test('汎用名の衝突はアプリ内 .env.local を優先し専用キーの明示指定を維持', async () => {
  const { home, opts } = setup([]);
  try {
    const multi = { ...entry, refs: { ...entry.refs, url: ['AUJUST_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL'], secret: ['AUJUST_SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SERVICE_ROLE_KEY'] } };
    fs.writeFileSync(path.join(opts.config.T_DIR, '.env'), 'NEXT_PUBLIC_SUPABASE_URL=https://env.invalid\nSUPABASE_SERVICE_ROLE_KEY=env-dummy\n');
    fs.writeFileSync(path.join(opts.config.T_DIR, '.env.local'), 'NEXT_PUBLIC_SUPABASE_URL=https://local.invalid\nSUPABASE_SERVICE_ROLE_KEY=local-dummy\n');
    const config = { ...opts.config, NEXT_PUBLIC_SUPABASE_URL: 'https://global.invalid', SUPABASE_SERVICE_ROLE_KEY: 'global-dummy' };
    const seen = [];
    const fetchImpl = async (url, options) => {
      seen.push([url.hostname, options.headers.Authorization]);
      return { ok: true, json: async () => ({ ok: true, items: [] }) };
    };
    await fetchPending(multi, appConfig(multi, config), fetchImpl);
    await fetchPending(multi, appConfig(multi, { ...config, AUJUST_SUPABASE_URL: 'https://explicit.invalid', AUJUST_SUPABASE_SERVICE_ROLE_KEY: 'explicit-dummy' }), fetchImpl);
    assert.deepEqual(seen, [['local.invalid', 'Bearer local-dummy'], ['explicit.invalid', 'Bearer explicit-dummy']]);
    assert.equal(config.SUPABASE_SERVICE_ROLE_KEY, 'global-dummy');
    fs.rmSync(path.join(opts.config.T_DIR, '.env.local'));
    fs.rmSync(path.join(opts.config.T_DIR, '.env'));
    assert.equal(appConfig(multi, config).SUPABASE_SERVICE_ROLE_KEY, 'global-dummy');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

 test('repo 参照キー未設定は dry-run でも errors と unknown に含め副作用を起こさない', async () => {
  const { home, opts, calls } = setup(pending);
  delete opts.config.T_REPO;
  try {
    const result = await sweep({ ...opts, dryRun: true });
    assert.deepEqual(result.rows[0].errors, ['反映先 repo 参照キー未設定']);
    assert.equal(result.unknown, 1);
    assert.equal(result.rows[0].queued, 0);
    assert.equal(calls.issue + calls.exec + calls.notify.length, 0);
    assert.equal(fs.existsSync(path.join(home, '.claude', 'feedback-zero-state.json')), false);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});


test('専用経路は repo 未設定でも残数を報告し dry-run・実行とも Issue 化や実装投入をしない', async () => {
  for (const dryRun of [true, false]) {
    const appName = 'ブース制作アプリ';
    const items = ['booth1', 'booth2'].map(key => ({ key, kind: 'bug', status: 'open', title: '不具合' }));
    const { home, opts, calls } = setup(items);
    delete opts.config.T_REPO;
    fs.writeFileSync(opts.registryFile, JSON.stringify({ version: 1, apps: [{ ...entry, appName, intake: 'booth-sheet' }] }));
    let ghCalls = 0;
    try {
      const result = await sweep({ ...opts, dryRun, gh: () => { ghCalls++; throw new Error('unexpected gh call'); } });
      assert.equal(result.remaining, 2);
      assert.equal(result.rows[0].remaining, 2);
      assert.equal(result.rows[0].status, '取得済');
      assert.deepEqual(result.rows[0].errors, []);
      assert.equal(result.rows[0].queued, 0);
      assert.equal(result.unknown, 0);
      assert.equal(result.launched, 0);
      assert.equal(calls.issue + calls.exec + ghCalls, 0);
      assert.equal(fs.existsSync(path.join(home, '.claude', 'feedback-zero-state.json')), false);
      assert.equal(calls.notify.length, dryRun ? 0 : 1);
      if (!dryRun) assert.ok(calls.notify[0].includes('ブース制作アプリ: 2件 / 取得済'));
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('unknownRowsLine は失敗したアプリと理由を1行にまとめ、成功時は空', () => {
  assert.equal(unknownRowsLine({ rows: [{ appName: 'A', status: '取得済', errors: [] }] }), '');
  assert.equal(
    unknownRowsLine({ rows: [
      { appName: 'A', status: '取得済', errors: ['Issue化失敗: Issue lookup failed (status=1)'] },
      { appName: 'B', status: '未取得', errors: [] },
    ] }),
    'unknown_rows=A:Issue化失敗: Issue lookup failed (status=1); B:未取得',
  );
});

test('空の原票でも台帳のIssue照合が一時失敗する：回復後はunknownを残さずexit 0', async () => {
  for (const dryRun of [true, false]) {
    const { home, opts, calls } = setup([]);
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', 'feedback-issue-ledger.json'), JSON.stringify({
      items: [{ app_name: entry.appName, message_id: 'resolved', repo: 'o/r', number: 42 }],
    }));
    let attempts = 0;
    try {
      const result = await sweep({ ...opts, dryRun, gh: () => ++attempts === 1
        ? { status: 1 }
        : { status: 0, stdout: JSON.stringify({ state: 'CLOSED' }) } });
      assert.equal(sweepExitCode(result), 0);
      assert.equal(attempts, 2);
      assert.equal(result.remaining, 0);
      assert.equal(result.unknown, 0);
      assert.deepEqual(result.rows[0].errors, []);
      assert.equal(result.rows[0].queued, 0);
      assert.equal(result.rows[0].deferred, 0);
      assert.deepEqual(result.notification, { delivered: 'none' });
      assert.equal(sweepExitCode(result), 0);
      assert.equal(unknownRowsLine(result), '');
      assert.equal(calls.issue + calls.exec + calls.notify.length, 0);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});

test('queued/deferredが0でもIssue照合の再試行枯渇はexit 1', async () => {
  const { home, opts } = setup([]);
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'feedback-issue-ledger.json'), JSON.stringify({
    items: [{ app_name: entry.appName, message_id: 'unresolved', repo: 'o/r', number: 42 }],
  }));
  let attempts = 0;
  try {
    const result = await sweep({ ...opts, dryRun: true, gh: () => { attempts++; return { status: 1 }; } });
    assert.equal(attempts, 3);
    assert.equal(result.unknown, 1);
    assert.equal(result.rows[0].queued, 0);
    assert.equal(result.rows[0].deferred, 0);
    assert.equal(sweepExitCode(result), 1);
    assert.match(unknownRowsLine(result), /Issue状態 未取得 \(status=1\)/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('queued/deferredが0でもAPI恒久失敗はdry-run・通常ともexit 1', async () => {
  for (const dryRun of [true, false]) {
    const { home, opts, calls } = setup([]);
    try {
      const result = await sweep({ ...opts, dryRun, fetchImpl: async () => ({ ok: false, status: 403 }) });
      assert.equal(result.unknown, 1);
      assert.equal(result.rows[0].queued, 0);
      assert.equal(result.rows[0].deferred, 0);
      assert.deepEqual(result.rows[0].errors, ['HTTP 403']);
      assert.equal(sweepExitCode(result), 1);
      assert.equal(calls.issue + calls.exec, 0);
    } finally { fs.rmSync(home, { recursive: true, force: true }); }
  }
});
