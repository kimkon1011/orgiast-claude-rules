import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { addCheck } from './auto-progress.mjs';
import { applyPromise, ledgerFile, writeLedger } from './auto-progress-ledger.mjs';
import { evaluateUnregisteredPromise, findUnregisteredPromise } from './unregistered-promise-gate.mjs';

test('df3b4616 の未登録の約束を block する', () => {
  const text = [
    '「金具の位置はシートを切り欠く」は今の時点のノウハウとして記録しておきます。',
    '効いた方法を教えてもらえれば、施工ノウハウ台帳と施工手順書へ反映します。',
    'この後の自動進行: なし',
  ].join('\n');
  const result = evaluateUnregisteredPromise(text);
  assert.equal(result.decision, 'block');
  assert.match(result.reason, /記録しておきます/);
  assert.match(result.reason, /返事が無くても進む形/);
});

test('条件付きの約束だけでも検出する', () => {
  assert.match(findUnregisteredPromise('返事があれば台帳へ追記します。'), /追記します/);
});

test('過去形・完了報告は通す', () => {
  for (const text of ['台帳へ記録しました。', '台帳への反映は済みです。', '対応完了です。'])
    assert.equal(evaluateUnregisteredPromise(text).decision, 'pass');
});

test('コードブロック・引用ブロック・かぎ括弧内は除外する', () => {
  for (const text of [
    '```text\n台帳へ記録します。\n```',
    '> 台帳へ反映します。',
    '相手は「台帳へ追記します。」と回答しました。',
    '仕様には『この後、対応します。』とあります。',
  ]) assert.equal(evaluateUnregisteredPromise(text).decision, 'pass', text);
});

test('宣言だけでは check 登録にならない', () => {
  const text = '台帳へ記録します。\nこの後の自動進行: 施工ノウハウ台帳へ記録し、完了を通知';
  assert.equal(evaluateUnregisteredPromise(text).decision, 'block');
});

for (const promise of [
  '「金具の位置はシートを切り欠く」は今の時点のノウハウとして記録しておきます。',
  '効いた方法を教えてもらえれば、施工ノウハウ台帳と施工手順書へ反映します。',
  '教えていただければ、台帳へ追記します。',
  'kim が教えてもらえれば、こちらが対応します。',
  '返事があれば台帳へ追記します。',
  '台帳へ記録します。',
  '作業を進めます。',
  '明日メールを送ります。',
  '対応します',
  '確認しましたので、台帳へ追記します。',
  '完了後、台帳へ反映します。',
  '記録済みの内容を手順書に反映します。',
]) test(`未登録の約束: ${promise}`, () => {
  for (const footer of ['', '\nこの後の自動進行: なし']) {
    const result = evaluateUnregisteredPromise(promise + footer);
    assert.equal(result.decision, 'block');
    assert.equal(findUnregisteredPromise(promise + footer), promise);
    assert.equal(result.reason, `本文で約束した作業（${promise}）が、実行も『この後の自動進行:』への登録もされていません。今このターンで実行するか、自動進行に登録してください。user の返事待ちの条件付き約束は使わず、返事が無くても進む形にしてください。`);
  }
});

for (const text of [
  '', '台帳への記録は完了しました。', '台帳に記録しておきました。',
  '台帳へ記録しません。', '台帳へ記録しますか？', '台帳へ記録します？',
  '台帳へ記録しますと言っていました。', '台帳へ記録します（実行済み）。',
  '担当者が対応します。', '白川さんがメールを送ります。', 'アプリが結果を記録します。',
  '```text\n記録します。', '~~~~text\n```\n追記します。\n```\n~~~~',
  '> ```text\n> 台帳へ記録します。\n> ```', '    > 対応します。',
  '「『記録します。』と答えます。」', '『「反映します。」とあります。』',
  '「台帳へ記録します。', '`台帳へ反映します。`',
]) test(`約束として扱わない: ${JSON.stringify(text)}`, () => {
  assert.equal(evaluateUnregisteredPromise(text).decision, 'pass');
});

test('引用を除外しても外側の約束は原文のまま返す', () => {
  const text = '「🔧金具の位置」は記録しておきます。\nこの後の自動進行: なし';
  assert.equal(findUnregisteredPromise(text), '「🔧金具の位置」は記録しておきます。');
});

test('除外部分の後にある本文も検査する', () => {
  for (const excluded of ['```\n記録します。\n```', '> 記録します。', '「記録します。」']) {
    assert.equal(findUnregisteredPromise(`${excluded}\nメールを送ります。`), 'メールを送ります。');
  }
});

test('台帳と同じ装飾付き登録を認識する', () => {
  for (const footer of [
    'この後の自動進行：台帳へ記録',
    '- **この後の自動進行**: 台帳へ記録',
    '`この後の自動進行`: 台帳へ記録',
  ]) assert.equal(evaluateUnregisteredPromise(`台帳へ記録します。\n${footer}`).code, 'AUTOPROGRESS-NEEDS-CURRENT-CHECK');
});

