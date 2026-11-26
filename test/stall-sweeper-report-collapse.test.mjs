import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { report, itemsDetail, COLLAPSE_THRESHOLD, KINDS } from '../tools/stall-sweeper.mjs';

function makeItem(kind, staleDays, title) {
  return {
    kind,
    id: `${kind}:${title}`,
    title: title || `テスト項目 ${kind} ${staleDays}日`,
    location: `/path/to/${kind}`,
    staleDays,
    nextAction: 'テストアクション',
    reason: 'テスト理由',
    humanRequired: false,
  };
}

describe('stall-sweeper report collapse', () => {
  it('stale_branch 296件を集約行に、uncommitted 2件を個別行に', () => {
    const items = [];
    // 296件の stale_branch（staleDays をバラけさせる）
    for (let i = 0; i < 296; i++) {
      items.push(makeItem('stale_branch', 10 + (i % 90), `stale-branch-${i}`));
    }
    // 2件の uncommitted
    items.push(makeItem('uncommitted', 3, 'repo-alpha 未コミット'));
    items.push(makeItem('uncommitted', 5, 'repo-beta 未コミット'));
    const result = report(items, [], [], false);

    // stale_branch の個別行が無いこと
    const individualLines = result.split('\n').filter(l => l.startsWith('- stale-branch-'));
    assert.equal(individualLines.length, 0, 'stale_branch の個別行があってはならない');

    // 集約行に 296件 が含まれること
    assert.ok(result.includes('296件'), '集約行に 296件 が含まれなければならない');
    assert.ok(result.includes('stale_branch: 296件'), '集約行が stale_branch: 296件 の形式でなければならない');

    // uncommitted の 2 件が個別行で出ること
    const uncommittedLines = result.split('\n').filter(l => l.includes('repo-alpha 未コミット') || l.includes('repo-beta 未コミット'));
    assert.equal(uncommittedLines.length, 2, 'uncommitted は 2 行の個別行で出なければならない');
  });

  it('集約行の最古 staleDays と代表3件が古い順であること', () => {
    const items = [];
    // stale_branch を 15 件作成（staleDays を意図的にばらけさせる）
    for (let i = 0; i < 15; i++) {
      items.push(makeItem('stale_branch', 10 + i)); // 10..24
    }
    const result = report(items, [], [], false);

    // 集約行があること
    assert.ok(result.includes('stale_branch: 15件'), '集約行がなければならない');

    // 最古は最大の staleDays = 24
    assert.ok(result.includes('最古 24日'), '最古が 24日 でなければならない');

    // 代表3件は古い順（24, 23, 22）
    // staleDays が最大のものが先頭に来るので、title に "テスト項目 stale_branch 24日" などが含まれる
    const title24 = `テスト項目 stale_branch 24日`;
    const title23 = `テスト項目 stale_branch 23日`;
    const title22 = `テスト項目 stale_branch 22日`;
    assert.ok(result.includes(title24), '代表に最古の24日が含まれなければならない');
    assert.ok(result.includes(title23), '代表に2番目に古い23日が含まれなければならない');
    assert.ok(result.includes(title22), '代表に3番目に古い22日が含まれなければならない');
  });

  it('全 kind がしきい値以下のとき従来どおり全件個別行になる', () => {
    const items = [];
    // 各 kind に 2 件ずつ（合計 14 件、いずれもしきい値の 10 以下）
    for (const kind of KINDS) {
      items.push(makeItem(kind, 5, `item-a-${kind}`));
      items.push(makeItem(kind, 7, `item-b-${kind}`));
    }
    const result = report(items, [], [], false);

    // 集約行（kind: N件）のパターンが無いこと
    // 各 kind について「kind: 2件」のような集約行がないことを確認
    for (const kind of KINDS) {
      const pattern = `${kind}: 2件`;
      // テーブル行（カテゴリ行）には "| stale_branch | 2 |" という記述があるので、
      // "stale_branch: 2件" が集約行として出ていないことを確認
      const lines = result.split('\n').filter(l => l.trim() === `- ${pattern}（最古` || l.startsWith(`- ${kind}: `));
      assert.ok(lines.length <= 2, `${kind} の個別行は最大2行（集約行があってはならない）`);
      // 集約行の形式（件を含む）が無いことを確認
      assert.equal(lines.filter(l => /\d+件/.test(l)).length, 0, `${kind} に集約行（件を含む行）があってはならない`);
    }

    // 個別行の形式で14件すべて出ていること
    for (const kind of KINDS) {
      assert.ok(result.includes(`item-a-${kind}`), `item-a-${kind} が個別行に含まれなければならない`);
      assert.ok(result.includes(`item-b-${kind}`), `item-b-${kind} が個別行に含まれなければならない`);
    }
  });

  it('itemsDetail() が全 298 件分の行を含む', () => {
    const items = [];
    for (let i = 0; i < 296; i++) {
      items.push(makeItem('stale_branch', 10 + (i % 90), `stale-branch-${i}`));
    }
    items.push(makeItem('uncommitted', 3, 'repo-alpha 未コミット'));
    items.push(makeItem('uncommitted', 5, 'repo-beta 未コミット'));
    const detail = itemsDetail(items);

    // 全 298 件の文字が含まれること
    assert.ok(detail.includes('全 298 件'), '全件数 298 が含まれなければならない');

    // stale_branch の各行が含まれること
    for (let i = 0; i < 5; i++) {
      assert.ok(detail.includes(`stale-branch-${i}`), `stale-branch-${i} が詳細に含まれなければならない`);
    }
    // uncommitted が含まれること
    assert.ok(detail.includes('repo-alpha 未コミット'), 'repo-alpha が詳細に含まれなければならない');
    assert.ok(detail.includes('repo-beta 未コミット'), 'repo-beta が詳細に含まれなければならない');

    // 296行 + 2行 = 298 行
    const lineCount = detail.split('\n').filter(l => l.startsWith('- ')).length;
    assert.equal(lineCount, 298, `itemsDetail の行数は 298 でなければならない（実際: ${lineCount}）`);
  });
});