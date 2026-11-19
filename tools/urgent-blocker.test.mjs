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

test('contextHook: 同一セッションで既出件数行を繰り返さない', t => {
  const h = home(t);
  addItem(h, { session: 'sess-A', title: 'blocked', ask: 'do something' });
  const env = {};
  // 別セッション初回 → fresh 表示
  const first = contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'first' },
    { home: h, now: () => 1000, env }
  );
  assert.ok(first);
  assert.match(first.hookSpecificOutput.additionalContext, /🚨 割り込み/);
  // 機械プロンプトは返事として記録せず、表示もしない
  const second = contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: '[cron] progress' },
    { home: h, now: () => 2000, env }
  );
  assert.equal(second, null);
  // 別セッション初回 → 既出件数行
  const third = contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-C', prompt: 'third' },
    { home: h, now: () => 3000, env }
  );
  assert.ok(third);
  assert.match(third.hookSpecificOutput.additionalContext, /既出 1 件/);
  assert.doesNotMatch(third.hookSpecificOutput.additionalContext, /🚨 割り込み/);
  // その別セッション2回目 → null
  const fourth = contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-C', prompt: 'fourth' },
    { home: h, now: () => 4000, env }
  );
  assert.equal(fourth, null);
});

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

test('selectForInterrupt: 旧表示時刻では除外せず共通ポリシーに委ねる', () => {
  const shown = Date.parse('2026-11-10T01:30:00Z');
  const items = [{ id: 'ub-a', session: 'sess-A', title: 't', ask: 'a', status: 'open', createdAt: '2026-11-10T00:00:00Z', shownSessions: { 'sess-B': '2026-11-10T01:30:00Z' } }];
  assert.equal(selectForInterrupt(items, { sessionId: 'sess-B', now: shown + INTERRUPT_REPEAT_MS - 1 }).length, 1);
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
  assert.match(out.hookSpecificOutput.additionalContext, /【表示ルール】/);
  // 同セッションには出さない
  assert.equal(contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-A', prompt: 'x' }, { home: h, now: () => Date.now(), env: {} }), null);
  // headless には出さない
  assert.equal(contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => Date.now(), env: { CLAUDE_HEADLESS: '1' } }), null);
});

test('contextHook: 一度表示した blocker は同じセッションへ再表示しない（INTERRUPT_REPEAT_MS 廃止）', t => {
  const h = home(t);
  addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  const env = {};
  const first = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => 1000, env });
  assert.ok(first);
  const second = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => 1000 + 60_000, env });
  assert.equal(second, null);
  // 60分超えても再表示しない（新ポリシー: 同セッションの既出は再掲しない）
  const third = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => 1000 + 61 * 60_000, env });
  assert.equal(third, null);
  // 別セッションなら再表示（24h超経過）
  const fourth = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-C', prompt: 'x' }, { home: h, now: () => 1000 + 25 * 3600_000, env });
  assert.ok(fourth);
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

test('context: known count across sessions and changed ask becomes fresh', t => {
  const h = home(t), env = {}, now = () => Date.now();
  addItem(h, { session: 'origin', title: 'blocked', ask: 'first ask' });
  const input = { hook_event_name: 'SessionStart', session_id: 'viewer' };
  const first = contextHook(input, { home: h, now, env });
  assert.ok(first);
  const known = contextHook({ ...input, session_id: 'other' }, { home: h, now, env });
  assert.match(known.hookSpecificOutput.additionalContext, /既出 1 件/);
  assert.doesNotMatch(known.hookSpecificOutput.additionalContext, /first ask|応答の冒頭/);
  const file = path.join(h, '.claude', 'urgent-blocker.json');
  const state = JSON.parse(fs.readFileSync(file)); state.items[0].ask = 'changed ask'; fs.writeFileSync(file, JSON.stringify(state));
  assert.match(contextHook({ ...input, hook_event_name: 'UserPromptSubmit', prompt: 'second' }, { home: h, now, env }).hookSpecificOutput.additionalContext, /changed ask/);
});

