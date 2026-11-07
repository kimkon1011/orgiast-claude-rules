import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { injectFeedbackTodos, immediateThrottleReason, planFeedbackLedgerSync, runIntake, syncCompletedFeedback, webhookFrom } from './booth-feedback-intake.mjs';
import { firstBlockBounds, sectionFrom, parseHandoff, todoExclusionReason } from './auto-session.mjs';

// path.sep 始まりにして Windows/POSIX どちらでも io スタブのキーと一致させる
// （POSIX 決め打ちのパスにすると Windows では path.join の区切りとズレて全部 ENOENT になる）
const HOME = path.join(path.sep, 'home', 'test');
const HOME_FILE = (name) => path.join(HOME, '.claude', name);

const item = {
  key: 'fb-123', ts: '2026-08-28 12:30', kind: '要望', title: 'アサイン依頼の文章',
  body: '文章をもっと分かりやすくしてください', status: 'new', source: 'ダイアログ(案件A)', images: [],
};
const api = { ok: true, sheetUrl: 'https://docs.google.com/spreadsheets/d/x/edit', counts: { open: 1, total: 3 }, items: [item] };

function response(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => typeof body === 'string' ? body : JSON.stringify(body) };
}

function harness({ next = '', ledger, fetchImpl = async () => response(api), spawnImpl } = {}) {
  const files = new Map([
    [HOME_FILE('booth-feedback.env'), 'BOOTH_FEEDBACK_URL=https://example.test/exec\nBOOTH_FEEDBACK_TOKEN=secret\n'],
    [HOME_FILE('next-session.md'), next],
  ]);
  if (ledger !== undefined) files.set(HOME_FILE('booth-feedback-ledger.json'), ledger);
  const writes = [];
  const stdout = [];
  const stderr = [];
  const spawns = [];
  const io = {
    read: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    write: (file, text) => { writes.push({ file, text }); files.set(file, text); },
    now: () => new Date('2026-08-28T03:00:00.000Z'),
    stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text),
    append: (file, text) => { writes.push({ file, text, append: true }); files.set(file, `${files.get(file) || ''}${text}`); },
    exists: (file) => files.has(file),
    pidAlive: () => false,
    spawn: (...args) => { spawns.push(args); return spawnImpl ? spawnImpl(...args) : { unref() {} }; },
  };
  return { files, writes, stdout, stderr, spawns, io, fetchImpl };
}

const original = `前書き\r\n<!-- NEXT-SESSION v1 -->\r\n## 次の1目的\r\n目的A\r\n## 残TODO（次の1件を先頭に）\r\n1. 既存A\r\n3. 既存C\r\n## 完了条件\r\ngreen\r\n<!-- NEXT-SESSION v1 -->\r\n## 残TODO\r\n1. 履歴\r\n`;

