import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addItem, resolveById, resolveBySession, listItems, hasOpenForSession,
  selectForInterrupt, markShown, contextHook, isMachinePrompt, INTERRUPT_REPEAT_MS, main, withLock, readState, writeState,
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

test('contextHook: 一度表示した blocker は60分以内に同じセッションへ再表示しない（代わりに返事を捕捉する）', t => {
  const h = home(t);
  addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  const env = {};
  const first = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => 1000, env });
  assert.ok(first);
  assert.match(first.hookSpecificOutput.additionalContext, /🚨 割り込み/);
  // Second call within 60 min: captures the prompt as a reply (not a re-show)
  const second = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: '返事です' }, { home: h, now: () => 1000 + 60_000, env });
  assert.ok(second);
  assert.match(second.hookSpecificOutput.additionalContext, /返事として記録/);
  // Item is now 'answered', so no re-show even after 60+ min
  const third = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: 'x' }, { home: h, now: () => 1000 + 61 * 60_000, env });
  assert.equal(third, null);
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

test('markShown は lastShownPrompt を設定する', t => {
  const h = home(t);
  const a = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  markShown(h, [a.id], 'sess-B', new Date('2026-11-16T13:25:00Z'));
  const items = listItems(h);
  const item = items.find(i => i.id === a.id);
  assert.deepEqual(item.lastShownPrompt, { session: 'sess-B', at: '2026-11-16T13:25:00.000Z' });
});

test('contextHook: 返事を自動捕捉する', t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 'DWD鍵配布', ask: '鍵を配って' });
  // Simulate: markShown sets lastShownPrompt
  markShown(h, [item.id], 'sess-B', new Date('2026-11-16T13:25:00Z'));
  // Next UserPromptSubmit in sess-B captures the reply
  const out = contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: '014だけじゃなく、008.011.014.015.018.019も配って' },
    { home: h, now: () => Date.parse('2026-11-16T13:25:33Z'), env: {} }
  );
  assert.ok(out);
  assert.match(out.hookSpecificOutput.additionalContext, /返事として記録/);
  assert.match(out.hookSpecificOutput.additionalContext, /--reopen/);
  // Verify state
  const items = listItems(h);
  const updated = items.find(i => i.id === item.id);
  assert.equal(updated.status, 'answered');
  assert.equal(updated.replies.length, 1);
  assert.equal(updated.replies[0].text, '014だけじゃなく、008.011.014.015.018.019も配って');
  assert.equal(updated.replies[0].session, 'sess-B');
  assert.equal(updated.lastShownPrompt, undefined);
});

test('contextHook: 機械プロンプトでは返事を捕捉しない', t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  markShown(h, [item.id], 'sess-B', new Date());
  const out = contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: '【定期の進捗確認】進めて' },
    { home: h, now: () => Date.now(), env: {} }
  );
  // Should not capture reply (machine prompt), and no interrupt (same session)
  assert.equal(out, null);
  const items = listItems(h);
  assert.equal(items.find(i => i.id === item.id).status, 'open');
});

test('contextHook: SessionStart では返事を捕捉しない', t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  markShown(h, [item.id], 'sess-B', new Date());
  const out = contextHook(
    { hook_event_name: 'SessionStart', session_id: 'sess-B', prompt: 'こんにちは' },
    { home: h, now: () => Date.now(), env: {} }
  );
  assert.equal(out, null);
  const items = listItems(h);
  assert.equal(items.find(i => i.id === item.id).status, 'open');
});

test('contextHook: 登録元セッションに返事を配達する', t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 'DWD鍵配布', ask: '鍵を配って' });
  // Manually add a reply (simulating what another session would do)
  withLock(h, () => {
    const state = readState(h);
    const i = state.items.find(x => x.id === item.id);
    i.status = 'answered';
    i.replies = [{ session: 'sess-B', at: '2026-11-16T13:25:33Z', text: '014だけじゃなく、008.011.014.015.018.019も配って' }];
    writeState(h, state);
  });
  // Now sess-A gets a UserPromptSubmit
  const out = contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-A', prompt: '続きをやります' },
    { home: h, now: () => Date.parse('2026-11-16T14:00:00Z'), env: {} }
  );
  assert.ok(out);
  assert.match(out.hookSpecificOutput.additionalContext, /別セッションで kim が返事済み/);
  assert.match(out.hookSpecificOutput.additionalContext, /DWD鍵配布/);
  assert.match(out.hookSpecificOutput.additionalContext, /014だけじゃなく/);
  assert.match(out.hookSpecificOutput.additionalContext, /--resolve/);
});

