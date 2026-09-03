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

test('.claude 直下の kim 向け成果物は違反として検出する', () => {
  const text = '[設計書](C:/Users/x/.claude/design-ai-ops.md) [報告書](C:/Users/x/.claude/report.pdf) [任意サブフォルダ](C:/Users/x/.claude/exports/summary.txt)';
  assert.deepEqual(findLocalDocLinks(text), [
    { label: '設計書', destination: 'C:/Users/x/.claude/design-ai-ops.md' },
    { label: '報告書', destination: 'C:/Users/x/.claude/report.pdf' },
    { label: '任意サブフォルダ', destination: 'C:/Users/x/.claude/exports/summary.txt' },
  ]);
});

test('Claude Code の内部ディレクトリと内部ファイルだけを除外する', () => {
  const internalLinks = [
    '[memory](C:/Users/x/.claude/memory/feedback.md)',
    '[projects](C:/Users/x/.claude/projects/session/transcript.md)',
    '[shell-snapshots](C:/Users/x/.claude/shell-snapshots/snapshot.txt)',
    '[todos](C:/Users/x/.claude/todos/current.md)',
    '[skills](C:/Users/x/.claude/skills/example/SKILL.md)',
    '[agents](C:/Users/x/.claude/agents/reviewer.md)',
    '[commands](C:/Users/x/.claude/commands/session-start.md)',
    '[plugins](C:/Users/x/.claude/plugins/example/README.md)',
    '[CLAUDE](C:/Users/x/project/CLAUDE.md)',
    '[next-session](C:/Users/x/.claude/NeXt-SeSsIoN.Md?view=1#section)',
  ].join(' ');
  assert.deepEqual(findLocalDocLinks(internalLinks), []);
});

test('内部名の部分文字列にすぎないディレクトリとファイルは除外しない', () => {
  const text = '[独自](C:/Users/x/.claude/memory-custom/report.md) [類似名](C:/Users/x/.claude/CLAUDE-notes.md)';
  assert.deepEqual(findLocalDocLinks(text), [
    { label: '独自', destination: 'C:/Users/x/.claude/memory-custom/report.md' },
    { label: '類似名', destination: 'C:/Users/x/.claude/CLAUDE-notes.md' },
  ]);
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
