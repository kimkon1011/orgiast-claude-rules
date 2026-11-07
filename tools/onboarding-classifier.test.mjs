import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INDEX_BUDGET_BYTES, INDEX_PROTECTED, isMandatoryIndexLine, measureIndexBytes, makeIndex } from './onboarding-sync.mjs';

test('配布する実文書の必須ルール全文を除いた索引部分が8000bytes以下で結論と新規約を含む', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const index = makeIndex(body);
  assertOptionalBudget(index);
  // Full mandatory text replaces the old per-line 200-character restriction.
  for (const line of body.split(/\r?\n/).filter(l => /^\*{0,2}\s*(?:🔴|🛑|⚙️|🔁)/u.test(l))) {
    const distributed = line.includes('判断軸はオージャストの長期的利益の最大化') ? line
      : line.replace(/（(?:kim\s+)?\d{4}-\d{2}-\d{2}[^）]*）(?=。?\*\*$)/u, '');
    assert(index.split('\n').includes(distributed), distributed);
  }
  assert.match(index, /「〜なくなる／影響がある／残っている／注意」は当ターンで直して完了報告。/);
  const judgmentAxis = body.split(/\r?\n/).find(line => line.includes('判断軸はオージャストの長期的利益の最大化'));
  assert.ok(judgmentAxis);
  assert.ok(index.split('\n').includes(judgmentAxis), '判断軸の🔴行が圧縮版に全文一致で含まれる');
  for (const pattern of INDEX_PROTECTED) assert.match(index, pattern);
  assert.match(index, /1\.20 auto mode classifier/);
  assert.doesNotMatch(index, /丸1日|1-00:57|コマンド置換として実行/);
  const appendix = body.split('## 付録: 事故履歴と根拠')[1];
  assert(appendix);
  assert.doesNotMatch(appendix, /^### /m);
  assert.match(appendix, /1-00:57/);
});

function assertOptionalBudget(index) {
  const { optionalBytes } = measureIndexBytes(index);
  assert(optionalBytes <= INDEX_BUDGET_BYTES, `非必須索引 ${optionalBytes} bytes`);
}

test('必須ルール全体は18000bytes以下で、超過時は統合・圧縮を要求する', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  // Current full mandatory text is already >12 KB; allow limited headroom,
  // without weakening full-text distribution to satisfy a size target.
  const assertMandatoryBudget = index => {
    const { mandatoryBytes } = measureIndexBytes(index);
    assert(mandatoryBytes <= 18000, `必須ルールの統合・圧縮が必要: ${mandatoryBytes} bytes > 18000 bytes`);
  };
  assertMandatoryBudget(makeIndex(body));
  const base = makeIndex('');
  const exact = base + '\n🔴 ' + 'a'.repeat(18000 - Buffer.byteLength('\n🔴 '));
  assertMandatoryBudget(exact);
  assert.throws(() => assertMandatoryBudget(exact + 'a'), /必須ルールの統合・圧縮が必要: 18001 bytes/);
});

test('索引のUTF-8予算は必須全文と非必須案内を重複なく計上する', () => {
  const optional = '### 見出し\n通常の結論。';
  const mandatory = '**🔴 絶対ルール。全文保持。**\neffortLevel は medium。後半も保持。';
  assert.deepEqual(measureIndexBytes(optional + '\n' + mandatory), {
    optionalBytes: Buffer.byteLength(optional),
    mandatoryBytes: Buffer.byteLength('\n' + mandatory),
    totalBytes: Buffer.byteLength(optional + '\n' + mandatory),
  });
  assert.deepEqual(measureIndexBytes(''), { optionalBytes: 0, mandatoryBytes: 0, totalBytes: 0 });
});