test('contextHook: 返事配達と割り込み表示は共存する', t => {
  const h = home(t);
  // Item A belongs to sess-A (will receive delivery)
  const itemA = addItem(h, { session: 'sess-A', title: 'DWD鍵配布', ask: '鍵を配って' });
  withLock(h, () => {
    const state = readState(h);
    const i = state.items.find(x => x.id === itemA.id);
    i.status = 'answered';
    i.replies = [{ session: 'sess-B', at: '2026-11-16T13:25:33Z', text: '返事' }];
    writeState(h, state);
  });
  // Item B belongs to sess-C (will interrupt sess-A)
  addItem(h, { session: 'sess-C', title: 'LINEログイン', ask: 'ログイン（2分）' });
  // sess-A gets a UserPromptSubmit
  const out = contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: 'sess-A', prompt: '続きをやります' },
    { home: h, now: () => Date.parse('2026-11-16T14:00:00Z'), env: {} }
  );
  assert.ok(out);
  assert.match(out.hookSpecificOutput.additionalContext, /別セッションで kim が返事済み/);
  assert.match(out.hookSpecificOutput.additionalContext, /🚨 割り込み/);
});

test('CLI: --answer で手動返事を記録する', async t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  const out = [];
  const run = args => main(args, { home: h, stdout: s => out.push(s), stderr: () => {}, readStdin: async () => '{}' });
  assert.equal(await run(['--answer', item.id, '--text', '返事です']), 0);
  const result = JSON.parse(out.pop());
  assert.equal(result.status, 'answered');
  const items = listItems(h);
  const updated = items.find(i => i.id === item.id);
  assert.equal(updated.status, 'answered');
  assert.equal(updated.replies.length, 1);
  assert.equal(updated.replies[0].text, '返事です');
});

test('CLI: --reopen で answered を open に戻す', async t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  // First answer it
  withLock(h, () => {
    const state = readState(h);
    const i = state.items.find(x => x.id === item.id);
    i.status = 'answered';
    i.replies = [{ session: 'sess-B', at: '2026-11-16T13:25:33Z', text: '返事' }];
    writeState(h, state);
  });
  const out = [];
  const run = args => main(args, { home: h, stdout: s => out.push(s), stderr: () => {}, readStdin: async () => '{}' });
  assert.equal(await run(['--reopen', item.id]), 0);
  const result = JSON.parse(out.pop());
  assert.equal(result.status, 'open');
  const items = listItems(h);
  const updated = items.find(i => i.id === item.id);
  assert.equal(updated.status, 'open');
  assert.equal(updated.replies, undefined);
});

test('CLI: --list --answered で answered 項目を一覧する', async t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  // Answer it
  withLock(h, () => {
    const state = readState(h);
    const i = state.items.find(x => x.id === item.id);
    i.status = 'answered';
    i.replies = [{ session: 'sess-B', at: '2026-11-16T13:25:33Z', text: '返事' }];
    writeState(h, state);
  });
  const out = [];
  const run = args => main(args, { home: h, stdout: s => out.push(s), stderr: () => {}, readStdin: async () => '{}' });
  assert.equal(await run(['--list', '--answered', '--json']), 0);
  const listed = JSON.parse(out.pop());
  assert.equal(listed.length, 1);
  assert.equal(listed[0].status, 'answered');
  // --open should not show answered
  assert.equal(await run(['--list', '--open', '--json']), 0);
  assert.equal(JSON.parse(out.pop()).length, 0);
});

test('CLI: --answer は解決済み blocker を拒否する', async t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  resolveById(h, item.id);
  const out = [];
  const run = args => main(args, { home: h, stdout: s => out.push(s), stderr: () => {}, readStdin: async () => '{}' });
  assert.equal(await run(['--answer', item.id, '--text', '返事']), 1);
});

test('CLI: --reopen は answered 以外を拒否する', async t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  const out = [];
  const run = args => main(args, { home: h, stdout: s => out.push(s), stderr: () => {}, readStdin: async () => '{}' });
  assert.equal(await run(['--reopen', item.id]), 1); // status is open, not answered
});
