import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { injectFeedbackTodos, runIntake } from './booth-feedback-intake.mjs';
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

function harness({ next = '', ledger, fetchImpl = async () => response(api) } = {}) {
  const files = new Map([
    [HOME_FILE('booth-feedback.env'), 'BOOTH_FEEDBACK_URL=https://example.test/exec\nBOOTH_FEEDBACK_TOKEN=secret\n'],
    [HOME_FILE('next-session.md'), next],
  ]);
  if (ledger !== undefined) files.set(HOME_FILE('booth-feedback-ledger.json'), ledger);
  const writes = [];
  const stdout = [];
  const stderr = [];
  const io = {
    read: (file) => { if (!files.has(file)) throw new Error('ENOENT'); return files.get(file); },
    write: (file, text) => { writes.push({ file, text }); files.set(file, text); },
    now: () => new Date('2026-08-28T03:00:00.000Z'),
    stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text),
  };
  return { files, writes, stdout, stderr, io, fetchImpl };
}

const original = `前書き\r\n<!-- NEXT-SESSION v1 -->\r\n## 次の1目的\r\n目的A\r\n## 残TODO（次の1件を先頭に）\r\n1. 既存A\r\n3. 既存C\r\n## 完了条件\r\ngreen\r\n<!-- NEXT-SESSION v1 -->\r\n## 残TODO\r\n1. 履歴\r\n`;

test('新着を先頭ブロックの残TODO末尾へ続き番号で追記し、安全ゲートに掛ける', () => {
  const result = injectFeedbackTodos(original, [item], api.sheetUrl);
  assert.equal(result.injected.length, 1);
  assert.match(result.text, /^4\. \*\*\[FB:fb-123\]/m);
  assert.match(result.text, /着手可否は kim 判断待ち/);
  const todo = parseHandoff(result.text).todos.find((value) => value.includes('[FB:fb-123]'));
  assert.equal(todoExclusionReason(todo), '判断待ち');
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
  assert.equal(parsed.todos.length, 1);
  assert.match(parsed.todos[0], /\[FB:fb-123\]/);
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
  assert.equal(await runIntake({ args: ['--dry-run'], home: HOME, io: h.io, fetchImpl: h.fetchImpl }), 0);
  assert.equal(h.writes.length, 0);
  assert.match(h.stdout[0], /would-inject=1/);
  assert.match(h.stdout[0], /\[FB:fb-123\]/);
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
