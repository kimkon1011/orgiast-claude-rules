import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePrHandoff } from './pr-handoff-gate.mjs';

const cases = [
  ['gh 未認証による作成の手渡し', '`gh` が未認証なので PR を作ってください', 'block'],
  ['PR 作成 URL の提示', 'https://github.com/kimkon1011/orgiast-claude-rules/pull/new/auto/xxx', 'block'],
  ['ラベル付けの手渡し', 'PR にラベルを付けてください', 'block'],
  ['作成完了報告', 'PR #534 を作成しました', 'pass'],
  ['マージ依頼', 'PR をマージしてください', 'pass'],
  ['インラインコマンド例', '`gh pr create --base main`', 'pass'],
  ['無関係な依頼', 'シートを開いてください', 'pass'],
  ['空文字', '', 'pass'],
  ['undefined', undefined, 'pass'],
  ['作成済みでレビュー依頼', 'PR は作成済みです。レビューをお願いします', 'pass'],
  ['PR のレビュー依頼', 'PR のレビューをお願いします', 'pass'],
  ['作成とマージを別文で依頼', 'PR を作成してください。マージしてください', 'block'],
  ['作成とマージで依頼語を共有', 'PR を作成して、マージしてください', 'block'],
  ['マージ依頼後のラベル依頼', 'PR をマージしてください。PR にラベルを付けてください', 'block'],
  ['作成の必要性を提示', 'PR の作成が必要です', 'block'],
  ['PR をお願いします', 'PR をお願いします', 'block'],
  ['クリック依頼', 'PR 画面のボタンをクリックしてください', 'block'],
  ['pull request 表記', 'pull request を作成してください', 'block'],
  ['プルリク表記', 'プルリクを作ってください', 'block'],
  ['PR は独立語に限定', 'SPRINT を作ってください', 'pass'],
  ['小文字 pr は対象外', 'pr を作ってください', 'pass'],
  ['バッククォートのコードブロック', '```sh\ngh pr create --base main\nPR を作ってください\n```', 'pass'],
  ['チルダのコードブロック', '~~~sh\nPR を作ってください\n~~~', 'pass'],
  ['完了報告後の無関係な依頼', 'PR #534 を作成しました。シートを開いてください', 'pass'],
  ['null', null, 'pass'],
  ['文字列以外', {}, 'pass'],
  ['マージの必要性を提示', 'PR をマージすることが必要です', 'pass'],
  ['同じ文の完了報告とレビュー依頼', 'PR は作成済みです、レビューをお願いします', 'pass'],
];

for (const [name, input, expected] of cases) {
  test(name, () => {
    const result = evaluatePrHandoff(input);
    assert.equal(result.decision, expected);
    assert.equal(typeof result.reason, 'string');
    if (expected === 'pass') assert.equal(result.reason, '');
  });
}

test('block の reason は認証経路とコピー可能なコマンドを含む', () => {
  const result = evaluatePrHandoff('PR を作成してください');
  assert.equal(result.decision, 'block');
  assert.ok(result.reason.includes('`gh` 未認証は PR 作成を手渡す理由にならない'));
  assert.ok(result.reason.includes(
    'credential helper に PAT が入っているので、`git push` が通る機体なら必ず作れる',
  ));
  const command = "GH_TOKEN=$(printf 'protocol=https\\nhost=github.com\\n\\n' | git credential fill | sed -n 's/^password=//p') gh pr create --base main --head <branch> --title \"<題>\" --body-file <本文ファイル>";
  assert.ok(result.reason.split('\n').includes(command));
  assert.ok(!result.reason.includes('マージ'));
});