test('新規注入は残TODOセクション先頭に入り、種別ごとの実行可否を保つ', () => {
  for (const [kind, marker, excluded] of [
    ['不具合', '【即実行・不具合】', ''],
    ['要望', '【当日夜に実行・要望】', ''],
    ['', '【種別不明】', '判断待ち'],
  ]) {
    const result = injectFeedbackTodos(original, [{ ...item, kind }], api.sheetUrl);
    assert.equal(result.injected.length, 1);
    assert.match(result.text, /## 残TODO（次の1件を先頭に）\r\n1\. \*\*\[FB:fb-123\]/);
    assert.match(result.text, /\r\n2\. 既存A\r\n3\. 既存C\r\n/);
    assert.ok(result.text.indexOf('[FB:fb-123]') < result.text.indexOf('既存A'));
    assert.match(result.text, new RegExp(marker));
    const todo = parseHandoff(result.text).todos.find((value) => value.includes('[FB:fb-123]'));
    assert.equal(todoExclusionReason(todo), excluded);
    assert.equal(todo.includes('判断待ち'), kind === '');
  }
});

test('即実行は1時間2回・1日6回で throttle する', () => {
  const now = new Date('2026-08-28T12:00:00.000Z');
  assert.equal(immediateThrottleReason([{ at: '2026-08-28T11:10:00.000Z' }, { at: '2026-08-28T11:50:00.000Z' }], now), 'hourly-limit');
  assert.equal(immediateThrottleReason(Array.from({ length: 6 }, (_, index) => ({ at: `2026-08-28T0${index}:00:00.000Z` })), now), 'daily-limit');
});

test('不具合の新規注入は detached launcher を起動し台帳へ記録する', async () => {
  const bug = { ...item, kind: '不具合' };
  const h = harness({ next: original, fetchImpl: async () => response({ ...api, items: [bug] }) });
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  assert.equal(h.spawns.length, 1);
  // #422: win32 は detached が CREATE_NO_WINDOW を無効化するため windowsHide のみ。
  if (process.platform === 'win32') {
    assert.equal(h.spawns[0][2].windowsHide, true);
    assert.notEqual(h.spawns[0][2].detached, true);
  } else {
    assert.equal(h.spawns[0][2].detached, true);
  }
  assert.equal(h.spawns[0][2].stdio, 'ignore');
  const saved = JSON.parse(h.files.get(HOME_FILE('booth-feedback-ledger.json')));
  assert.equal(saved.items['fb-123'].immediateLaunchedAt, '2026-08-28T03:00:00.000Z');
  assert.deepEqual(saved.immediateLaunches, [{ at: '2026-08-28T03:00:00.000Z', key: 'fb-123' }]);
});

test('起動上限では immediate-throttled を記録して spawn しない', async () => {
  const launches = [{ at: '2026-08-28T02:10:00.000Z', key: 'a' }, { at: '2026-08-28T02:50:00.000Z', key: 'b' }];
  const ledger = JSON.stringify({ version: 1, items: {}, immediateLaunches: launches });
  const bug = { ...item, kind: '不具合' };
  const h = harness({ next: original, ledger, fetchImpl: async () => response({ ...api, items: [bug] }) });
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  assert.equal(h.spawns.length, 0);
  assert.match(h.stderr.join('\n'), /immediate-throttled reason=hourly-limit/);
  const saved = JSON.parse(h.files.get(HOME_FILE('booth-feedback-ledger.json')));
  assert.equal(saved.items['fb-123'].immediateThrottledAt, '2026-08-28T03:00:00.000Z');
});

test('残TODO以外のバイト列を変更しない', () => {
  const result = injectFeedbackTodos(original, [item], api.sheetUrl).text;
  const outside = (text) => {
    const bounds = firstBlockBounds(text);
    const block = text.slice(bounds.start, bounds.end);
    const section = sectionFrom(block, '残TODO');
    return text.slice(0, bounds.start) + block.slice(0, block.indexOf(section)) + block.slice(block.indexOf(section) + section.length) + text.slice(bounds.end);
  };
  assert.equal(outside(result), outside(original));
});

test('台帳があれば2回目は増えない', async () => {
  const h = harness({ next: original });
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  const once = h.files.get(HOME_FILE('next-session.md'));
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  assert.equal(h.files.get(HOME_FILE('next-session.md')), once);
  assert.equal((once.match(/\[FB:fb-123\]/g) || []).length, 1);
});

test('台帳を消しても本文のキーで冪等になる', async () => {
  const once = injectFeedbackTodos(original, [item], api.sheetUrl).text;
  const h = harness({ next: once });
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  assert.equal(h.files.get(HOME_FILE('next-session.md')), once);
  assert.equal((once.match(/\[FB:fb-123\]/g) || []).length, 1);
});

test('台帳に injectedAt があっても本文から消えた open 項目は再注入し、履歴を更新する', async () => {
  const ledger = JSON.stringify({
    version: 1,
    items: { 'fb-123': { injectedAt: '2026-08-27T03:00:00.000Z' } },
  });
  const h = harness({ next: original, ledger });
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  assert.equal((h.files.get(HOME_FILE('next-session.md')).match(/\[FB:fb-123\]/g) || []).length, 1);
  const saved = JSON.parse(h.files.get(HOME_FILE('booth-feedback-ledger.json')));
  assert.equal(saved.items['fb-123'].injectedAt, '2026-08-28T03:00:00.000Z');
  assert.equal(saved.items['fb-123'].reinjectedCount, 1);
  assert.match(h.stdout[0], /new=0 reinjected=1 injected=1/);
});

test('本文にキーがあれば台帳の injectedAt の有無にかかわらず再注入数は増えない', async () => {
  const once = injectFeedbackTodos(original, [item], api.sheetUrl).text;
  for (const ledger of [undefined, JSON.stringify({ version: 1, items: { 'fb-123': { injectedAt: '2026-08-27T03:00:00.000Z', reinjectedCount: 2 } } })]) {
    const h = harness({ next: once, ledger });
    assert.equal(await runIntake({ args: ['--json'], home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
    const summary = JSON.parse(h.stdout[0]);
    assert.equal(summary.reinjected, 0);
    assert.equal(h.files.get(HOME_FILE('next-session.md')), once);
    const saved = JSON.parse(h.files.get(HOME_FILE('booth-feedback-ledger.json')));
    assert.equal(saved.items['fb-123'].reinjectedCount ?? 0, ledger === undefined ? 0 : 2);
  }
});

test('残TODOが無ければ先頭ブロック末尾にセクションを作る', () => {
  const md = `前\n<!-- NEXT-SESSION v1 -->\n## 対象\nrepo\n<!-- NEXT-SESSION v1 -->\n## 残TODO\n1. 古い\n`;
  const result = injectFeedbackTodos(md, [item], api.sheetUrl).text;
  const parsed = parseHandoff(result);
  assert.deepEqual(parsed.todoBlocks, [1, 2]);
  assert.match(parsed.todos[0], /\[FB:fb-123\]/);
  assert.equal(parsed.todos[1], '古い');
  assert.match(parsed.block, /## 残TODO（自動取込）/);
});

for (const [name, fetchImpl] of [
  ['ok:false', async () => response({ ok: false, error: 'denied' })],
  ['タイムアウト', async () => { const error = new Error('timed out'); error.name = 'AbortError'; throw error; }],
  ['HTML', async () => response('<html>login required</html>')],
]) {
  test(`API ${name} では next-session を書かず exit 0`, async () => {
    const h = harness({ next: original, fetchImpl });
    const code = await runIntake({ home: HOME, io: h.io, fetchImpl });
    assert.equal(code, 0);
    assert.equal(h.files.get(HOME_FILE('next-session.md')), original);
    assert.equal(h.writes.length, 0);
    assert.equal(h.stderr.length, 1);
    if (name === 'HTML') assert.match(h.stderr[0], /<html>login required<\/html>/);
  });
}

test('--dry-run は next-session と台帳を更新しない', async () => {
  const h = harness({ next: original });
  let taskLedgerCalls = 0;
  assert.equal(await runIntake({ args: ['--dry-run'], home: HOME, io: h.io, fetchImpl: h.fetchImpl, taskLedger: async () => { taskLedgerCalls++; } }), 0);
  assert.equal(h.writes.length, 0);
  assert.equal(taskLedgerCalls, 0);
  assert.match(h.stdout[0], /would-inject=1/);
  assert.match(h.stdout[0], /\[FB:fb-123\]/);
});

test('新規注入を task-ledger に upsert する', async () => {
  const h = harness({ next: original });
  const calls = [];
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl, taskLedger: async (args) => calls.push(args) }), 0);
  assert.deepEqual(calls.filter((call) => call.command === 'upsert'), [{ command: 'upsert', taskId: 'FB-fb-123', 起票元: 'booth-feedback', 件名: item.title, 依頼元: item.source, 状態: '未着手', 次アクション: '当日夜に実行', 期限: '' }]);
});

test('task-ledger upsert 失敗でも next-session とローカル台帳を更新する', async () => {
  const h = harness({ next: original });
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl, taskLedger: async () => { throw new Error('ledger unavailable'); } }), 0);
  assert.match(h.files.get(HOME_FILE('next-session.md')), /\[FB:fb-123\]/);
  assert.ok(h.files.has(HOME_FILE('booth-feedback-ledger.json')));
  assert.ok(h.stderr.some((line) => /task-ledger upsert 失敗.*ledger unavailable/.test(line)));
});