test('台帳が登録しない空欄やなし表記では差し戻す', () => {
  for (const value of ['', 'なし', 'なし。', 'なし（完了）', '**なし**', 'ありません', 'None', '—']) {
    assert.equal(evaluateUnregisteredPromise(`台帳へ記録します。\nこの後の自動進行: ${value}`).decision, 'block', value);
  }
});

test('複数の自動進行宣言は台帳と同じく末尾を採用する', () => {
  const prefix = '台帳へ記録します。\n';
  const registered = 'この後の自動進行: 台帳へ記録';
  const none = 'この後の自動進行: なし';
  assert.equal(evaluateUnregisteredPromise(`${prefix}${registered}\n${none}`).decision, 'block');
  assert.equal(evaluateUnregisteredPromise(`${prefix}${none}\n${registered}`).code, 'AUTOPROGRESS-NEEDS-CURRENT-CHECK');
});

test('コード・引用中の宣言は自動進行の登録にならない', () => {
  for (const example of [
    '```text\nこの後の自動進行: 台帳へ記録\n```',
    '> この後の自動進行: 台帳へ記録',
    '「この後の自動進行: 台帳へ記録」',
    '『この後の自動進行: 台帳へ記録』',
  ]) assert.equal(evaluateUnregisteredPromise(`台帳へ記録します。\n${example}`).decision, 'block');
});


const now = Date.parse('2026-11-05T12:00:00Z');
const pending = 'この後の自動進行: 監視の PR のマージと定期実行の配布を進め、返信を待って組み込む';
function checkContext(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pending-check-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const transcriptRaw = JSON.stringify({ type: 'user', timestamp: new Date(now - 1000).toISOString(), message: { role: 'user', content: '進めて' } });
  return { home, sessionId: 'current', transcriptRaw, now };
}
test('当該ターンの addCheck と Stop による継承は通る', t => {
  const ctx = checkContext(t);
  const row = addCheck({ session: ctx.sessionId, check: 'test -f result.txt', deadline: '+2d', label: '配布', home: ctx.home, now });
  assert.equal(evaluateUnregisteredPromise(pending, ctx).decision, 'pass');
  writeLedger(ledgerFile(ctx.home), applyPromise([row], { sessionId: ctx.sessionId, status: 'open', ts: new Date(now).toISOString(), promise: '配布' }));
  assert.equal(evaluateUnregisteredPromise(pending, ctx).decision, 'pass');
});
test('別セッション・過去ターン・完了済み・空 check・自己申告は block', t => {
  const ctx = checkContext(t);
  const row = { sessionId: ctx.sessionId, status: 'open', ts: new Date(now).toISOString(), checkRegisteredAt: new Date(now).toISOString(), check: 'test -f result.txt' };
  for (const extra of [{ sessionId: 'other' }, { checkRegisteredAt: new Date(now - 2000).toISOString() }, { status: 'done' }, { check: ' ' }, { checkRegisteredAt: undefined }, { checkRegisteredAt: new Date(now + 1000).toISOString() }]) {
    writeLedger(ledgerFile(ctx.home), [{ ...row, ...extra }]);
    assert.equal(evaluateUnregisteredPromise(pending, ctx).code, 'AUTOPROGRESS-NEEDS-CURRENT-CHECK');
  }
  const result = evaluateUnregisteredPromise(pending + '\n登録コマンド: node tools/auto-progress.mjs --add-check', ctx);
  assert.match(result.reason, /--deadline \+2d/);
  assert.match(result.reason, /成果物があるときだけ exit 0/);
});
test('時刻不明のターン・古い登録を Stop で引き継いでも block', t => {
  const ctx = checkContext(t);
  const row = addCheck({ session: ctx.sessionId, check: 'test -f result.txt', deadline: '+2d', label: '配布', home: ctx.home, now: now - 2000 });
  writeLedger(ledgerFile(ctx.home), applyPromise([row], { sessionId: ctx.sessionId, status: 'open', ts: new Date(now).toISOString() }));
  assert.equal(evaluateUnregisteredPromise(pending, ctx).decision, 'block');
  assert.equal(evaluateUnregisteredPromise(pending, { ...ctx, transcriptRaw: '' }).decision, 'block');
});
test('例外理由が必要で、引用やコードの例外は無効', () => {
  assert.equal(evaluateUnregisteredPromise(pending + '\n[AUTOPROGRESS-CHECK-OK: 外部監視で管理済み]').decision, 'pass');
  for (const token of ['[AUTOPROGRESS-CHECK-OK: ]', '> [AUTOPROGRESS-CHECK-OK: 例]', '```\n[AUTOPROGRESS-CHECK-OK: 例]\n```'])
    assert.equal(evaluateUnregisteredPromise(pending + '\n' + token).decision, 'block');
  for (const value of ['なし', '', '返信を待つ']) assert.equal(evaluateUnregisteredPromise('この後の自動進行: ' + value).decision, 'pass');
});
