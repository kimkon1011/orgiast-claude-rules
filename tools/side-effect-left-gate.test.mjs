import test from 'node:test';
import assert from 'node:assert/strict';
import { judgeSideEffectLeft } from './side-effect-left-gate.mjs';

const blocked = [
  '上書きして消してしまいました。', '上書きしてしまいました。', '上書きしちゃって元に戻せません。', '復元できません。',
  '営業アプリは GitHub 通知を取り込まなくなる。',
  '通知が取り込まれなくなります。', '画面が見えなくなります。', 'ログインできなくなる。',
  '既存PCに影響があります。', '既存PCに影響は出ます。', '既存PCに影響します。',
  '副作用があります。', '取りこぼしがあります。', '未対応です。', '未対応のままです。', '既知の問題です。',
  '後で直す。', '別途対応します。', 'お客様のメールには影響しません。', '影響せず改善になります。',
  '影響はありません。', '影響なし。',
  '影響があります。[SIDE-EFFECT-OK]', '影響があります。[SIDE-EFFECT-OK]   ',
  '影響があります。\n\n修正済み。',
  '影響があります。\n> 修正済み。',
  '影響があります。\n```\n修正済み。\n```',
  '影響があります。修正済みではありません。',
  '未対応です。修正したいです。',
  '影響はありません。実測します。',
  '漏れは修正済み。\n\n別の副作用があります。',
  '```\n影響があります。\n```\n未対応です。',
];
for (const text of blocked) test(`block: ${JSON.stringify(text)}`, () => {
  const result = judgeSideEffectLeft(text);
  assert.equal(result.decision, 'block');
  assert.equal(result.code, 'SIDE-EFFECT');
  assert.ok(result.reason.includes(result.claim));
  assert.match(result.reason, /修正→検証→結果を書く/);
});

const passed = [
  '上書きして消してしまいました。\n修正済み、フォーム回答と読み戻しが一致。',
  '', undefined, '実装と検証が完了しました。', '影響範囲を調べます。', 'リスクを調べます。',
  '副作用について説明します。',
  '漏れを直しました。', '漏れは修正済みです。', 'リスクは対処済みです。',
  '未対応部分を修正した。', '懸念 → 修正、テスト成功。',
  '取りこぼしは PR #123 で解消。', '漏れを commit abc1234 で修正。',
  '影響があります。\n修正済み、テスト成功。',
  '影響はありません。対象10件を実測した結果、全件一致。',
  '読み戻しで対象の全レコードが一致。影響はありません。',
  '影響はありません。\n対象を確認したところ件数が一致。',
  '実測: 影響なし。',
  '未対応です。[SIDE-EFFECT-OK] user の課金承認が必要。',
  '未対応です。\n[SIDE-EFFECT-OK] user の権限付与が必要。',
  '> 影響があります。', '  > 未対応です。',
  '```text\n副作用があります。\n```', '~~~text\n未対応です。\n~~~',
  '````text\n```\n未対応です。\n````',
  '```\n未対応です。', '    副作用があります。', '\t未対応です。',
  '影響があります。\r\n修正済み。',
  // 分析文・比較表・user 側の残作業は対象外（直近494応答の誤検知実測で除外した語）
  'このやり方は否認リスクがかなり高い。', '同期が止まる可能性があります。', '古い設定が残っています。',
  '| 案 | 手間 | リスク |', '残っているのは支払いだけ。[BURDEN-OK] 支払いは本人にしかできない。',
  '手間監査: 残っているのは OAuth 同意1回だけ。', '[STOP-OK] 残りは kim の OAuth 同意だけ。',
];
for (const text of passed) test(`pass: ${JSON.stringify(text)}`, () => {
  assert.equal(judgeSideEffectLeft(text).decision, 'pass');
});

test('環境変数0で停止できる', t => {
  const previous = process.env.ORGIAST_SIDE_EFFECT_LEFT_GATE;
  t.after(() => {
    if (previous === undefined) delete process.env.ORGIAST_SIDE_EFFECT_LEFT_GATE;
    else process.env.ORGIAST_SIDE_EFFECT_LEFT_GATE = previous;
  });
  process.env.ORGIAST_SIDE_EFFECT_LEFT_GATE = '0';
  assert.equal(judgeSideEffectLeft('未対応です。').decision, 'pass');
});

test('同ターンにツール実行があっても告知だけならblockする', () => {
  const result = judgeSideEffectLeft('未対応です。', [{ type: 'tool_use', name: 'Bash', input: { command: 'node --test' } }]);
  assert.equal(result.decision, 'block');
  assert.equal(result.toolUseCount, 1);
});
