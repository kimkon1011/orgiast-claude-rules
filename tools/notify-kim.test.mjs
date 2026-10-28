import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, notifyKim, deliverKim } from './notify-kim.mjs';
import { parseHandoff, todoExclusionReason } from './auto-session.mjs';
import { planRotation } from './next-session-rotate.mjs';

function home() { return fs.mkdtempSync(path.join(os.tmpdir(), 'notify-kim-')); }
function response({ ok = true, status = 200, json = { id: 'message' } } = {}) { return { ok, status, json: async () => json }; }

test('token と userId で DM チャンネルを開いて投稿する', async () => {
  const calls = [];
  const result = await notifyKim('hello', { home: home(), token: 'token', userId: 'user', fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return calls.length === 1 ? response({ json: { id: 'dm-channel' } }) : response();
  } });
  assert.equal(result.delivered, 'dm');
  assert.equal(result.messageId, 'message');
  assert.equal(result.channelId, 'dm-channel');
  assert.match(calls[0].url, /users\/@me\/channels$/);
  assert.deepEqual(JSON.parse(calls[0].init.body), { recipient_id: 'user' });
  assert.match(calls[1].url, /channels\/dm-channel\/messages$/);
  assert.deepEqual(JSON.parse(calls[1].init.body), { content: 'hello' });
});

test('DM 失敗時は webhook へフォールバックする', async () => {
  const dir = home(); fs.mkdirSync(path.join(dir, '.claude')); fs.writeFileSync(path.join(dir, '.claude', 'orgiast-discord-webhook.txt'), 'https://example.test/webhook');
  const calls = []; const original = console.error; console.error = () => {};
  try {
    const result = await notifyKim('hello', { home: dir, token: 'token', userId: 'user', fetchImpl: async (url) => {
      calls.push(url); return calls.length === 1 ? response({ ok: false, status: 403 }) : response();
    } });
    assert.equal(result.delivered, 'webhook'); assert.equal(calls[1], 'https://example.test/webhook');
  } finally { console.error = original; }
});

test('token がなければ最初から webhook へ送る', async () => {
  const dir = home(); fs.mkdirSync(path.join(dir, '.claude')); fs.writeFileSync(path.join(dir, '.claude', 'orgiast-discord-webhook.txt'), 'https://example.test/webhook');
  const calls = []; const original = console.error; console.error = () => {};
  try {
    const result = await notifyKim('hello', { home: dir, token: '', userId: 'user', fetchImpl: async (url) => { calls.push(url); return response(); } });
    assert.equal(result.delivered, 'webhook'); assert.deepEqual(calls, ['https://example.test/webhook']);
  } finally { console.error = original; }
});

test('通知先がなくても例外にせず stderr 1行で none を返す', async () => {
  const lines = []; const original = console.error; console.error = (line) => lines.push(line);
  try {
    const result = await notifyKim('hello', { home: home(), token: '', userId: '' });
    assert.equal(result.delivered, 'none'); assert.equal(lines.length, 1);
  } finally { console.error = original; }
});

test('2000文字を超える本文を省略表示付きで切る', async () => {
  const bodies = [];
  await notifyKim('あ'.repeat(2_100), { home: home(), token: 'token', userId: 'user', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? response({ json: { id: 'dm' } }) : response();
  } });
  assert.equal(bodies[1].content.length, 2_000); assert.ok(bodies[1].content.endsWith('…(以下省略)'));
});

test('送信直前に平易化を通す（内部用語が書き換わる）', async () => {
  const bodies = [];
  await notifyKim('▶ 次はこれをやります: feedback-zero-sweep', { home: home(), token: 'token', userId: 'user', plainJaImpl: async () => '次は、社員からの報告をまとめる作業をします。', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? response({ json: { id: 'dm' } }) : response();
  } });
  assert.equal(bodies[1].content, '次は、社員からの報告をまとめる作業をします。');
});

test('NOTIFY_PLAIN_JA=0 相当（plainJa:false）では本文をそのまま送る', async () => {
  const bodies = [];
  await notifyKim('▶ 次はこれをやります: feedback-zero-sweep', { home: home(), token: 'token', userId: 'user', plainJa: false, plainJaImpl: async () => '書き換え後', fetchImpl: async (_url, init) => {
    bodies.push(JSON.parse(init.body)); return bodies.length === 1 ? response({ json: { id: 'dm' } }) : response();
  } });
  assert.equal(bodies[1].content, '▶ 次はこれをやります: feedback-zero-sweep');
});