test('--dry-run の不具合は spawn しない', async () => {
  const bug = { ...item, kind: '不具合' };
  const h = harness({ next: original, fetchImpl: async () => response({ ...api, items: [bug] }) });
  assert.equal(await runIntake({ args: ['--dry-run'], home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  assert.equal(h.spawns.length, 0);
});

test('--dry-run でも本文から消えた項目を再注入対象として数える', async () => {
  const ledger = JSON.stringify({ version: 1, items: { 'fb-123': { injectedAt: '2026-08-27T03:00:00.000Z' } } });
  const h = harness({ next: original, ledger });
  assert.equal(await runIntake({ args: ['--dry-run', '--json'], home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  assert.equal(h.writes.length, 0);
  assert.equal(h.files.get(HOME_FILE('next-session.md')), original);
  assert.equal(JSON.parse(h.stdout[0]).reinjected, 1);
});

test('--resolve 成功時だけ台帳に resolvedAt を記録する', async () => {
  let request;
  const fetchImpl = async (_url, options) => { request = options; return response({ ok: true, rowNumber: 4, previousStatus: 'new' }); };
  const h = harness({ next: original, fetchImpl });
  assert.equal(await runIntake({ args: ['--resolve', 'fb-123', '--note', '修正済み'], home: HOME, io: h.io, fetchImpl }), 0);
  assert.deepEqual(JSON.parse(request.body), { token: 'secret', action: 'resolveFeedback', key: 'fb-123', status: 'done', note: '修正済み' });
  const saved = JSON.parse(h.files.get(HOME_FILE('booth-feedback-ledger.json')));
  assert.equal(saved.items['fb-123'].resolvedAt, '2026-08-28T03:00:00.000Z');
});

test('シート側で閉じられた行を台帳へ書き戻し、タスク台帳の行も閉じる', async () => {
  const ledger = JSON.stringify({ version: 1, items: { 'fb-123': { lastStatus: 'new', title: '古い項目', injectedAt: '2026-08-27T03:00:00.000Z' } } });
  const fetchImpl = async (url) => String(url).includes('status=all')
    ? response({ ...api, items: [{ ...item, status: 'done' }] })
    : response({ ...api, items: [] });
  const h = harness({ next: original, ledger, fetchImpl });
  const calls = [];
  const taskLedger = async (args) => {
    calls.push(args);
    if (args.command === 'list') return { ok: true, rows: [{ taskId: 'FB-fb-123', 件名: '古い項目', 状態: '未着手' }] };
    return { ok: true };
  };
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl, taskLedger }), 0);
  const saved = JSON.parse(h.files.get(HOME_FILE('booth-feedback-ledger.json')));
  assert.equal(saved.items['fb-123'].lastStatus, 'done');
  assert.equal(saved.items['fb-123'].resolvedAt, '2026-08-28T03:00:00.000Z');
  assert.equal(saved.items['fb-123'].closedOnSheet, true);
  assert.ok(calls.some((call) => call.command === 'done' && call.taskId === 'FB-fb-123'));
});

test('全件取得が失敗しても取得・注入は続行する', async () => {
  const fetchImpl = async (url) => String(url).includes('status=all')
    ? response('boom', { ok: false, status: 500 })
    : response(api);
  const h = harness({ next: original, fetchImpl });
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl, taskLedger: async () => {} }), 0);
  assert.match(h.files.get(HOME_FILE('next-session.md')), /\[FB:fb-123\]/);
  assert.match(h.stderr.join('\n'), /全件取得に失敗/);
});

