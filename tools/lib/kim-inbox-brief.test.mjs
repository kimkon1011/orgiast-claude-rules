import test from 'node:test';
import assert from 'node:assert/strict';
import { inboxBrief, formatInboxBrief, groupInboxItems } from './kim-inbox-relay-state.mjs';

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
  assert.deepEqual(brief, {
    topic: '作業用014: トーエネックにメールをおくって',
    happened: '自動再開が連続失敗しています',
    decide: '自動再開が止まっている。続けるか中止するか',
    reply: 'N 続けて／N 中止', links: [],
  });
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
  assert.equal(brief.topic, '作業用014: Bで。ただし、作り方などはこれまでの蓄積を完全に引き継いでいるかチェックして。引き継がれていないなら…');
  assert.equal(brief.decide, 'kim@orgiast.jp で開いてください: https://docs.google.com/document/d/AAA/edit?authuser=kim@orgiast.jp');
  assert.equal(brief.reply, 'N 可／N 不要／N <指示>');
});

test('long action and registration URLs remain complete; reply uses the displayed number', () => {
  const url = 'https://example.com/register?authuser=kim@orgiast.jp&token=' + 'x'.repeat(250);
  const item = makeItem({ kind: 'ask', source: 'knowledge-lock-passkey-link',
    text: `鍵の登録\n判断してほしいこと: 登録してください: ${url}\n登録リンク: ${url}\nhttps://example.com/help` });
  const brief = inboxBrief(item);
  assert.equal(brief.decide, `登録してください: ${url}`);
  assert.deepEqual(brief.links, [url, 'https://example.com/help']);
  assert.ok(formatInboxBrief(item, 7).includes(`開く: https://example.com/help`));
  assert.match(formatInboxBrief(item, 7), /返事の例: 7 可／7 不要／7 <指示>/);
});

test('no inferred approval from passive waiting; explicit labels and deadlines are preserved', () => {
  const passive = makeItem({ kind: 'ask', text: '自動進行が判断待ちです: 資料を監視する' });
  assert.equal(inboxBrief(passive).decide, `返事内容の指定なし（原文確認: node tools/kim-inbox.mjs --show ${passive.id}）`);
  for (const label of ['あなたの返事待ち', '答えてほしいこと', '判断してほしいこと', '承認待ち', '約束']) {
    assert.equal(inboxBrief({ ...passive, text: `報告\n${label}： 資料を確認する` }).decide, '資料を確認する');
  }
  assert.equal(inboxBrief({ ...passive, kind: 'deadline', key: 'D-017' }).reply, 'D-017 完了／延期 11/20／不要');
  assert.equal(inboxBrief({ ...passive, text: '完了\nkim の承認待ち 8 件:\n1. 外部公開' }).decide, 'kim の承認待ち 8 件:');
});

test('only happened is capped; headerless bracket headings and purpose slash are meaningful', () => {
  const first = '【連絡】' + 'あ'.repeat(150);
  const brief = inboxBrief(makeItem({ from: 'DELL', text: first }));
  assert.equal(brief.topic, `作業用014: 連絡 ${'あ'.repeat(77)}`);
  assert.equal(Array.from(brief.topic.replace('作業用014: ', '')).length, 80);
  assert.equal(brief.happened, '');
  assert.equal(inboxBrief(makeItem({ text: '【DELL・user@example.com の Claude Code】プロジェクト: 配布 ／ セッションの目的: A／Bを比較… ／ 作業ID: 12345678\n確認が完了' })).topic, '作業用014: A／Bを比較…');
  assert.equal(inboxBrief(makeItem({ text: '【DELL・user@example.com の Claude Code】プロジェクト: 配布 ／ 作業ID: 12345678\n確認が完了' })).topic, '作業用014: 確認が完了');
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
  assert.ok(!lines.some(l => l.includes('起きたこと')), `same happened/decide sentence should not be repeated`);
  assert.ok(lines.some(l => l.includes('判断してほしいこと')), `should contain 判断してほしいこと line`);
  assert.ok(lines.some(l => l.includes('返事の例')), `should contain 返事の例 line`);
  assert.ok(lines.some(l => l.includes('開く')), `should contain 開く line for link`);
  assert.ok(lines.some(l => l.includes('example.com')), `should contain the URL`);
});

