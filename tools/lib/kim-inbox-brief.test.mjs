import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxBrief, formatInboxBrief } from './kim-inbox-relay-state.mjs';

function makeItem(overrides) {
  return {
    id: 'ki-20261112000000-0000',
    kind: 'info',
    source: '',
    text: '',
    createdAt: '2026-11-12T00:00:00.000Z',
    lastAt: '2026-11-12T00:00:00.000Z',
    status: 'open',
    shownSessions: [],
    shownCount: 0,
    ...overrides
  };
}

test('resume-failed info: extracts topic/happened/decide/reply correctly', t => {
  const item = makeItem({
    source: 'auto-progress-resume-failed',
    kind: 'info',
    text: '【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: CLAUDE.md配布 ／ セッションの目的: トーエネックにメールをおくって ／ 作業ID: 7f14e87b\n🔴 自動再開が連続失敗しています\n約束: このセッションに kim の承認が届き次第、Gmail（seisaku-team@orgiast.jp）から送信前チェックを通して送信し、送信済みを読み戻して報告します\n失敗回数: 3回（上限 8回）\n最終結果: error: failure (claude exit 1):'
  });
  const brief = inboxBrief(item);
  assert.ok(brief.topic.startsWith('作業用014: '), `topic should start with human-readable PC prefix: ${brief.topic}`);
  assert.ok(brief.topic.includes('トーエネックにメールをおくって'), `topic should include purpose: ${brief.topic}`);
  assert.doesNotMatch(brief.topic, /CLAUDE\.md配布|seisaku-team@|7f14e87b/);
  assert.ok(brief.happened.includes('自動再開が連続失敗しています'), `happened: ${brief.happened}`);
  assert.match(brief.decide, /自動再開が止まっている/, `decide for resume-failed: ${brief.decide}`);
  assert.match(brief.reply, /続けて/, `reply: ${brief.reply}`);
});

test('ask with reply-waiting: extracts decide from あなたの返事待ち line', t => {
  const item = makeItem({
    kind: 'ask',
    text: '【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: CLAUDE.md配布 ／ セッションの目的: Bで。ただし、作り方などはこれまでの蓄積を完全に引き継いでいるかチェックして。引き継がれていないなら… ／ 作業ID: c8d99e2b\n自動進行が判断待ちです: 三共精機様の資料メール着信を監視し、届いたら過去写真・費用・ロゴを反映して差分共有する。\nあなたの返事待ち: kim@orgiast.jp で開いてください: https://docs.google.com/document/d/AAA/edit?authuser=kim@orgiast.jp'
  });
  const brief = inboxBrief(item);
  assert.ok(brief.topic.includes('Bで。ただし'), `topic should include purpose text: ${brief.topic}`);
  assert.equal(brief.happened, '自動進行が判断待ちです: 三共精機様の資料メール着信を監視し、届いたら過去写真・費用・ロゴを反映して差分共有する。');
  assert.match(brief.decide, /kim@orgiast\.jp/, `decide should include reply-waiting content: ${brief.decide}`);
  assert.match(brief.reply, /可/, `reply for ask should include options`);
  assert.ok(brief.links.length > 0, `should have at least one link`);
  assert.deepEqual(brief.links, ['https://docs.google.com/document/d/AAA/edit?authuser=kim@orgiast.jp']);
});

test('info without special source: decide is 判断不要（報告のみ）', t => {
  const item = makeItem({
    kind: 'info',
    text: '【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: CLAUDE.md配布 ／ セッションの目的: 定時進捗報告 ／ 作業ID: aabbccdd\n夜間処理が完了しました\nすべてのタスクが正常終了'
  });
  const brief = inboxBrief(item);
  assert.match(brief.decide, /判断不要/, `info decide should say 報告のみ: ${brief.decide}`);
  assert.match(brief.reply, /返事不要/, `info reply should say 返事不要`);
  assert.ok(brief.happened.includes('夜間処理'), `happened should include content: ${brief.happened}`);
});

test('no header: topic uses first line', t => {
  const item = makeItem({
    kind: 'ask',
    text: '承認をお願いします\n詳細は添付の通りです。'
  });
  const brief = inboxBrief(item);
  assert.ok(brief.topic.includes('承認をお願いします'), `topic should use first line: ${brief.topic}`);
  assert.ok(brief.decide.includes('返事内容の指定なし'), `no decide line found: ${brief.decide}`);
});

test('formatInboxBrief produces expected multi-line format', t => {
  const item = makeItem({
    text: '【DELL・seisaku-team@orgiast.jp の Claude Code】セッションの目的: ロゴ確認 ／ プロジェクト: test\nロゴが届きました。確認してください。\nhttps://example.com/logo.png'
  });
  const formatted = formatInboxBrief(item, 3);
  const lines = formatted.split('\n');
  assert.match(lines[0], /^3\..*ロゴ確認.*/, `line 1 should start with number and topic: ${lines[0]}`);
  assert.ok(lines.some(l => l.includes('起きたこと')), `should contain 起きたこと line`);
  assert.ok(lines.some(l => l.includes('判断してほしいこと')), `should contain 判断してほしいこと line`);
  assert.ok(lines.some(l => l.includes('返事の例')), `should contain 返事の例 line`);
  assert.ok(lines.some(l => l.includes('開く')), `should contain 開く line for link`);
  assert.ok(lines.some(l => l.includes('example.com')), `should contain the URL`);
});
