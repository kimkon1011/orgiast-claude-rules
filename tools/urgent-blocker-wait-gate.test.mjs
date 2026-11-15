import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enabled, judge, detectHumanWait } from './urgent-blocker-wait-gate.mjs';
import { addItem, resolveBySession } from './urgent-blocker.mjs';

function home(t) {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'ubw-test-'));
  fs.mkdirSync(path.join(h, '.claude'));
  t.after(() => fs.rmSync(h, { force: true, recursive: true }));
  return h;
}

// 人待ちの報告（2026-11-09 の実害の型: LINE ログイン画像認証待ち）。
const positives = [
  'LINE公式アカウントのログイン待ちです。画像認証が出るため、kim のログインを待っています。',
  '河本さんへの就労証明書を送るため、LINEログインの画像認証をお待ちしています。',
  '人にしかできない操作（アカウント作成）が必要です。操作待ちです。',
  'あなたの操作待ちです。ログインして2段階認証のコードを入力してください。',
  '現在は返事待ちです。',
  '承認待ちのため止まっています。',
  '支払い待ちです。入金を確認してから進めます。',
];

for (const [index, text] of positives.entries()) {
  test(`人待ち報告を未登録なら block する ${index + 1}`, t => {
    const h = home(t);
    const result = judge(text, { sessionId: 'sess-A', home: h });
    assert.equal(result.decision, 'block');
    assert.equal(result.code, 'URGENT-BLOCKER-MISSING');
    assert.match(result.reason, /urgent-blocker\.mjs --add/);
    assert.match(result.reason, /代替経路/);
  });
}

test('urgent-blocker 登録済みなら pass する', t => {
  const h = home(t);
  addItem(h, { session: 'sess-A', title: 'LINEログイン待ち', ask: 'ログインして' });
  for (const text of positives) {
    assert.deepEqual(judge(text, { sessionId: 'sess-A', home: h }), { decision: 'pass' }, text);
  }
});

test('別セッションの登録はこのセッションの未登録を救わない', t => {
  const h = home(t);
  addItem(h, { session: 'sess-OTHER', title: 't', ask: 'a' });
  assert.equal(judge('ログイン待ちです。', { sessionId: 'sess-A', home: h }).decision, 'block');
});

test('セッション解決済みなら再び block する', t => {
  const h = home(t);
  addItem(h, { session: 'sess-A', title: 't', ask: 'a' });
  assert.deepEqual(judge('ログイン待ちです。', { sessionId: 'sess-A', home: h }), { decision: 'pass' });
  resolveBySession(h, 'sess-A');
  assert.equal(judge('ログイン待ちです。', { sessionId: 'sess-A', home: h }).decision, 'block');
});

const negatives = [
  '作業は完了しました。テストは全件 PASS です。',
  'ご返信をお待ちしています。', // 丁寧な結びは拾わない
  '本番反映は完了しました。返信は不要です。',
  'ログイン待ちは解消しました。次へ進めます。',
  '画像認証は不要でした。',
  '> ログイン待ちです。', // 引用行
  '```text\nログイン待ちです。\n```\n完了しました。', // コードブロック
  '[handoff-audit:0123456789abcdef] 人待ち報告を引用した行「ログイン待ちです。」',
  // 明示的に認識済み・追跡済みと宣言したマーカーは追加登録を求めない（reply-only など会話に戻る待ち）。
  '[AUTOPROGRESS-CHECK-OK: 機械判定できない返信待ち]\n次に kim がすること: なし',
  '[NO-AUTOCHECK-OK: 会話で返信を待つ]\n返信待ちです。',
];

for (const [index, text] of negatives.entries()) {
  test(`非対象を pass する ${index + 1}`, t => {
    const h = home(t);
    assert.deepEqual(judge(text, { sessionId: 'sess-A', home: h }), { decision: 'pass' }, text);
  });
}

test('sessionId が無いときは登録有無を判定できないので pass', t => {
  const h = home(t);
  assert.deepEqual(judge('ログイン待ちです。', { sessionId: '', home: h }), { decision: 'pass' });
});

test('detectHumanWait はフレーズを返し、非該当は null', () => {
  assert.equal(detectHumanWait('ログイン待ちです。'), 'ログイン待ち');
  assert.equal(detectHumanWait('画像認証が出ます。'), '画像認証');
  assert.equal(detectHumanWait('作業は完了しました。'), null);
});

test('環境変数で無効化できる', t => {
  const h = home(t);
  const before = process.env.ORGIAST_URGENT_BLOCKER_WAIT_GATE;
  t.after(() => before === undefined ? delete process.env.ORGIAST_URGENT_BLOCKER_WAIT_GATE : process.env.ORGIAST_URGENT_BLOCKER_WAIT_GATE = before);
  process.env.ORGIAST_URGENT_BLOCKER_WAIT_GATE = '0';
  assert.equal(enabled(), false);
  assert.deepEqual(judge(positives[0], { sessionId: 'sess-A', home: h }), { decision: 'pass' });
  delete process.env.ORGIAST_URGENT_BLOCKER_WAIT_GATE;
  assert.equal(enabled(), true);
  assert.equal(judge(positives[0], { sessionId: 'sess-A', home: h }).decision, 'block');
});