// Fix 1: info でも判断キーワードを含む行があれば decide に採用
test('info with decision keywords uses decide instead of 判断不要', t => {
  const item = makeItem({
    kind: 'info',
    text: '【[要望] アリババ、お支払いのみ】 対応が遅れています。あなたの承認待ちで 8 日止まっています。PR を確認してください。 https://github.com/kimkon1011/purchasing-management-app/pull/17'
  });
  const brief = inboxBrief(item);
  assert.doesNotMatch(brief.decide, /判断不要/);
  assert.match(brief.decide, /PR を確認/);
  assert.match(brief.decide, /承認待ち/);
  // Negative: 否定パターンは判断不要のまま
  const negative = inboxBrief(makeItem({ kind: 'info', text: '連絡\nkim がすること: なし' }));
  assert.match(negative.decide, /判断不要/);
});

// Fix 2: 見出し行の次の非空行〜最大3行を連結
test('action heading with no content captures follow-up lines into decide', t => {
  const brief = inboxBrief(makeItem({
    kind: 'ask',
    text: 'kim がやること（作業用014 で1回だけ）:\n1. ファイルを開く\n2. 確認する\n3. 報告する'
  }));
  assert.match(brief.decide, /ファイルを開く/);
  assert.match(brief.decide, /確認する/);
  assert.match(brief.decide, /報告する/);
  assert.doesNotMatch(brief.decide, /返事内容の指定なし/);
  const withUrl = inboxBrief(makeItem({
    kind: 'ask',
    text: 'kim がやること（作業用014 で1回だけ）:\n1. 次を開く\nhttps://example.com/path?token=abc\n3. 承認する'
  }));
  assert.match(withUrl.decide, /https:\/\/example\.com\/path\?token=abc/);
});

// Fix 3: links の重複除去・末尾記号除去・decide内URLの重複防止
test('links are deduplicated, trailing punctuation stripped, decide URLs not duplicated in 開く', t => {
  const url = 'https://docs.google.com/document/d/BBB/edit';
  const authUrl = 'https://docs.google.com/document/d/BBB/edit?authuser=kim@orgiast.jp';
  const text = `判断してほしいこと: ${authUrl} を確認\n詳細: ${url}）、${url}））\nhttps://example.com/other。）、*`;
  const item = makeItem({ kind: 'ask', text });
  const brief = inboxBrief(item);
  assert.ok(brief.links.includes(authUrl), `authUrl should be in links: ${brief.links}`);
  assert.ok(brief.links.includes('https://example.com/other'), `help link should be in links: ${brief.links}`);
  assert.equal(brief.links.length, 2, `should have exactly 2 links after dedup: ${brief.links.length}`);
  const formatted = formatInboxBrief(item, 5);
  const openLines = formatted.split('\n').filter(l => l.includes('開く:'));
  assert.equal(openLines.length, 1, `URL in decide should not appear in 開く:; open lines: ${JSON.stringify(openLines)}`);
  assert.ok(openLines[0].includes('example.com/other'), `remaining open link should be help URL`);
});

test('topic and happened from same line use next meaningful line for happened', t => {
  const brief = inboxBrief(makeItem({
    kind: 'ask',
    text: '【緊急】サーバー障害対応\n確認してください\nhttps://example.com/status'
  }));
  assert.equal(brief.topic, '緊急 サーバー障害対応');
  assert.equal(brief.happened, '確認してください');

  const longTopic = '障害対応の進捗を確認' + '中'.repeat(90);
  const contained = inboxBrief(makeItem({
    kind: 'ask',
    text: `${longTopic}\n復旧作業を開始`
  }));
  assert.equal(contained.happened, '復旧作業を開始');
});

