import assert from 'node:assert/strict';
import test from 'node:test';
import { enabled, judge } from './deferral-wait-gate.mjs';

// 陽性は 2026-10-18〜19 の実測（stop-gate-runner-ledger.jsonl）をそのまま使う。
const positives = [
  '実装の完了を待っています（終わり次第、差分とテストを自分で確認し、本番反映・配備・実データでの再確認まで進めます）。',
  'memory への追記が終わりました。Codex の実装完了を待っています（終わると通知が来ます）。',
  'コピー増殖を止める修正ジョブの完了を待っています（通知が来たら W2 の実データで最終確認します）。',
  '再組版と台帳登録の完了待ちです（数分）。終わり次第、本番デッキのページを目視して報告します。',
  'Codex に委譲しました。完了を待って、終わったら検証します。',
  '今は2つの作業の完了を待っています。終わり次第、検証します。',
  '事故の記録を memory に残しました。修復の書き込みが終わるのを待っています（終わると知らせが届きます）。',
  '今動いているのは2つで、どちらも終わると知らせが届きます。',
  'memory への記録は済みました。Codex の実装（ゲート3本・ルール本文・テスト・PR 作成）が終わるのを待っています。終わったら差分…',
  '書き込みを投入しました（42マス、終わったら5か所を読み戻します）。完了すると知らせが届くので、その時点で読み戻し結果を確認して報告します。',
  // 2026-10-21 の実測（stop-gate-runner-ledger.jsonl / 4d7e4383）。
  // 「届いたら」と「待ってから」が後続作業なのに、旧述語は pass させていた。
  'アプリ作りのセッションは、実装を任せた Codex の完了待ちです。まだ完了していません。\n\n次に kim がすること: なし\nこの後の自動進行: アプリ作りのセッションの完了報告が届いたら、結果を確かめて報告する\nこのセッション: まだ閉じない（作業中）',
  'Codex のリンク実装の完了を待ってから、このスクリプトを実行します。',
  // 2026-10-20T10:00:59.186Z / a7673192 の原文（handoff-audit:3423fc1641f7e360）。
  // 「通知が届くので、そのときに確認して報告します」＝通知待ち＋後続作業。
  'Codex の検証はまだ実行中です。終わると自動で通知が届くので、そのときに結果ファイルの中身と、テスト用の取引が削除されたかを確認して報告します。',
  // handoff-audit:ccdb575d6523f44a（2026-10-20T00:37:49Z / session bdbf73fd-ef5d-4753-ac71-0531fd566e29）。
  'まだ commit も本番反映もしていない状態で、「続けて」の返信を待っています。',
  'この後の自動進行: 返信が来たら私が、データベース変更の確認と適用、通し確認、本番反映まで進めます。',
  '本番反映は kim さんの返信待ちです。',
  // 2026-10-22 の実測（stop-gate-runner-ledger.jsonl / session b822034d）。「作業中」「実行中」
  // 「終わるのを待って、」は W に一致せず、3 行とも pass だった（handoff-audit:e50806fb45fa141c）。
  '送付欄の表記変更は Codex が作業中です。終わったら本番まで出して確認します。',
  'PDF から計算ルールの行を消しました。Codex の作業が終わったら、まとめてテストして本番に出し、本番で作った PDF を改めてお送りします。',
  'Codex の送付欄の作業が終わるのを待って、まとめて本番に出します。',
  'Codex はまだ作業中です（10:10 起動のプロセスが稼働中）。終わり次第、18日・19日も毎日に変えて当てます。',
];

for (const [index, text] of positives.entries()) {
  test(`先送り待機を block する ${index + 1}`, () => {
    const result = judge(text);
    assert.equal(result.decision, 'block');
    assert.equal(result.code, 'DEFERRAL-WAIT');
    assert.match(result.reason, /当ターン内に完了まで進め/);
    assert.doesNotMatch(result.reason, /次に kim がすること/);
  });
}

const negatives = [
  '完了を待たずに、当ターン内で実装・テスト・配備まで終えました。',
  '作業はすべて完了しました。テストは全件 PASS、本番反映済みです。',
  '```text\n完了を待っています（終わり次第、確認します）\n```\n作業は完了済みです。',
  '> 完了を待っています（終わり次第、確認します）\n作業は完了済みです。',
  '[handoff-audit:0123456789abcdef] 恒久修正の先送り文を検出（2026-10-18T07:32:28.656Z / 49d68696 / W）「実装の完了を待っています（終わり次第、差分とテストを自分で確認し…）。」',
  'CI の完了を待っています。',
  '終わり次第、確認します。',
  'ご返信をお待ちしています。',
  'サブエージェントの結果を待っています。',
  '本番反映は完了しました。ご返信をお待ちしています。',
  '本番反映済みです。返信は不要です。',
  'お客様からの返信を待っています。',
  // 後続作業が無いステータス報告・完了済みの報告は対象外。
  'Codex が作業中です。',
  'Codex の実装が完了しました。本番反映まで終えています。',
  '[handoff-audit:e50806fb45fa141c] 再発行の記録「Codex が作業中です。終わったら本番まで出して確認します。」',
];

for (const [index, text] of negatives.entries()) {
  test(`非対象を pass する ${index + 1}`, () => assert.deepEqual(judge(text), { decision: 'pass' }));
}

// 実際の handoff は待機文の後ろに定型文が続く。末尾だけを見ると取りこぼす形を固定する。
test('待機文の後ろに手渡し定型文が続いても block する', () => {
  const text = '実装の完了を待っています（終わり次第、差分とテストを自分で確認し、本番反映まで進めます）。\n\n次に kim がすること: なし\nこのセッション: /session-close をして（まだ閉じない）';
  assert.equal(judge(text).decision, 'block');
});

test('待機文と後続作業が 160 字を超えて離れた説明文は pass する', () => {
  assert.deepEqual(judge(`完了を待っています。${'あ'.repeat(200)}終わったら確認します。`), { decision: 'pass' });
});

test('将来作業キューは前後どちらの順でも 160 字以内なら拾う', () => {
  assert.equal(judge('終わったら確認するため、完了を待っています。').decision, 'block');
});

test('環境変数で無効化できる', t => {
  const before = process.env.ORGIAST_DEFERRAL_WAIT_GATE;
  t.after(() => before === undefined ? delete process.env.ORGIAST_DEFERRAL_WAIT_GATE : process.env.ORGIAST_DEFERRAL_WAIT_GATE = before);
  process.env.ORGIAST_DEFERRAL_WAIT_GATE = '0';
  assert.equal(enabled(), false);
  assert.deepEqual(judge(positives[0]), { decision: 'pass' });
  delete process.env.ORGIAST_DEFERRAL_WAIT_GATE;
  assert.equal(enabled(), true);
  assert.equal(judge(positives[0]).decision, 'block');
});
