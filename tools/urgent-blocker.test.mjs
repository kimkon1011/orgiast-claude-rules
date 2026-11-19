import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addItem, resolveById, resolveBySession, listItems, hasOpenForSession,
  selectForInterrupt, contextHook, isMachinePrompt, INTERRUPT_REPEAT_MS, main,
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
  const second = contextHook({ hook_event_name: 'UserPromptSubmit', session_id: 'sess-B', prompt: '[cron] x' }, { home: h, now: () => 1000 + 60_000, env });
  assert.equal(second, null);
  assert.equal(listItems(h)[0].status, 'open');
  assert.equal(listItems(h)[0].lastShownPrompt, undefined);
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

test('contextHook: 次の人の入力を返事として記録し、登録元へ配達する', t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: '配布先の確認', ask: '配布先は？' });
  const unrelated = addItem(h, { session: 'sess-B', title: '別の質問', ask: '確認して' });
  const submit = (session, prompt, time) => contextHook(
    { hook_event_name: 'UserPromptSubmit', session_id: session, prompt },
    { home: h, env: {}, now: () => time },
  );
  const getItem = id => listItems(h).find(i => i.id === id);

  assert.ok(submit('sess-B', 'こんにちは', 1000));
  assert.deepEqual(getItem(item.id).lastShownPrompt, { session: 'sess-B', at: new Date(1000).toISOString() });
  assert.deepEqual(getItem(item.id).shownSessions, { 'sess-B': new Date(1000).toISOString() });
  assert.deepEqual(getItem(unrelated.id).shownSessions, {});
  assert.equal(getItem(item.id).replies, undefined);

  const reply = '全拠点 に配って ' + 'あ'.repeat(600);
  const capture = submit('sess-B', '  全拠点\nに配って\t' + 'あ'.repeat(600), 2000);
  assert.ok(capture.hookSpecificOutput.additionalContext.includes(`--reopen ${item.id}`));
  assert.equal(getItem(item.id).status, 'answered');
  assert.equal(getItem(item.id).lastShownPrompt, undefined);
  assert.deepEqual(getItem(item.id).replies, [{ session: 'sess-B', at: new Date(2000).toISOString(), text: reply.slice(0, 600) }]);
  assert.doesNotMatch(submit('sess-C', '別件', 3000).hookSpecificOutput.additionalContext, /配布先の確認|全拠点/);
  resolveById(h, unrelated.id);

  const delivery = submit('sess-A', '再開する', 4000).hookSpecificOutput.additionalContext;
  assert.match(delivery, /別セッションで kim が返事済み: 配布先の確認/);
  assert.ok(delivery.includes(reply.slice(0, 600)));
  assert.ok(delivery.includes(new Date(2000).toISOString()));
  assert.ok(delivery.includes(`--resolve ${item.id}`));
  assert.equal(resolveById(h, item.id).status, 'resolved');
  assert.equal(submit('sess-A', '次の作業', 5000), null);
});

test('contextHook: SessionStart の表示は返事の捕捉対象にしない', t => {
  const h = home(t);
  addItem(h, { session: 'sess-A', title: '確認', ask: '確認して' });
  const options = { home: h, env: {}, now: () => 1000 };
  assert.ok(contextHook({ hook_event_name: 'SessionStart', session_id: 'sess-B' }, options));
  assert.equal(listItems(h)[0].lastShownPrompt, undefined);
  assert.equal(contextHook({ session_id: 'sess-B', prompt: '作業開始' }, options), null);
  assert.equal(listItems(h)[0].status, 'open');
});

test('CLI: --answer、--list --answered、--reopen', async t => {
  const h = home(t);
  const item = addItem(h, { session: 'sess-A', title: '確認', ask: '答えて' });
  addItem(h, { session: 'sess-A', title: '未回答', ask: '答えて' });
  let output;
  const run = args => main(args, {
    home: h, stdout: value => { output = value; }, stderr: () => {}, now: () => 2000,
  });

  assert.equal(await run(['--answer', item.id]), 1);
  assert.equal(await run(['--answer', item.id, '--text', '最初の返事']), 0);
  assert.deepEqual(JSON.parse(output), { id: item.id, status: 'answered' });
  assert.equal(await run(['--answer', item.id, '--text', '  追記\n分  ']), 0);
  assert.equal(await run(['--list', '--answered', '--json']), 0);
  const answered = JSON.parse(output);
  assert.deepEqual(answered.map(i => i.id), [item.id]);
  assert.deepEqual(answered[0].replies.at(-1), { session: null, at: new Date(2000).toISOString(), text: '追記 分' });
  assert.equal(await run(['--list', '--answered']), 0);
  assert.match(output, /answered sess-A 確認/);

  assert.equal(await run(['--reopen', item.id]), 0);
  assert.deepEqual(JSON.parse(output), { id: item.id, status: 'open' });
  const reopened = listItems(h, { status: 'open' }).find(i => i.id === item.id);
  assert.deepEqual(reopened.replies.map(reply => reply.text), ['最初の返事']);
  assert.equal(reopened.lastShownPrompt, undefined);
  assert.equal(await run(['--reopen', item.id]), 1);
  assert.equal(await run(['--list', '--answered', '--json']), 0);
  assert.deepEqual(JSON.parse(output), []);
});