// --- Fix 1: info でも decide 抽出時は reply が選択肢になる ---
test('info with extracted decide gets reply options instead of 返事不要', t => {
  const item = makeItem({
    kind: 'info',
    text: '【[要望] アリババ、お支払いのみ】\n対応が遅れています。あなたの承認待ちで 8 日止まっています。PR を確認してください。\nhttps://github.com/kimkon1011/purchasing-management-app/pull/17'
  });
  const brief = inboxBrief(item);
  assert.doesNotMatch(brief.reply, /返事不要/, 'info with action decide should not say 返事不要');
  assert.equal(brief.reply, 'N マージしてよい／N <修正点>');
  assert.match(brief.decide, /PR を確認/, 'decide should include PR check instruction');
  assert.equal(brief.happened, '', 'the same sentence is not repeated as happened and decide');
});

test('info with 判断不要 keeps reply as 返事不要', t => {
  const brief = inboxBrief(makeItem({ kind: 'info', text: '夜間処理が完了しました' }));
  assert.match(brief.reply, /返事不要/, 'info without decide keywords keeps 返事不要');
});

// --- Fix 2: URL-guide lines excluded from happened/topic ---
test('URL-guide lines are excluded from happened; URLs not truncated', t => {
  const item = makeItem({
    kind: 'ask',
    text: 'バックアップが止まっています\nkim がやること: ログインする\n手順書（kim@orgiast.jp で開く）: https://docs.google.com/document/d/AAA/edit?authuser=kim@orgiast.jp'
  });
  const brief = inboxBrief(item);
  assert.doesNotMatch(brief.happened, /手順書/, 'happened should not include URL-guide line');
  assert.doesNotMatch(brief.happened, /docs\.google/, 'happened should not include URL-guide URL');
  assert.ok(brief.links.some(l => l.includes('docs.google.com')), 'URL-guide URL should remain in links');
});

test('long topic is not cut inside full-width parentheses', () => {
  const item = makeItem({
    kind: 'ask',
    from: 'DELL',
    text: '作業用014 の毎日のバックアップ（ClaudeDailyDriveBackup）が、パソコン版ドライブ未ログインのため止まっています（インストールと起動は済み、期限ジョブ2本は 11/12 18:04 の実行で正常＝0x0）。\nkim がやること（作業用014 で1回だけ）: ログインする\n手順書（kim@orgiast.jp で開く）: https://docs.google.com/document/d/AAA/edit?authuser=kim@orgiast.jp'
  });
  const brief = inboxBrief(item);
  assert.match(brief.topic, /パソコン版ドライブ未ログインのため止まっています…$/);
  assert.equal(brief.happened, '');
  assert.doesNotMatch(brief.topic, /（[^）]*$/);
});

test('topic never cuts a URL in the middle', () => {
  const url = `https://example.com/${'a'.repeat(100)}`;
  const brief = inboxBrief(makeItem({ text: `確認してください ${'前'.repeat(55)} ${url}` }));
  assert.ok(brief.topic.endsWith(url) || !brief.topic.includes('https://'), brief.topic);
});

test('happened falls back past URL-guide line', t => {
  const item = makeItem({
    kind: 'ask',
    text: '作業用014 の毎日のバックアップが止まっています\nkim がやること: ログインする\n手順書（kim@orgiast.jp で開く）: https://docs.google.com/document/d/AAA/edit?authuser=kim@orgiast.jp\n実際の操作: 画面右下のアイコンをクリック'
  });
  const brief = inboxBrief(item);
  assert.doesNotMatch(brief.happened, /手順書/, 'happened skips URL-guide line');
  assert.ok(brief.happened === '' || brief.happened.includes('実際の操作'), 'happened picks next meaningful line after URL-guide or is empty');
});

