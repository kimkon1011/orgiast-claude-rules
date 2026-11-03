import assert from 'node:assert/strict';
import test from 'node:test';
import { enabled, judge } from './third-party-nudge-gate.mjs';

// block: 第三者待ちがあり、後押し文がない
test('block: kim-PC からの返信が来たら、本番を再検証します。', () => {
  const result = judge('kim-PC からの返信が来たら、本番を再検証します。');
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'THIRD-PARTY-NUDGE');
});

test('block: kim さんの PC へ修正を依頼しました。直ったら続きを進めます。', () => {
  const result = judge('kim さんの PC へ修正を依頼しました。直ったら続きを進めます。');
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'THIRD-PARTY-NUDGE');
});

test('block: 先方の回答待ちです。', () => {
  const result = judge('先方の回答待ちです。');
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'THIRD-PARTY-NUDGE');
});

// 2026-11-02 実測の誤検知: PC 名の後に user 自身の判断待ちが続く行は対象外
test('pass: kimko-PC の自動進行… あなたの判断待ち', () => {
  const result = judge('【kimko-PC の自動進行】 完了 9件・止まっている 6件・あなたの判断待ち 2件');
  assert.deepEqual(result, { decision: 'pass' });
});

// pass: 第三者待ちがあっても後押し文がある
test('pass: 第三者待ち＋後押し文あり（kim-PC）', () => {
  const result = judge(
    'kim-PC からの返信が来たら、本番を再検証します。\n\n' +
    '急ぐ場合だけ、kim さんに口頭やチャットで『aujust の本番が古いブランチで動いている。kim さんの PC に届いている fleet-mail の件を対応して』と一言伝えてもらえると、本番が早く直ります。'
  );
  assert.deepEqual(result, { decision: 'pass' });
});

// pass: AI レーンの待機は対象外
test('pass: Codex の待機は対象外', () => {
  assert.deepEqual(judge('Codex の作業が終わったら確認します。'), { decision: 'pass' });
});

// pass: user 自身の返事待ちは対象外
test('pass: あなたの返信待ちは対象外', () => {
  assert.deepEqual(judge('あなたの返信を待っています。'), { decision: 'pass' });
});

// pass: コードブロック内だけの待機文
test('pass: コードブロック内の待機文は対象外', () => {
  assert.deepEqual(judge(
    '作業は完了しました。\n```text\nkim-PC からの返信が来たら、本番を再検証します。\n```\n以上です。'
  ), { decision: 'pass' });
});

// pass: 引用行内だけの待機文
test('pass: 引用行内の待機文は対象外', () => {
  assert.deepEqual(judge(
    '作業は完了しました。\n> kim-PC からの返信が来たら、本番を再検証します。'
  ), { decision: 'pass' });
});

// pass: 待機文がない普通の完了報告
test('pass: 待機文がない完了報告', () => {
  assert.deepEqual(judge('作業はすべて完了しました。テストは全件 PASS、本番反映済みです。'), { decision: 'pass' });
});

// pass: 環境変数で無効化
test('pass: ORGIAST_THIRD_PARTY_NUDGE_GATE=0 で無効化', t => {
  const before = process.env.ORGIAST_THIRD_PARTY_NUDGE_GATE;
  t.after(() => before === undefined ? delete process.env.ORGIAST_THIRD_PARTY_NUDGE_GATE : process.env.ORGIAST_THIRD_PARTY_NUDGE_GATE = before);
  process.env.ORGIAST_THIRD_PARTY_NUDGE_GATE = '0';
  assert.equal(enabled(), false);
  assert.deepEqual(judge('kim-PC からの返信が来たら、本番を再検証します。'), { decision: 'pass' });
  delete process.env.ORGIAST_THIRD_PARTY_NUDGE_GATE;
  assert.equal(enabled(), true);
  assert.equal(judge('kim-PC からの返信が来たら、本番を再検証します。').decision, 'block');
});

// block: 「急ぐ場合」があっても『』の中身が 15 字未満なら block
test('block: 後押し文の中身が 15 字未満', () => {
  const result = judge(
    '先方の回答待ちです。\n\n' +
    '急ぐ場合だけ、kim さんに口頭やチャットで『確認して』と一言伝えてもらえると進みます。'
  );
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'THIRD-PARTY-NUDGE');
});