test('索引は日付付き由来だけを圧縮し、規約と通常の括弧は保持する', () => {
  const source = '### 副作用は直す（kim 2026-10-17 厳命・全PC全アカウント・絶対）\nこのターンで修正する（kim 2026-10-17 改定）。\n### 設定（既存PCも対象）\n照会する。';
  const index = makeIndex(source);
  assert.match(index, /### 副作用は直す\nこのターンで修正する。/);
  assert.match(index, /### 設定（既存PCも対象）/);
  assert.doesNotMatch(index, /2026-10-17/);
});

function assertIndexRules(index) {
  for (const pattern of INDEX_PROTECTED) assert.match(index, pattern);
  assert.match(index, /1\.20 auto mode classifier/);
  assert.doesNotMatch(index, /丸1日|1-00:57|コマンド置換として実行/);
}

test('両種のフェンス内を結論探索と直前行の判定からも除外する', () => {
  for (const fence of ['```', '~~~']) {
    const hidden = ['# foo', '### bar', '**🔴 baz**', '**1.23 hidden**'];
    const block = [fence + 'text', ...hidden, fence].join('\n');
    const index = makeIndex(['### visible', block, '結論です。', '**🔴 outside**', block, '**1.24 visible**'].join('\n'));
    for (const line of hidden) assert(!index.includes(line), line);
    assert.match(index, /### visible\n結論です。/);
    assert.match(index, /\*\*1\.24 visible\*\*/);
    const outside = makeIndex(hidden.join('\n'));
    for (const line of hidden) assert(outside.includes(line), line);
    assert.doesNotMatch(makeIndex(block + '\n**1.25 hidden**'), /1\.25/);
  }
});

test('長い結論から1件ずつ読点または20文字まで短縮し予算内で止める', () => {
  const sections = Array.from({ length: 30 }, (_, i) => ({
    heading: `### section ${i}`,
    conclusion: i % 2 ? '😀'.repeat(25) + '、' + 'あ'.repeat(200 - i) + '。' : '😀あ'.repeat(120 - i) + '。',
    rule: `**🔴 rule ${i}**`,
  }));
  const source = sections.flatMap(s => [s.heading, s.conclusion, s.rule]).join('\n');
  const index = makeIndex(source);
  assertOptionalBudget(index);
  const lines = index.split('\n');
  let lastShortened;
  let unchanged = false;
  let count = 0;
  for (const s of [...sections].sort((a, b) => [...b.conclusion].length - [...a.conclusion].length)) {
    assert(lines.includes(s.rule));
    const actual = lines[lines.indexOf(s.heading) + 1];
    if (actual === s.conclusion) {
      unchanged = true;
    } else {
      assert(!unchanged, '短い結論より先に長い結論を縮める');
      const chars = [...s.conclusion];
      const comma = chars.indexOf('、');
      assert.equal(actual, chars.slice(0, comma >= 0 ? comma : 20).join('') + '…');
      lastShortened = s;
      count++;
    }
  }
  assert(count > 0 && count < sections.length);
  const restored = [...lines];
  restored[lines.indexOf(lastShortened.heading) + 1] = lastShortened.conclusion;
  assert(measureIndexBytes(restored.join('\n')).optionalBytes > INDEX_BUDGET_BYTES);
});

test('必須4パターンの長い結論は予算超過時も全文を残す', () => {
  const protectedLines = [
    '副作用・影響は報告で終わらせず、その場で直す',
    'effortLevel は medium',
    'planIncluded は監督も全用途禁止',
    'setup --converge で allow',
  ].map(line => line + '、' + 'あ'.repeat(300) + '。後半も必須なので全文保持する。');
  assert.equal(INDEX_PROTECTED.length, 4);
  protectedLines.forEach((line, i) => assert.match(line, INDEX_PROTECTED[i]));
  const source = [
    ...protectedLines.flatMap((line, i) => [`### protected ${i}`, line]),
    ...Array.from({ length: 20 }, (_, i) => [`### ordinary ${i}`, '😀'.repeat(100) + '。']).flat(),
  ].join('\n');
  const index = makeIndex(source);
  assertOptionalBudget(index);
  for (const line of protectedLines) assert(index.split('\n').includes(line));
});

test('予算内の索引は結論を1バイトも変更しない', () => {
  const source = '### unchanged\n' + '😀'.repeat(100) + '、結論を残す。';
  assert.equal(makeIndex(source), makeIndex('') + '\n' + source);
});

test('非必須部分の予算超過時は非必須の結論だけ省略記号で短縮し必須ルール全文を保持する', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const conclusion = '追加の非必須案内' + 'あ'.repeat(300) + '。';
  const extra = Array.from({ length: 20 }, (_, i) => `### 9.99.${i} 追加案内\n${conclusion}`).join('\n');
  const source = body + '\n' + extra;
  assert(Buffer.byteLength(extra) > INDEX_BUDGET_BYTES, '非必須部分だけで予算を超えるfixture');
  const index = makeIndex(source);
  assertOptionalBudget(index);
  const shortened = index.split('\n').filter(line => line.endsWith('…'));
  assert(shortened.length > 0, '短縮処理が実際に発生する');
  for (const line of shortened) {
    assert(!isMandatoryIndexLine(line), '必須ルールは短縮しない');
    const prefix = line.slice(0, -1);
    assert(source.includes(prefix), `${line} (prefix: ${JSON.stringify(prefix)})`);
  }
  assert.deepEqual(index.split('\n').filter(isMandatoryIndexLine), makeIndex(body).split('\n').filter(isMandatoryIndexLine));
});

test('実文書に典型的な規約(見出し+40文字の結論)を3件足しても非必須部分の予算と既存規約を守る', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const extra = Array.from({ length: 3 }, () => '### 9.99 ダミー\n' + 'あ'.repeat(39) + '。').join('\n');
  const index = makeIndex(body + '\n' + extra);
  assertOptionalBudget(index);
  assert.equal(index.split('\n').filter(line => line === '### 9.99 ダミー').length, 3);
  assertIndexRules(index);
  assert.deepEqual(index.split('\n').filter(isMandatoryIndexLine), makeIndex(body).split('\n').filter(isMandatoryIndexLine));
});

test('全候補を短縮しても収まらない場合は結論を短縮せず予算超過を残す', () => {
  const conclusion = 'あ'.repeat(200) + '。';
  const heading = '### ' + '見出し'.repeat(1000);
  const index = makeIndex(heading + '\n' + conclusion);
  assert(Buffer.byteLength(index) > INDEX_BUDGET_BYTES);
  assert(index.endsWith('\n' + heading + '\n' + conclusion));
});