test('contextHook: 割り込みを見たセッションの次の返事を記録して登録元へ配達する', t => {
  const h = home(t);
  const item = addItem(h, { session: 'origin', title: '配布先の確認', ask: 'どこに配る？' });
  const submit = (session_id, prompt, now) =>
    contextHook({ session_id, prompt }, { home: h, now, env: {} });

  assert.match(submit('viewer', '進捗確認', 1000).hookSpecificOutput.additionalContext, /配布先の確認/);
  const shown = listItems(h)[0];
  assert.deepEqual(shown.lastShownPrompt, { session: 'viewer', at: new Date(1000).toISOString() });
  assert.deepEqual(shown.shownSessions, { viewer: new Date(1000).toISOString() });

  assert.match(submit('other', '別件', 2000).hookSpecificOutput.additionalContext, /既出 1 件/);
  assert.equal(submit('other', '続けて', 3000), null);
  const text = '008 と 014 に配って ' + 'あ'.repeat(600);
  const captured = submit('viewer', '  ' + text.replace(' と ', '\nと\t'), 4000);
  assert.match(captured.hookSpecificOutput.additionalContext, new RegExp(`配布先の確認.*--reopen ${item.id}`));

  const [answered] = listItems(h, { status: 'answered' });
  assert.deepEqual(answered.replies, [{ session: 'viewer', at: new Date(4000).toISOString(), text: text.slice(0, 600) }]);
  assert.equal(answered.lastShownPrompt, undefined);
  assert.equal(submit('viewer', '追加の別件', 5000), null);
  assert.equal(submit('new', '新しいセッション', 25 * 3600_000), null);

  const delivered = submit('origin', '作業に戻る', 25 * 3600_000 + 1000).hookSpecificOutput.additionalContext;
  assert.ok(delivered.includes(`別セッションで kim が返事済み: 配布先の確認 ／ 返事: ${text.slice(0, 600)}（${answered.replies[0].at}）`));
  assert.ok(delivered.includes(`--resolve ${item.id}`));
  assert.equal(resolveById(h, item.id).status, 'resolved');
  assert.equal(submit('origin', '完了', 25 * 3600_000 + 2000), null);
});

test('contextHook: 機械プロンプトを挟んだ後の発言は直前の返事として記録しない', t => {
  const h = home(t);
  addItem(h, { session: 'origin', title: '確認', ask: '選んで' });
  const submit = (prompt, now) => contextHook({ session_id: 'viewer', prompt }, { home: h, now, env: {} });

  assert.ok(submit('最初の発言', 1000));
  assert.equal(submit('【定期】自動実行', 2000), null);
  assert.equal(submit('別の依頼', 3000), null);
  const [item] = listItems(h);
  assert.equal(item.status, 'open');
  assert.equal(item.lastShownPrompt, undefined);
  assert.equal(item.replies, undefined);
});

test('CLI: 手動回答、回答済みの一覧、最新の返事の取り消し', async t => {
  const h = home(t);
  const { id } = addItem(h, { session: 'origin', title: '配布先', ask: '選んで' });
  addItem(h, { session: 'origin', title: '別件', ask: '確認して' });
  const out = [];
  const run = (...args) => main(args, { home: h, stdout: s => out.push(s), stderr: () => {} });

  assert.equal(await run('--answer', id), 1);
  assert.equal(await run('--answer', id, '--text', '最初の\n返事'), 0);
  assert.deepEqual(JSON.parse(out.pop()), { id, status: 'answered' });
  assert.equal(await run('--answer', id, '--text', '訂正'), 0);
  assert.equal(await run('--list', '--answered', '--json'), 0);
  const answered = JSON.parse(out.pop());
  assert.equal(answered.length, 1);
  assert.equal(answered[0].id, id);
  assert.deepEqual(answered[0].replies.map(r => [r.session, r.text]), [['manual', '最初の 返事'], ['manual', '訂正']]);

  assert.equal(await run('--reopen', id), 0);
  assert.deepEqual(JSON.parse(out.pop()), { id, status: 'open' });
  const reopened = listItems(h, { status: 'open' }).find(i => i.id === id);
  assert.deepEqual(reopened.replies, [answered[0].replies[0]]);
  assert.equal(reopened.lastShownPrompt, undefined);
  assert.equal(await run('--list', '--answered', '--json'), 0);
  assert.deepEqual(JSON.parse(out.pop()), []);
  assert.equal(await run('--reopen', id), 1);
  assert.equal(await run('--resolve', id), 0);
  assert.equal(await run('--answer', id, '--text', '遅い返事'), 1);
});
