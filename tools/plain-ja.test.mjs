import test from 'node:test';
import assert from 'node:assert/strict';
import { findJargon, stripJargon, toPlainJa } from './lib/plain-ja.mjs';

// 2026-10-13 に実際に kim へ届いた、意味が分からなかった通知の実例。
const REAL_EXAMPLES = [
  '▶ 次はこれをやります: feedback-zero-sweep の FEEDBACK_KIM_DISCO',
  'まだ確かめられていないこと: 今夜の nightly-batch で feedback-zero-sweep が exit 1 にならず…',
  '確かめたこと: gh pr view 747 の read-back: state=MERGED mergedAt=2026-10-12T23:43:15Z mergeCommit=ea939c1f。CI: Auto merge/CI test/test/test-posix すべて SUCCESS',
];

test('実例3つは内部用語として検出される', () => {
  for (const example of REAL_EXAMPLES) assert.ok(findJargon(example).length > 0, example);
  assert.ok(findJargon(REAL_EXAMPLES[0]).includes('feedback-zero-sweep'));
  assert.ok(findJargon(REAL_EXAMPLES[0]).includes('FEEDBACK_KIM_DISCO'));
  assert.ok(findJargon(REAL_EXAMPLES[1]).includes('nightly-batch'));
  assert.ok(findJargon(REAL_EXAMPLES[1]).includes('exit 1'));
  assert.ok(findJargon(REAL_EXAMPLES[2]).includes('CI'));
  assert.ok(findJargon(REAL_EXAMPLES[2]).includes('SUCCESS'));
});

test('平易な日本語の文は検出ゼロ', () => {
  assert.deepEqual(findJargon('社員からの不具合報告を毎日まとめて届ける仕組みを直しました'), []);
});

test('高校生でも分かる略語（AI等）は内部用語にしない', () => {
  assert.deepEqual(findJargon('今週の新AI候補 0 件\n新規なし（監視 1 モデル）'), []);
  assert.deepEqual(findJargon('URL と PDF を送りました'), []);
});

test('末尾のホスト名（全角括弧）は検出しない', () => {
  assert.deepEqual(findJargon('✅ 終わりました: 社員からの不具合報告をまとめる仕組みを直しました（DESKTOP-ABC123）'), []);
});

test('識別子は丸ごと1件で返し、断片を重複計上しない', () => {
  const found = findJargon('feedback-zero-sweep を直しました');
  assert.deepEqual(found, ['feedback-zero-sweep']);
});

test('toPlainJa: 内部用語が無ければ ask を呼ばずそのまま返す', async () => {
  let called = 0;
  const text = '社員からの不具合報告を毎日まとめて届ける仕組みを直しました';
  const result = await toPlainJa(text, { ask: async () => { called++; return 'x'; } });
  assert.equal(result, text);
  assert.equal(called, 0);
});

test('toPlainJa: ask の書き換え結果を使う', async () => {
  const result = await toPlainJa('▶ 次はこれをやります: feedback-zero-sweep', { ask: async () => '次は、社員からの報告をまとめる作業をします。' });
  assert.equal(result, '▶ 次は、社員からの報告をまとめる作業をします。');
});

test('toPlainJa: ask が内部用語を残したら検出語を除去した文にフォールバックする', async () => {
  const result = await toPlainJa('確かめたこと: gh pr view 747 の read-back: state=MERGED', { ask: async () => 'gh pr view 747 は MERGED でした' });
  assert.equal(findJargon(result).length, 0);
  assert.match(result, /確かめたこと/);
});

test('toPlainJa: ask が失敗しても例外を投げず、検出語を除去した文を返す', async () => {
  const result = await toPlainJa('まだ確かめられていないこと: nightly-batch が exit 1 にならず…', { ask: async () => { throw new Error('全候補が失敗'); } });
  assert.equal(findJargon(result).length, 0);
  assert.match(result, /まだ確かめられていないこと/);
});

test('toPlainJa: ask が空文字を返しても検出語を除去した文を返す', async () => {
  const result = await toPlainJa('CI が SUCCESS でした', { ask: async () => '' });
  assert.equal(findJargon(result).length, 0);
});

test('toPlainJa: 検出語を全部除いて空になったら「内部の作業」を返す', async () => {
  const result = await toPlainJa('feedback-zero-sweep', { ask: async () => { throw new Error('x'); } });
  assert.equal(result, '内部の作業');
});

const REPLY_NOTICE = '▶ 次はこれをやります: feedback-zero-sweep\nやめてほしいときは「止めて」と返信してください。（DESKTOP-ABC123）';

test('toPlainJa: 定型の返信語（鉤括弧内）と末尾ホスト名は書き換え後も残る', async () => {
  const result = await toPlainJa(REPLY_NOTICE, { ask: async () => '次は、社員からの報告をまとめる作業をします。\n〔そのまま0〕' });
  assert.match(result, /「止めて」と返信してください/);
  assert.match(result, /（DESKTOP-ABC123）$/);
  assert.equal(findJargon(result).length, 0);
});