test('不具合通知の webhook は明示キーだけを拾う（無関係 channel への誤爆防止）', () => {
  assert.equal(webhookFrom({ BOOTH_FEEDBACK_WEBHOOK: 'https://x/booth' }, {}), 'https://x/booth');
  assert.equal(webhookFrom({}, { DISCORD_FEEDBACK_WEBHOOK: 'https://x/fb' }), 'https://x/fb');
  // コスト警告など別用途の webhook は拾わない
  assert.equal(webhookFrom({ DISCORD_COST_WEBHOOK: 'https://x/cost', SOME_WEBHOOK: 'https://x/other' }, {}), '');
  assert.equal(webhookFrom(), '');
});

test('archived feedback markers prevent reinjection after queue rotation', async () => {
  const h = harness({ next: original });
  h.files.set(HOME_FILE('archive/next-session-feedback.json'), JSON.stringify(['fb-123']));
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl, taskLedger: async () => {} }), 0);
  assert.equal(h.files.get(HOME_FILE('next-session.md')), original);
});

const ledgerWith = (items) => ({ version: 1, items });

test('planFeedbackLedgerSync はローカルdoneかつ台帳未完了の行だけを対象にする', () => {
  const ledger = ledgerWith({
    'fb-done': { lastStatus: 'done', resolvedAt: '2026-09-05T02:53:22.552Z', title: '直した件' },
    'fb-open': { lastStatus: 'new' },
    'fb-resolved': { resolvedAt: '2026-09-06T00:00:00.000Z' },
  });
  const rows = [
    { taskId: 'FB-fb-done', 件名: '直した件', 状態: '未着手' },
    { taskId: 'FB-fb-open', 件名: 'まだ', 状態: '未着手' },
    { taskId: 'FB-fb-resolved', 件名: '解決済み', 状態: '対応中' },
    { taskId: 'FB-fb-done', 件名: '重複行', 状態: '未着手' },
    { taskId: 'FB-fb-done', 件名: '既に完了', 状態: '完了' },
    { taskId: 'T-OTHER', 件名: '台帳タスク', 状態: '未着手' },
  ];
  assert.deepEqual(planFeedbackLedgerSync(ledger, rows), [
    { taskId: 'FB-fb-done', key: 'fb-done', 件名: '直した件', doneAt: '2026-09-05T02:53:22.552Z' },
    { taskId: 'FB-fb-resolved', key: 'fb-resolved', 件名: '解決済み', doneAt: '2026-09-06T00:00:00.000Z' },
  ]);
});

