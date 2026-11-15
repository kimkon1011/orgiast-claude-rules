import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addItem, resolveById, resolveBySession, listItems, hasOpenForSession,
  selectForInterrupt, markShown, contextHook, isMachinePrompt, INTERRUPT_REPEAT_MS, main,
} from './urgent-blocker.mjs';

function home(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ub-test-'));
  fs.mkdirSync(path.join(h, '.claude'));
  t.after(() => fs.rmSync(h, { force: true, recursive: true }));
  return h;
}

test('登録→一覧→解決の基本経路', t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 'LINEログイン画像認証待ち', ask: 'LINE公式アカウントにログイン（2分）', link: 'https://example.com/login' });
  assert.match(item.id, /^ub-\d{14}-[a-f0-9]{4}$/);
  assert.equal(item.status, 'open');
  assert.equal(listItems(h, { status: 'open' }).length, 1);
  assert.equal(hasOpenForSession(h, 'sess-A'), true);
  const resolved = resolveById(h, item.id);
  assert.equal(resolved.status, 'resolved');
  assert.equal(listItems(h, { status: 'open' }).length, 0);
  assert.equal(hasOpenForSession(h, 'sess-A'), false);
});

test('resolveBySession はそのセッションの open だけを解決する', t => {
  const h = home(t);
  const a = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  const b = addItem(h, { session: 'sess-A', title: 't', ask: 'b' });
  const c = addItem(h, { session: 'sess-B', title: 't', ask: 'c' });
  const resolved = resolveBySession(h, 'sess-A');
  assert.deepEqual(resolved.map(i => i.id).sort(), [a.id, b.id].sort());
  assert.equal(listItems(h, { status: 'open' }).map(i => i.id).join(','), c.id);
});

test('addItem は必須引数が無いとエラー', t => {
  const h = home(t);
  assert.throws(() => addItem(h, { session: '', title: 't', ask: 'a' }), /--session/);
  assert.throws(() => addItem(h, { session: 's', title: '', ask: 'a' }), /--title/);
  assert.throws(() => addItem(h, { session: 's', title: 't', ask: '' }), /--ask/);
});

test('selectForInterrupt: 別セッションの open だけ選び、自セッションは選ばない', () => {
  const items = [
    { id: 'ub-a', session: 'sess-A', title: 't', ask: 'a', status: 'open', createdAt: '2026-11-10T00:00:00Z', shownSessions: {} },
    { id: 'ub-b', session: 'sess-B', title: 't', ask: 'b', status: 'open', createdAt: '2026-11-10T00:00:00Z', shownSessions: {} },
    { id: 'ub-c', session: 'sess-A', title: 't', ask: 'c', status: 'resolved', createdAt: '2026-11-10T00:00:00Z', shownSessions: {} },
  ];
  const selected = selectForInterrupt(items, { sessionId: 'sess-B', now: Date.parse('2026-11-10T01:00:00Z') });
  assert.deepEqual(selected.map(i => i.id), ['ub-a']);
});

test('selectForInterrupt: 60分以内の再表示はしない・60分過ぎれば再表示', () => {
  const shown = Date.parse('2026-11-10T01:30:00Z');
  const items = [{ id: 'ub-a', session: 'sess-A', title: 't', ask: 'a', status: 'open', createdAt: '2026-11-10T00:00:00Z', shownSessions: { 'sess-B': '2026-11-10T01:30:00Z' } }];
  assert.equal(selectForInterrupt(items, { sessionId: 'sess-B', now: shown + INTERRUPT_REPEAT_MS - 1 }).length, 0);
  assert.equal(selectForInterrupt(items, { sessionId: 'sess-B', now: shown + INTERRUPT_REPEAT_MS }).length, 1);
});

test('selectForInterrupt: cron 由来プロンプトには注入しない', () => {
  const items = [{ id: 'ub-a', session: 'sess-A', title: 't', ask: 'a', status: 'open', createdAt: '2026-11-10T00:00:00Z', shownSessions: {} }];
  for (const prompt of ['【定期の進捗確認】', '【続き・自動】', '[cron] x', '<scheduled-task> y']) {
    assert.equal(selectForInterrupt(items, { sessionId: 'sess-B', now: Date.now(), prompt }).length, 0, prompt);
  }
  assert.equal(selectForInterrupt(items, { sessionId: 'sess-B', now: Date.now(), prompt: '普通の依頼' }).length, 1);
});

test('isMachinePrompt は先頭の cron 標識だけを拾う', () => {
  assert.equal(isMachinePrompt('【定期の進捗確認】進めて'), true);
  assert.equal(isMachinePrompt('【続き・自動】次の手'), true);
  assert.equal(isMachinePrompt('[cron] 時刻'), true);
  assert.equal(isMachinePrompt('普通の依頼【定期の進捗確認】'), false);
});

test('contextHook: 別セッションの blocker を割り込み表示し、同セッション・headless は出さない', t => {
  const h = home(t);
  addItem(h, { session: 'sess-A', title: 'LINEログイン画像認証待ち', ask: 'ログイン（2分）', link: 'https://example.com/login' });
  const out = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'こんにちは' }, { home: h, now: () => Date.now(), env: {} });
  assert.ok(out);
  assert.match(out.hookSpecificOutput.additionalContext, /🚨 割り込み/);
  assert.match(out.hookSpecificOutput.additionalContext, /LINEログイン画像認証待ち/);
  assert.match(out.hookSpecificOutput.additionalContext, /https:\/\/example.com\/login/);
  // 同セッションには出さない
  assert.equal(contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-A', prompt: 'x' }, { home: h, now: () => Date.now(), env: {} }), null);
  // headless には出さない
  assert.equal(contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => Date.now(), env: { CLAUDE_HEADLESS: '1' } }), null);
});

test('contextHook: 一度表示した blocker は60分以内に同じセッションへ再表示しない', t => {
  const h = home(t);
  addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  const env = {};
  const first = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => 1000, env });
  assert.ok(first);
  const second = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => 1000 + 60_000, env });
  assert.equal(second, null);
  const third = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => 1000 + 61 * 60_000, env });
  assert.ok(third);
});

test('CLI: --add / --list / --resolve の入出力', async t => {
  const h = home(t);
  const out = [];
  const run = args => main(args, { home: h, stdout: s => out.push(s), stderr: () => {}, readStdin: async () => '{}' });
  assert.equal(await run(['--add', '--session', 'sess-A', '--title', '止まってる', '--ask', 'ログインして']), 0);
  const added = JSON.parse(out.pop());
  assert.match(added.id, /^ub-\d{14}-[a-f0-9]{4}$/);
  assert.equal(await run(['--list', '--json']), 0);
  const listed = JSON.parse(out.pop());
  assert.equal(listed.length, 1);
  assert.equal(await run(['--resolve', added.id]), 0);
  const resolved = JSON.parse(out.pop());
  assert.equal(resolved.status, 'resolved');
  assert.equal(await run(['--list', '--open', '--json']), 0);
  assert.equal(JSON.parse(out.pop()).length, 0);
  assert.equal(await run(['--unknown']), 1);
});

test('markShown は対象 id の shownSessions だけを更新する', t => {
  const h = home(t);
  const a = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  const b = addItem(h, { session: 'sess-A', title: 't', ask: 'b' });
  markShown(h, [a.id], 'sess-B', new Date('2026-11-10T01:00:00Z'));
  const items = listItems(h);
  assert.ok(items.find(i => i.id === a.id).shownSessions['sess-B']);
  assert.deepEqual(items.find(i => i.id === b.id).shownSessions, {});
});