test('toPlainJa: ask が返信案内ごと落としても定型返信語とホスト名を補う', async () => {
  const result = await toPlainJa(REPLY_NOTICE, { ask: async () => '次は、社員からの報告をまとめる作業をします。' });
  assert.match(result, /「止めて」と返信してください/);
  assert.match(result, /（DESKTOP-ABC123）$/);
  assert.equal(findJargon(result).length, 0);
});

test('toPlainJa: 定型返信語を含む行は ask にそのまま渡さない', async () => {
  let seen = '';
  await toPlainJa(REPLY_NOTICE, { ask: async (prompt) => { seen = prompt; return '次は、報告をまとめる作業をします。\n〔そのまま0〕'; } });
  assert.doesNotMatch(seen, /「止めて」/);
  assert.doesNotMatch(seen, /DESKTOP-ABC123/);
});

test('stripJargon: 一般語（AI等）は残し、内部用語だけを除く', () => {
  const result = stripJargon('新AI候補と feedback-zero-sweep（DESKTOP-ABC123）');
  assert.match(result, /新AI候補/);
  assert.doesNotMatch(result, /feedback-zero-sweep/);
  assert.match(result, /（DESKTOP-ABC123）$/);
});

test('stripJargon: ホスト名は残し、内部用語だけを除く', () => {
  const result = stripJargon('✅ 終わりました: feedback-zero-sweep を直しました（DESKTOP-ABC123）');
  assert.equal(findJargon(result).length, 0);
  assert.match(result, /（DESKTOP-ABC123）$/);
});

// ---- 行単位処理・保護範囲 ----
function mockAsk(seen = {}) {
  return async (prompt) => {
    seen.prompt = prompt;
    return prompt.split('\n').filter((l) => /^\[\d+\] /.test(l)).map((l) => `${l.match(/^\[\d+\]/)[0]} 平易に言い換えた行`).join('\n');
  };
}

test('toPlainJa: 25行の一覧は行数が変わらず、用語の無い行は完全一致', async () => {
  const lines = ['⏳ ずっと止まっている仕事: 25件'];
  for (let i = 1; i <= 24; i++) {
    if (i === 3) lines.push('  • 週報の集計が止まっています（PR#1 待ち）');
    else if (i === 10) lines.push('  - feedback-zero-sweep が3日動いていません');
    else if (i === 17) lines.push('  • 見積の確認待ち  ');
    else lines.push(`  • ${i}番目の仕事は担当者の返事待ちです`);
  }
  const input = lines.join('\n');
  const seen = {};
  const out = await toPlainJa(input, { ask: mockAsk(seen) });
  const outLines = out.split('\n');
  assert.equal(outLines.length, lines.length);
  lines.forEach((line, i) => {
    if (i === 3 || i === 10) {
      assert.equal(findJargon(outLines[i]).length, 0);
      assert.ok(outLines[i].startsWith(line.slice(0, 4)));
    } else assert.equal(outLines[i], line);
  });
  assert.equal((seen.prompt.match(/^\[\d+\] /gm) || []).length, 2);
});

test('toPlainJa: 返答の番号が欠けた行だけ除去フォールバック', async () => {
  const input = '⚠️ A: feedback-zero-sweep が止まった\n平易な行\n⚠️ B: nightly-batch も止まった';
  const out = await toPlainJa(input, { ask: async () => '[2] Bの言い換え' });
  const l = out.split('\n');
  assert.equal(l.length, 3);
  assert.equal(findJargon(out).length, 0);
  assert.match(l[0], /^⚠️ A:/);
  assert.equal(l[1], '平易な行');
  assert.match(l[2], /^⚠️ Bの言い換え/);
});

test('toPlainJa: URL・コードブロック・インラインコード・メンション・リンクを保持', async () => {
  const input = [
    '復旧手順: nightly-batch が止まりました',
    'https://web.plaud.ai を開いてください',
    '```',
    'fetch("https://x/feedback-zero-sweep", {method: "POST"})',
    '```',
    '`gh pr view 1` を実行 <@715210673642012733> <#123>',
    '[名前](https://x) を見て',
  ].join('\n');
  const out = await toPlainJa(input, { ask: async () => '[1] 夜の処理が止まりました' });
  for (const keep of ['https://web.plaud.ai', 'fetch("https://x/feedback-zero-sweep", {method: "POST"})', '`gh pr view 1`', '<@715210673642012733>', '<#123>', '[名前](https://x)']) assert.ok(out.includes(keep), keep);
  assert.equal(out.split('\n').length, input.split('\n').length);
  assert.equal(out.split('\n')[0], '夜の処理が止まりました');
});

test('findJargon: 保護範囲の中は検出しない', () => {
  assert.deepEqual(findJargon('https://a.b/c-d_e `gh pr view 1` [x-y](https://z) <@1>'), []);
});

test('command パターンは ASCII トークンの連続だけを食う', () => {
  assert.deepEqual(findJargon('gh pr view 747 の結果を見て'), ['gh pr view 747']);
});