test('planFeedbackLedgerSync は実形 {ok, rows, count} を読む', () => {
  const ledger = ledgerWith({ 'fb-done': { lastStatus: 'done' } });
  const plan = planFeedbackLedgerSync(ledger, { ok: true, rows: [{ taskId: 'FB-fb-done', 件名: 'x', 状態: '未着手' }], count: 1 });
  assert.equal(plan.length, 1);
});

test('syncCompletedFeedback は done 操作を送り、冪等（2回目は0件）', async () => {
  const ledger = ledgerWith({ 'fb-done': { lastStatus: 'done', resolvedAt: '2026-09-05T02:53:22.552Z' } });
  const rows = [{ taskId: 'FB-fb-done', 件名: '直した件', 状態: '未着手' }];
  const calls = [];
  const taskLedger = async (args) => { calls.push(args); if (args.command === 'list') return { ok: true, rows, count: rows.length }; };
  const first = await syncCompletedFeedback({ ledger, taskLedger, home: HOME });
  assert.deepEqual(first.closed.map((entry) => entry.taskId), ['FB-fb-done']);
  assert.deepEqual(calls[1], { command: 'done', taskId: 'FB-fb-done', 備考: 'ローカル完了記録と同期（2026-09-05T02:53:22.552Z）' });
  // 台帳が完了になったら2回目は対象0件
  rows[0].状態 = '完了';
  const second = await syncCompletedFeedback({ ledger, taskLedger, home: HOME });
  assert.deepEqual(second.planned, []);
  assert.deepEqual(second.closed, []);
});