// --- Fix 3: Markdown symbols stripped from happened/topic/decide ---
test('Markdown heading markers stripped from happened', t => {
  const item = makeItem({
    kind: 'info',
    text: '毎日のお知らせ\n\n## Googleタスク: kim の操作・判断待ち（35件 / 最終更新 00:20）'
  });
  const brief = inboxBrief(item);
  assert.doesNotMatch(brief.happened, /^##\s/, 'happened should not start with # heading markers');
  assert.doesNotMatch(brief.happened, /\*\*/, 'happened should not contain bold markers');
  assert.doesNotMatch(brief.happened, /📋/, 'happened should not contain emoji');
});

test('Markdown bold markers stripped from decide', t => {
  const item = makeItem({ kind: 'info', text: '連絡\nあなたの返事待ち: **緊急**の対応が必要です' });
  const brief = inboxBrief(item);
  assert.doesNotMatch(brief.decide, /\*\*/, 'decide should not contain bold markers');
  assert.match(brief.decide, /緊急/, 'decide content preserved after stripping markers');
});

test('Markdown list markers stripped from happened', t => {
  const item = makeItem({ kind: 'info', text: '報告\n\n- 項目1: 完了\n- 項目2: 進行中' });
  const brief = inboxBrief(item);
  assert.doesNotMatch(brief.happened, /^-\s+/, 'happened should not start with list marker');
});

// --- ki-20261112163232-f09d 形式: 標準ヘッダー＋複数リンク ---
test('ask with あなたの返事待ち and multiple links works with standard header', t => {
  const item = makeItem({
    kind: 'ask',
    text: '【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: CLAUDE.md配布 ／ セッションの目的: Bで。ただし、作り方などはこれまでの蓄積を完全に引き継いでいるかチェックして。引き継がれていないなら… ／ 作業ID: c8d99e2b\n自動進行が判断待ちです: 三共精機様の資料メール着信を監視し、届いたら過去写真・費用・ロゴを反映して差分共有する。\nあなたの返事待ち: kim@orgiast.jp で開いてください: https://docs.google.com/document/d/AAA/edit?authuser=kim@orgiast.jp 。添付予定の提案書v4(PDF): https://drive.google.com/file/d/BBB/view?authuser=kim@orgiast.jp 。本文と提案書を見て「送ってよい」か修正点を返してください。\n成果物: https://docs.google.com/document/d/AAA/edit'
  });
  const brief = inboxBrief(item);
  assert.ok(brief.topic.startsWith('作業用014:'), 'topic starts with PC prefix');
  assert.ok(brief.topic.includes('Bで。ただし'), 'topic includes purpose');
  assert.match(brief.happened, /三共精機/, 'happened contains the waiting task');
  assert.match(brief.decide, /送ってよい/, 'decide captures the approval ask');
  assert.match(brief.reply, /可/, 'reply offers options');
  assert.ok(brief.links.some(l => l.includes('docs.google.com')), 'links include doc URL');
  assert.ok(brief.links.some(l => l.includes('drive.google.com')), 'links include drive URL');
});

// --- ki-20261113223019-b164 形式: auto-progress-resume-failed + ヘッダー ---
test('resume-failed info with header extracts correctly', t => {
  const item = makeItem({
    kind: 'info',
    source: 'auto-progress-resume-failed',
    text: '【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: CLAUDE.md配布 ／ セッションの目的: トーエネックにメールをおくって ／ 作業ID: 7f14e87b\n🔴 自動再開が連続失敗しています\n約束: このセッションに kim の承認が届き次第、Gmail（seisaku-team@orgiast.jp）から送信前チェックを通して送信し、送信済みを読み戻して報告します\n失敗回数: 3回（上限 8回）\n最終結果: error: failure (claude exit 1):'
  });
  const brief = inboxBrief(item);
  assert.ok(brief.topic.startsWith('作業用014:'), 'topic starts with PC prefix');
  assert.ok(brief.topic.includes('トーエネックにメールをおくって'), 'topic includes purpose');
  assert.equal(brief.happened, '自動再開が連続失敗しています');
  assert.match(brief.decide, /自動再開が止まっている/, 'decide for resume-failed');
  assert.match(brief.reply, /続けて/, 'reply offers continue options');
  assert.doesNotMatch(brief.reply, /返事不要/, 'resume-failed reply is not 返事不要');
});

// --- groupInboxItems ---
function groupableItem(id, workId, decide, createdAt) {
  return makeItem({
    id: id || 'ki-20261112000000-0000',
    kind: 'ask',
    text: `【DELL・seisaku-team@orgiast.jp の Claude Code】プロジェクト: test ／ セッションの目的: test ／ 作業ID: ${workId || 'aabbccdd'}\nあなたの返事待ち: ${decide || '確認してください'}`,
    createdAt: createdAt || '2026-11-12T00:00:00.000Z',
    lastAt: createdAt || '2026-11-12T00:00:00.000Z',
  });
}

test('groupInboxItems: same workId + same decide → one group, newest is representative', t => {
  const a = groupableItem('ki-20261112000000-aaaa', 'c8d99e2b', '送ってよいですか', '2026-11-12T10:00:00.000Z');
  const b = groupableItem('ki-20261112120000-bbbb', 'c8d99e2b', '送ってよいですか', '2026-11-12T12:00:00.000Z');
  const groups = groupInboxItems([a, b]);
  assert.equal(groups.length, 1, 'should be one group');
  assert.equal(groups[0].representative.id, b.id, 'newest should be representative');
  assert.equal(groups[0].duplicates.length, 1, 'oldest should be duplicate');
  assert.equal(groups[0].duplicates[0], a.id);
});

test('groupInboxItems: equal createdAt uses the larger id as representative', t => {
  const createdAt = '2026-11-12T12:00:00.000Z';
  const a = groupableItem('ki-20261112120000-aaaa', 'c8d99e2b', '送ってよいですか', createdAt);
  const b = groupableItem('ki-20261112120000-bbbb', 'c8d99e2b', '送ってよいですか', createdAt);
  const [forward] = groupInboxItems([a, b]);
  const [reverse] = groupInboxItems([b, a]);
  assert.equal(forward.representative.id, b.id);
  assert.equal(reverse.representative.id, b.id, 'input order must not change the representative');
  assert.deepEqual(forward.duplicates, [a.id]);
  assert.deepEqual(reverse.duplicates, [a.id]);
});

test('groupInboxItems: different workId → separate groups', t => {
  const a = groupableItem('ki-20261112000000-aaaa', 'c8d99e2b', '送ってよいですか', '2026-11-12T10:00:00.000Z');
  const b = groupableItem('ki-20261112120000-bbbb', '7f14e87b', '送ってよいですか', '2026-11-12T12:00:00.000Z');
  const groups = groupInboxItems([a, b]);
  assert.equal(groups.length, 2, 'different work IDs → 2 groups');
  assert.equal(groups[0].representative.id, a.id);
  assert.equal(groups[0].duplicates.length, 0);
  assert.equal(groups[1].representative.id, b.id);
  assert.equal(groups[1].duplicates.length, 0);
});

test('groupInboxItems: same workId but different decide → separate groups', t => {
  const a = groupableItem('ki-20261112000000-aaaa', 'c8d99e2b', '送ってよいですか', '2026-11-12T10:00:00.000Z');
  const b = groupableItem('ki-20261112120000-bbbb', 'c8d99e2b', '別の判断をして', '2026-11-12T12:00:00.000Z');
  const groups = groupInboxItems([a, b]);
  assert.equal(groups.length, 2, 'different decide → 2 groups');
});

test('groupInboxItems: no workId → each item is its own group', t => {
  const a = makeItem({ id: 'ki-20261112000000-aaaa', kind: 'ask', text: 'あなたの返事待ち: 確認してください' });
  const b = makeItem({ id: 'ki-20261112120000-bbbb', kind: 'ask', text: 'あなたの返事待ち: 確認してください' });
  const groups = groupInboxItems([a, b]);
  assert.equal(groups.length, 2, 'no work ID → 2 separate groups');
});

test('groupInboxItems: three same → one group with two duplicates', t => {
  const a = groupableItem('ki-20261112080000-aaaa', 'c8d99e2b', '送ってよいですか', '2026-11-12T08:00:00.000Z');
  const b = groupableItem('ki-20261112100000-bbbb', 'c8d99e2b', '送ってよいですか', '2026-11-12T10:00:00.000Z');
  const c = groupableItem('ki-20261112120000-cccc', 'c8d99e2b', '送ってよいですか', '2026-11-12T12:00:00.000Z');
  const groups = groupInboxItems([a, b, c]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].representative.id, c.id, 'newest (c) is rep');
  assert.equal(groups[0].duplicates.length, 2, 'two duplicates');
  assert.ok(groups[0].duplicates.includes(a.id), 'a is duplicate');
  assert.ok(groups[0].duplicates.includes(b.id), 'b is duplicate');
});
