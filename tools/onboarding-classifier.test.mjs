import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { INDEX_BUDGET_BYTES, INDEX_PROTECTED, makeIndex } from './onboarding-sync.mjs';

test('配布する実文書の索引が8000bytes以下で結論と新規約を含む', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const index = makeIndex(body);
  assert(Buffer.byteLength(index) <= INDEX_BUDGET_BYTES, `${Buffer.byteLength(index)} bytes`);
  for (const line of body.split(/\r?\n/).filter(l => /^\*{0,2}\s*(?:🔴|🛑|⚙️|🔁)/u.test(l))) assert([...line].length <= 200, line);
  for (const pattern of INDEX_PROTECTED) assert.match(index, pattern);
  assert.match(index, /1\.20 auto mode classifier/);
  assert.doesNotMatch(index, /丸1日|1-00:57|コマンド置換として実行/);
  const appendix = body.split('## 付録: 事故履歴と根拠')[1];
  assert(appendix);
  assert.doesNotMatch(appendix, /^### /m);
  assert.match(appendix, /1-00:57/);
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
  assert(Buffer.byteLength(index) <= INDEX_BUDGET_BYTES);
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
  assert(Buffer.byteLength(restored.join('\n')) > INDEX_BUDGET_BYTES);
});

test('必須4パターンの長い結論は予算超過時も全文を残す', () => {
  const protectedLines = [
    '副作用・影響は報告で終わらせず、その場で直す',
    'effortLevel は medium',
    'planIncluded は監督も全用途禁止',
    'setup --converge で allow',
  ].map(line => line + '、' + 'あ'.repeat(300) + '。');
  assert.equal(INDEX_PROTECTED.length, 4);
  protectedLines.forEach((line, i) => assert.match(line, INDEX_PROTECTED[i]));
  const source = [
    ...protectedLines.flatMap((line, i) => [`### protected ${i}`, line]),
    ...Array.from({ length: 20 }, (_, i) => [`### ordinary ${i}`, '😀'.repeat(100) + '。']).flat(),
  ].join('\n');
  const index = makeIndex(source);
  assert(Buffer.byteLength(index) <= INDEX_BUDGET_BYTES);
  for (const line of protectedLines) assert(index.split('\n').includes(line));
});

test('予算内の索引は結論を1バイトも変更しない', () => {
  const source = '### unchanged\n' + '😀'.repeat(100) + '、結論を残す。';
  assert.equal(makeIndex(source), makeIndex('') + '\n' + source);
});

test('実文書の予算内の結論には省略記号を付けない', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const index = makeIndex(body);
  assert(Buffer.byteLength(index) <= INDEX_BUDGET_BYTES);
  for (const line of index.split('\n').filter(line => line.endsWith('…'))) {
    assert(body.includes(line), line);
  }
});

test('実文書に典型的な規約(見出し+40文字の結論)を3件足しても予算と既存規約を守る', () => {
  const body = fs.readFileSync(new URL('../ONBOARDING.md', import.meta.url), 'utf8');
  const extra = Array.from({ length: 3 }, () => '### 9.99 ダミー\n' + 'あ'.repeat(39) + '。').join('\n');
  const index = makeIndex(body + '\n' + extra);
  assert(Buffer.byteLength(index) <= INDEX_BUDGET_BYTES, `${Buffer.byteLength(index)} bytes`);
  assert.equal(index.split('\n').filter(line => line === '### 9.99 ダミー').length, 3);
  assertIndexRules(index);
});

test('全候補を短縮しても収まらない場合は結論を短縮せず予算超過を残す', () => {
  const conclusion = 'あ'.repeat(200) + '。';
  const heading = '### ' + '見出し'.repeat(1000);
  const index = makeIndex(heading + '\n' + conclusion);
  assert(Buffer.byteLength(index) > INDEX_BUDGET_BYTES);
  assert(index.endsWith('\n' + heading + '\n' + conclusion));
});
