import test from 'node:test';
import assert from 'node:assert/strict';
import { findHandoffWithoutInfo, formatViolationMessage, splitBlocks } from './handoff-info-guard.mjs';

test('過去参照だけでコマンドを再実行させる回帰ケースは tier A', () => {
  const result = findHandoffWithoutInfo('AI設定の配布に不具合がありました。お手数ですが、前回と同じコマンドをもう一度 PowerShell に貼って Enter してください');
  assert.equal(result?.tier, 'A');
});

test('情報なしでリモートPCに実行を頼むと tier B', () => {
  assert.equal(findHandoffWithoutInfo('リモートPCでもう一度実行してください')?.tier, 'B');
});

test('情報なしで Discord の設定作業を頼むと tier B', () => {
  assert.equal(findHandoffWithoutInfo('Discord にログインして設定を有効にしてください')?.tier, 'B');
});

test('名詞形の依頼語尾も tier B', () => {
  assert.equal(findHandoffWithoutInfo('リモートPCでコマンドの実行をお願いします')?.tier, 'B');
});

test('依頼と同じ本文に URL があれば違反にしない', () => {
  const text = '前回と同じコマンドをもう一度 PowerShell に貼って Enter してください。https://example.com/setup';
  assert.equal(findHandoffWithoutInfo(text), null);
});

test('依頼と同じ本文にコマンド全文のコードブロックがあれば違反にしない', () => {
  const text = 'リモートPCでもう一度実行してください。\n```powershell\nnode tools/setup.mjs --force\n```';
  assert.equal(findHandoffWithoutInfo(text), null);
});

test('完了報告のみは違反にしない', () => {
  assert.equal(findHandoffWithoutInfo('修正して push しました。CI も緑です'), null);
});

test('Claude 自身の行為は違反にしない', () => {
  assert.equal(findHandoffWithoutInfo('私がリモートで実行して確認しました'), null);
});

test('HANDOFF-INFO-OK があれば常に違反にしない', () => {
  assert.equal(findHandoffWithoutInfo('前回と同じ手順を実行してください。[HANDOFF-INFO-OK]'), null);
});

test('コードレビュー中の技術説明は違反にしない', () => {
  assert.equal(findHandoffWithoutInfo('この関数は設定して返しているため、副作用はありません'), null);
});

test('違反なしのメッセージは空文字', () => {
  assert.equal(formatViolationMessage(null), '');
});

test('tier A のメッセージは過去参照を指摘する', () => {
  const message = formatViolationMessage({ tier: 'A', reasons: ['x'] });
  assert.match(message, /前回と同じ/);
  assert.match(message, /過去を参照/);
});

// --- 実データ回帰テスト ---
// 初版は下の12件が緑のまま、実際にこのルールを作る原因になった2つのメッセージを
// 1件も検出できなかった。合成した短文だけを見ていたのが原因なので、
// 実物を逐語で置いて守る。ここを短く書き直さないこと。

const REAL_VIOLATION_DOC_GUIDANCE = `この5人は「再実行」のお願いです。Doc の中身は変えていないので、前と同じ1行を貼り直すだけで修正版が入ります。そのまま送れる文面：

AI設定の配布に不具合があり、8/17〜18 に設定した方のPCへ最新版が届いていませんでした。お手数ですが、前回と同じコマンドをもう一度 PowerShell に貼って Enter してください（新しいコマンドはありません）。
https://docs.google.com/a/orgiast.jp/document/d/1LbkbWZKsbzjucjAG1kzdDnmeYjz1BWgZiLeTWSIvNyw/edit`;

const REAL_VIOLATION_FIX_REPORT = `直りました。リモートPCで同じ1行をもう一度貼れば通ります。

## 再発防止（PR #96・マージ済み）
tools/pscheck.ps1 を CI の Windows ジョブに配線しました。
https://github.com/kimkon1011/orgiast-claude-rules/pull/96`;

test('実データ: 依頼ブロックに貼るコマンドが無い配布Doc案内は tier A', () => {
  // Doc URL は別ブロックにあり、依頼ブロック自身には実行できる情報が無い。
  assert.equal(findHandoffWithoutInfo(REAL_VIOLATION_DOC_GUIDANCE)?.tier, 'A');
});

test('実データ: 別件PRリンクしか無い完了報告中の依頼は tier B', () => {
  // 「貼れば通ります」の言い切り。本文の別の場所にある PR リンクは依頼を実行可能にしない。
  assert.equal(findHandoffWithoutInfo(REAL_VIOLATION_FIX_REPORT)?.tier, 'B');
});

test('無関係な URL が本文のどこかにあるだけでは違反を打ち消さない', () => {
  // 初版の致命的な欠陥。実際の応答には別件のリンクがほぼ必ず入るため、
  // 本文全体を見る実装だと事実上いつも素通しになる。
  const text = 'リモートPCでもう一度実行してください。\n\n参考: https://github.com/kimkon1011/orgiast-claude-rules/pull/96';
  assert.equal(findHandoffWithoutInfo(text)?.tier, 'B');
});

test('言い切り形の依頼(〜すれば通ります)も依頼として扱う', () => {
  assert.equal(findHandoffWithoutInfo('リモートPCで同じ1行をもう一度貼れば通ります。')?.tier, 'B');
});

test('依頼ブロック内に URL とコマンドがあれば違反にしない', () => {
  const text = `下のコマンドを PowerShell に貼って Enter してください。
対象: https://docs.google.com/a/orgiast.jp/document/d/1LbkbW/edit
\`\`\`
irm 'https://example.com/install.ps1' -OutFile "$env:TEMP\\i.ps1"
\`\`\``;
  assert.equal(findHandoffWithoutInfo(text), null);
});

test('箇条書き手順に URL とコマンドを添えた依頼は違反にしない', () => {
  const text = `次の手順でお願いします。
- 1. https://github.com/kimkon1011/orgiast-claude-rules/settings を開いてください
- 2. 下を貼って実行してください: \`node tools/register-hooks.mjs --hooks-only\``;
  assert.equal(findHandoffWithoutInfo(text), null);
});

test('フェンス付きコードブロックは直前の依頼ブロックに属する', () => {
  const blocks = splitBlocks('下を貼ってください。\n```\nnode x.mjs\n```');
  assert.equal(blocks.length, 1);
});
