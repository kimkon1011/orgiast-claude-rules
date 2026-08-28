import test from 'node:test';
import assert from 'node:assert/strict';
import { findLocalDocLinks, formatViolationMessage } from './doc-link-drive-guard.mjs';

test('文書種別の相対パスと絶対パスを違反として検出する', () => {
  const hits = findLocalDocLinks('[手順書](docs/foo.md) [資料](C:/Users/x/Downloads/plan.pdf) [表](out/report.xlsx)');
  assert.deepEqual(hits, [
    { label: '手順書', destination: 'docs/foo.md' },
    { label: '資料', destination: 'C:/Users/x/Downloads/plan.pdf' },
    { label: '表', destination: 'out/report.xlsx' },
  ]);
});

test('コード、行アンカー、内部メモリ、Web URL は除外する', () => {
  const text = '[コード](tools/foo.mjs) [該当箇所](docs/foo.md#L42) [メモリ](C:/Users/x/.claude/projects/p/memory/feedback_x.md) [手順書](https://docs.google.com/a/orgiast.jp/document/d/ID/edit)';
  assert.deepEqual(findLocalDocLinks(text), []);
});

test('LOCAL-PATH-OK が本文にあればすべて除外する', () => {
  assert.deepEqual(findLocalDocLinks('[LOCAL-PATH-OK]\n[手順書](docs/foo.md)'), []);
});

test('違反0件ならメッセージは空文字', () => {
  assert.equal(formatViolationMessage([]), '');
});

test('メッセージに表示する違反は最大3件', () => {
  const hits = findLocalDocLinks('[一](1.md) [二](2.pdf) [三](3.txt) [四](4.csv)');
  const message = formatViolationMessage(hits);
  assert.match(message, /一 → 1\.md/);
  assert.match(message, /三 → 3\.txt/);
  assert.doesNotMatch(message, /四 → 4\.csv/);
});