test('syncCompletedFeedback の dry-run は done を送らない', async () => {
  const ledger = ledgerWith({ 'fb-done': { lastStatus: 'done', resolvedAt: '2026-09-05T02:53:22.552Z' } });
  const calls = [];
  const taskLedger = async (args) => { calls.push(args); return { ok: true, rows: [{ taskId: 'FB-fb-done', 件名: '直した件', 状態: '未着手' }] }; };
  const result = await syncCompletedFeedback({ ledger, taskLedger, home: HOME, dryRun: true });
  assert.equal(result.planned.length, 1);
  assert.deepEqual(result.closed, []);
  assert.deepEqual(calls.map((call) => call.command), ['list']);
});

test('syncCompletedFeedback は1件の done 失敗でも残りを続ける', async () => {
  const ledger = ledgerWith({ a: { lastStatus: 'done' }, b: { lastStatus: 'done' } });
  const rows = [{ taskId: 'FB-a', 件名: 'A', 状態: '未着手' }, { taskId: 'FB-b', 件名: 'B', 状態: '未着手' }];
  const logs = [];
  const taskLedger = async (args) => {
    if (args.command === 'list') return { ok: true, rows };
    if (args.taskId === 'FB-a') throw new Error('boom');
  };
  const result = await syncCompletedFeedback({ ledger, taskLedger, home: HOME, log: (line) => logs.push(line) });
  assert.deepEqual(result.closed.map((entry) => entry.taskId), ['FB-b']);
  assert.ok(logs.some((line) => /FB-a.*boom/.test(line)));
});

test('intake 実行時にローカルdoneの台帳行を閉じる', async () => {
  const ledger = JSON.stringify({ version: 1, items: { 'fb-123': { lastStatus: 'done', resolvedAt: '2026-09-05T02:53:22.552Z' } } });
  const h = harness({ next: original, ledger });
  const calls = [];
  const taskLedger = async (args) => {
    calls.push(args);
    if (args.command === 'list') return { ok: true, rows: [{ taskId: 'FB-fb-123', 件名: '直した件', 状態: '未着手' }], count: 1 };
  };
  assert.equal(await runIntake({ home: HOME, io: h.io, fetchImpl: h.fetchImpl, taskLedger }), 0);
  assert.ok(calls.some((call) => call.command === 'done' && call.taskId === 'FB-fb-123'));
  assert.match(h.stdout[0], /ledger-synced=1/);
});

test('--sync-done --dry-run は対象一覧を出し done を送らない', async () => {
  const ledger = JSON.stringify({ version: 1, items: { 'fb-123': { lastStatus: 'done', resolvedAt: '2026-09-05T02:53:22.552Z' } } });
  const h = harness({ next: original, ledger });
  const calls = [];
  const taskLedger = async (args) => { calls.push(args); return { ok: true, rows: [{ taskId: 'FB-fb-123', 件名: '直した件', 状態: '未着手' }] }; };
  assert.equal(await runIntake({ args: ['--sync-done', '--dry-run', '--json'], home: HOME, io: h.io, fetchImpl: h.fetchImpl, taskLedger }), 0);
  const report = JSON.parse(h.stdout[0]);
  assert.equal(report.dryRun, true);
  assert.deepEqual(report.planned.map((entry) => entry.taskId), ['FB-fb-123']);
  assert.deepEqual(calls.map((call) => call.command), ['list']);
});