function sender(dir, extra = {}) {
  const messages = [];
  return { messages, options: { home: dir, token: 'token', plainJa: false, ...extra, fetchImpl: async (url, init) => {
    if (url.endsWith('/messages')) messages.push(JSON.parse(init.body).content);
    return response({ json: { id: 'dm' } });
  } } };
}
test('原因・対処の欠落は既存TODOへ起票、日時・回数が変わっても24時間抑制', async () => {
  const dir = home(), s = sender(dir);
  assert.equal((await notifyKim('収集失敗 2026-10-22 3回', { ...s.options, now: 0 })).delivered, 'dm');
  assert.match(s.messages[0], /原因:.*\n対処:.*\n自動起票:/);
  assert.equal((await notifyKim('収集失敗 2026-10-23 4回', { ...s.options, now: 1000 })).delivered, 'suppressed');
  assert.equal((await notifyKim('収集失敗 2026-10-23 4回', { ...s.options, now: 86400000 })).delivered, 'dm');
  assert.equal(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8').match(/1\. \[ \]/g).length, 1);
});
test('delegation-health通知はquota割合とtickだけが変わっても修復TODOを増やさない', async () => {
  const dir = home(), s = sender(dir);
  const notice = (before, after, tick) => [
    `claude/5h ${before}% → ${after}% tick: ${tick}`,
    '[delegation-health:lane_outage_unrepaired]',
    'quota-sweep:claude が直近 4 件すべて失敗している。原因: 不明。対処: 未定',
  ].join('\n');
  assert.equal((await notifyKim(notice(5, 5, 0), { ...s.options, now: 0 })).delivered, 'dm');
  assert.equal(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8').match(/1\. \[ \]/g).length, 1);
  assert.equal((await notifyKim(notice(17, 17, 8), { ...s.options, now: 1000 })).delivered, 'suppressed');
  assert.equal(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8').match(/1\. \[ \]/g).length, 1);
});
test('原因か対処の片方だけでも起票、両方がある場合は起票不要', async () => {
  for (const tail of ['原因: DNS不通', '対処: 再実行済み', '原因:\n対処: 再実行済み', '原因: DNS不通\n対処: 再実行済み']) {
    const dir = home(), s = sender(dir);
    await notifyKim(`取得失敗\n${tail}`, s.options);
    assert.equal(fs.existsSync(path.join(dir, '.claude/next-session.md')), !tail.startsWith('原因: DNS不通\n対処:'));
  }
});
test('異なる発生元・原因は抑止しない', async () => {
  const s = sender(home());
  for (const [source, cause] of [['a','DNS'], ['b','DNS'], ['a','HTTP 403']])
    assert.equal((await notifyKim('失敗', { ...s.options, source, cause })).delivered, 'dm');
  assert.equal(s.messages.length, 3);
});
test('調査の選択・接続確認を頼まず、起票情報は平易化・長文切り捨て後にも残る', async () => {
  const s = sender(home(), { plainJa: true, plainJaImpl: async () => '長'.repeat(2500) });
  await notifyKim('失敗\nkim に選んでほしい対応:\n1. 原因調査\n2. 停止\n接続して確認してください', s.options);
  assert.ok(s.messages[0].length <= 2000);
  assert.match(s.messages[0], /自動起票:/);
  assert.doesNotMatch(s.messages[0], /選んで|接続して/);
});
test('起票失敗では未修復通知を送らない', async () => {
  const dir = home(); fs.writeFileSync(path.join(dir, '.claude'), 'not a directory');
  const s = sender(dir);
  assert.equal((await notifyKim('失敗', s.options)).delivered, 'none');
  assert.equal(s.messages.length, 0);
});
test('送信失敗後は再送可能、同時呼び出しでも1通知・1起票', async () => {
  const s = sender(home());
  assert.equal((await notifyKim('失敗', { ...s.options, token: '', webhookFallback: false })).delivered, 'none');
  const results = await Promise.all([notifyKim('失敗', s.options), notifyKim('失敗', s.options)]);
  assert.deepEqual(results.map(r => r.delivered).sort(), ['dm', 'suppressed']);
  assert.equal(s.messages.length, 1);
});


test('起票した複数の修復タスクを既存auto-sessionのparserが拾う', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim('領収書失敗', s.options);
  await notifyKim('夜間処理エラー', s.options);
  const parsed = parseHandoff(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8'));
  assert.equal(parsed.todos.length, 2);
  assert.match(JSON.stringify(parsed.todos), /領収書失敗/);
  assert.match(JSON.stringify(parsed.todos), /夜間処理エラー/);
});

test('人の操作が必要な試行と証拠がある場合は具体的な操作を残す', async () => {
  const s = sender(home());
  await notifyKim('認証失敗\n原因: OAuth同意失効\n対処: 自動更新を試行済み\n試行: 自動更新で再認証\n証拠: invalid_grant\n必要な操作: 管理画面に接続して同意してください', s.options);
  assert.match(s.messages[0], /必要な操作: 管理画面に接続して同意してください/);
  assert.doesNotMatch(s.messages[0], /自動起票:/);
});

test('完了報告に failed/失敗 が引用されても修復TODOを起票しない（自己増殖ループの回帰）', async () => {
  const dir = home(), s = sender(dir);
  const done = [
    '宛先: 不明（DM 未解決）',
    '【DESKTOP-BDOAK99・user の Claude Code】プロジェクト: quota-sweep-repo ／ 作業ID: 175e831d',
    '✅ 自動進行が完了しました',
    '約束: PR #1060 がマージされると再試行が効きます。',
    '結果: 429 を failed にせず deferred で延期。既存の失敗検知とは別に確認が必要です。',
    '成果物: tools/quota-sweep.mjs',
    'kim がすること: なし',
  ].join('\n');
  assert.equal((await notifyKim(done, s.options)).delivered, 'dm');
  assert.equal(fs.existsSync(path.join(dir, '.claude/next-session.md')), false);
  assert.doesNotMatch(s.messages[0], /自動起票:/);
});

test('定時ダイジェストは失敗語を含んでも起票しない', async () => {
  const dir = home(), s = sender(dir);
  const digest = '【DESKTOP-BDOAK99 の自動進行】 完了 1件・止まっている 1件・あなたの判断待ち 0件\n・止まっている: p — 前回の失敗から自動再開していません';
  assert.equal((await notifyKim(digest, s.options)).delivered, 'dm');
  assert.equal(fs.existsSync(path.join(dir, '.claude/next-session.md')), false);
});

test('起票済みマーカーを含む本文を再通知しても二重起票しない', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim('収集失敗', { ...s.options, cause: '一次原因' });
  const filed = fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8');
  assert.equal(filed.match(/1\. \[ \]/g).length, 1);
  await notifyKim(`収集失敗\n${filed}`, { ...s.options, cause: '別経路からの再通知' });
  assert.equal(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8').match(/1\. \[ \]/g).length, 1);
});

test('従来どおり失敗通知は起票する（完了報告ガードで塞がない）', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim('quota-sweep claude が直近 4 件すべて失敗している', s.options);
  assert.match(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8'), /通知の原因調査・修復:/);
});

test('夜間セッション再開は目的文に失敗を含んでも全行 progressed なら起票しない', async () => {
  const dir = home(), s = sender(dir);
  const report = '夜間セッション再開 (test-host)\nquota-sweep:claude が直近 4 件すべて失敗している (12345678-1234-1234-1234-123456789abc): progressed\n別の目的 (abcdef12-1234-1234-1234-123456789abc): progressed';
  assert.equal((await notifyKim(report, s.options)).delivered, 'dm');
  assert.equal(fs.existsSync(path.join(dir, '.claude/next-session.md')), false);
  assert.equal(s.messages[0], report);
});

test('夜間セッション再開に1行でも error があれば目的文の失敗語によらず起票する', async () => {
  for (const title of ['quota-sweep:claude が直近 4 件すべて失敗している', '通常の作業']) {
    const dir = home(), s = sender(dir);
    const report = `夜間セッション再開 (test-host)\n別の目的 (abcdef12-1234-1234-1234-123456789abc): progressed\n${title} (12345678-1234-1234-1234-123456789abc): error`;
    assert.equal((await notifyKim(report, s.options)).delivered, 'dm');
    assert.match(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8'), /通知の原因調査・修復:/);
  }
});

test('夜間セッション再開の中止行があれば起票する', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim('夜間セッション再開 (test-host)\n作業 (12345678-1234-1234-1234-123456789abc): progressed\n連続2件エラーのため今晩は中止', s.options);
  assert.match(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8'), /通知の原因調査・修復:/);
});

test('再開レポートの見出しがなければ progressed 行があっても通常の失敗通知として起票する', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim('quota-sweep:claude が直近 4 件すべて失敗している (12345678-1234-1234-1234-123456789abc): progressed', s.options);
  assert.match(fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8'), /通知の原因調査・修復:/);
});

test('判断待ちの自動進行通知は[判断待ち]として起票し、修復TODOにしない', async () => {
  const dir = home(), s = sender(dir);
  const notice = [
    '宛先: 不明（DM 未解決）',
    '【HP・test の Claude Code】プロジェクト: Desktop ／ 作業ID: 8b90fb50',
    '自動進行が判断待ちです: cr@ の認可コードを保存してください',
    '【停止点1】 freee_tokens(id=cr-filebox) がありません。',
  ].join('\n');
  await notifyKim(notice, s.options);
  const filed = fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8');
  assert.match(filed, /\[判断待ち\]/);
  assert.doesNotMatch(filed, /通知の原因調査・修復/);
  assert.equal(todoExclusionReason(parseHandoff(filed).todos[0]), '判断待ち');
});

test('自動再開の案内は起票しない', async () => {
  const dir = home(), s = sender(dir);
  const notice = [
    '宛先: 不明（DM 未解決）',
    '【HP・test の Claude Code】プロジェクト: verify-run ／ 作業ID: 15359cb6',
    'エラーで止まっていた依頼を見つけ、自動で再開します。',
    '依頼: [headless:cheap-code] これは Claude(監督)が蓄積したコンテキスト。',
  ].join('\n');
  await notifyKim(notice, s.options);
  assert.equal(fs.existsSync(path.join(dir, '.claude/next-session.md')), false);
});

test('宛先文言だけが違う同じ失敗を二重起票しない', async () => {
  const dir = home(), s = sender(dir);
  const failure = '【HP・test の Claude Code】プロジェクト: Desktop ／ 作業ID: 8b90fb50\nfreee トークン取得失敗';
  await notifyKim(`宛先: 不明（DM 未解決）\n${failure}`, s.options);
  await notifyKim(`宛先: 不明（このPCの持ち主が未設定・kim へ送付）\n${failure}`, { ...s.options, now: 86_400_000 });
  const filed = fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8');
  assert.equal(filed.match(/<!-- notify-kim:/g).length, 1);
});

test('起票しても次の1目的を作らない（目的の乗っ取り回帰）', async () => {
  const dir = home(), s = sender(dir);
  await notifyKim('収集失敗', s.options);
  const filed = fs.readFileSync(path.join(dir, '.claude/next-session.md'), 'utf8');
  assert.doesNotMatch(filed, /## 次の1目的/);
  assert.doesNotMatch(planRotation(filed).text, /1\. 通知の原因調査と修復/);
});

test('PRマージ依頼は送信せずblockedを返す', async () => {
  let fetches = 0;
  const originalError = console.error;
  let errorLine = '';
  console.error = value => { errorLine = value; };
  try {
    const result = await notifyKim('PR #943 をマージしてください', {
      fetchImpl: async () => { fetches += 1; throw new Error('unexpected fetch'); },
    });
    assert.deepEqual(result, {
      delivered: 'blocked', category: 'merge-request', reason: 'PR のマージ依頼は fleet-mail で扱います',
    });
    assert.equal(fetches, 0);
    assert.match(errorLine, /fleet-mail --to kim-PC/);
  } finally { console.error = originalError; }
});

test('notify-kim CLIはblockedでexit 3、明示例外なら送信する', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    assert.equal(await main(['PR #943 をマージしてください']), 3);
    const calls = [];
    assert.equal(await main(['PR #943 をマージしてください', '--kim-action-required'], {
      token: 'token', userId: 'user', plainJa: false,
      fetchImpl: async () => { calls.push(1); return calls.length === 1 ? response({ json: { id: 'dm' } }) : response(); },
    }), 0);
    assert.equal(calls.length, 2);
  } finally { console.error = originalError; }
});

test('HTTP success without message id is not a delivered DM', async () => {
 let calls = 0;
 const result = await deliverKim('進捗', { userId: 'test-recipient', token: 'test-token', plainJa: false, webhookFallback: false, fetchImpl: async () => ++calls === 1 ? response({ json: { id: 'channel' } }) : response({ json: {} }) });
 assert.equal(result.delivered, 'none');
 assert.match(result.reason, /メッセージID/);
});
