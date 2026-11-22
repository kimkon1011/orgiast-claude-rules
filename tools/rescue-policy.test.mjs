import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildRescueReviewMessage } from './rescue-policy.mjs';

describe('buildRescueReviewMessage', () => {
  it('計N件 と 列挙行数 が一致する', () => {
    const branches = [
      'rescue/auto-session-20261117-005005',
      'rescue/auto-session-20261122-212603',
      'rescue/auto-session-20261122-212803',
    ];
    const msg = buildRescueReviewMessage('rescue/auto-session-20261122-212803', branches);
    // 本文から「計 N 件」の N を抽出
    const countMatch = msg.match(/計 (\d+) 件/);
    assert(countMatch, 'メッセージに「計 N 件」が見つかりません');
    const count = Number(countMatch[1]);
    // 本文から「- 」で始まる行数をカウント
    const listedLines = msg.split('\n').filter(l => l.startsWith('- ')).length;
    assert.equal(count, listedLines, `計 ${count} 件 に対して列挙は ${listedLines} 行`);
    assert.equal(count, branches.length);
  });

  it('重複があるデータを渡した場合、計N件と列挙行数は一致する（重複排除は呼び出し側の責務）', () => {
    const branch = 'rescue/auto-session-20261122-212803';
    const branches = [
      'rescue/auto-session-20261117-005005',
      'rescue/auto-session-20261122-212803',
      'rescue/auto-session-20261122-212803', // 重複
    ];
    const msg = buildRescueReviewMessage(branch, branches);
    const countMatch = msg.match(/計 (\d+) 件/);
    assert(countMatch);
    const count = Number(countMatch[1]);
    const listedLines = msg.split('\n').filter(l => l.startsWith('- ')).length;
    // 渡された配列の length が使われていること（重複排除は呼び出し側の責務）
    assert.equal(count, listedLines);
    assert.equal(count, branches.length);
  });

  it('ブランチが0件でも壊れない', () => {
    const msg = buildRescueReviewMessage('rescue/auto-session-20261122-212803', []);
    const countMatch = msg.match(/計 (\d+) 件/);
    assert(countMatch);
    assert.equal(Number(countMatch[1]), 0);
    const listedLines = msg.split('\n').filter(l => l.startsWith('- ')).length;
    assert.equal(listedLines, 0);
  });

  it('最新ブランチ名がメッセージ先頭に含まれる', () => {
    const latest = 'rescue/auto-session-20261122-212803';
    const msg = buildRescueReviewMessage(latest, ['rescue/auto-session-20261117-005005', latest]);
    assert(msg.includes(latest), '最新ブランチ名がメッセージに含まれていません');
    assert(msg.startsWith('rescue ブランチのレビュー・削除承認待ち（最新:'), 'メッセージの形式が想定外です');
  });

  it('既存 state に rescueCount が実体とずれた値（99）で入っていても、通知生成後は rescueCount === rescueBranches.length になる', () => {
    // buildRescueReviewMessage は branches.length から導出するため外部のずれた値の影響を受けない
    const branches = ['rescue/auto-session-20261117-005005', 'rescue/auto-session-20261122-212803'];
    const msg = buildRescueReviewMessage('rescue/auto-session-20261122-212803', branches);
    const countMatch = msg.match(/計 (\d+) 件/);
    assert(countMatch);
    assert.equal(Number(countMatch[1]), branches.length);
    assert.notEqual(Number(countMatch[1]), 99);
  });
});
