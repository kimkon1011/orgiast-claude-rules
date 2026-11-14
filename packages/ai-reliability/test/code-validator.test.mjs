import assert from 'node:assert/strict';
import test from 'node:test';
import { staticAnalyze, validateSyntax, accessibilityScore } from '../code-validator.mjs';

test('staticAnalyze は完全なHTMLを合格させる', () => {
  const result = staticAnalyze({
    'index.html': `<!DOCTYPE html>
<html lang="ja">
<head><meta charset="UTF-8"><title>Test</title></head>
<body><main><h1>Hello</h1><nav>menu</nav></main></body>
</html>`,
  });
  assert.equal(result.passed, true);
  assert.equal(result.errors.length, 0);
});

test('staticAnalyze は見出しレベルスキップをエラーにする', () => {
  const result = staticAnalyze({
    'page.html': '<h1>A</h1>\n<h3>C</h3>',
  });
  assert.ok(result.errors.length > 0);
  assert.ok(result.errors.some((e) => e.rule === 'heading-skip'));
});

test('staticAnalyze は console.log を警告する', () => {
  const result = staticAnalyze({
    'app.js': 'console.log("debug"); const x = 1;',
  });
  assert.ok(result.warnings.some((w) => w.rule === 'no-console'));
});

test('staticAnalyze は TODO を info として報告する', () => {
  const result = staticAnalyze({
    'app.js': '// TODO: implement this\nfunction f() { return 1; }',
  });
  assert.ok(result.info.some((i) => i.rule === 'no-todo'));
});

test('staticAnalyze は var を警告する', () => {
  const result = staticAnalyze({
    'app.js': 'var x = 1; var y = 2;',
  });
  assert.ok(result.warnings.some((w) => w.rule === 'no-var'));
});

test('staticAnalyze は混合型CSSファイルを処理する', () => {
  const result = staticAnalyze({
    'style.css': `.a { color: #ff0000; }
.b { color: rgba(0, 255, 0, 0.5); }
.c { color: hsl(120, 100%, 50%); }`,
  });
  assert.equal(result.totalIssues, 1); // 色指定方式の混在
  assert.ok(result.issues[0]?.message.includes('色指定方式'));
});

test('validateSyntax は有効なJSを検証する', () => {
  assert.equal(validateSyntax('const x = 1;').valid, true);
});

test('validateSyntax は無効なJSを検出する', () => {
  const result = validateSyntax('const x = ;');
  assert.equal(result.valid, false);
  assert.ok(result.error);
});

test('accessibilityScore は img alt 不足を検出する', () => {
  const html = '<img src="a.jpg"><img src="b.jpg" alt="desc">';
  const result = accessibilityScore(html);
  assert.ok(result.score < 1.0);
  assert.ok(result.issues.length > 0);
});

test('accessibilityScore は完全なHTMLで満点を返す', () => {
  const html = '<img src="a.jpg" alt="A"><img src="b.jpg" alt="B"><label>Name<input></label>';
  const result = accessibilityScore(html);
  assert.equal(result.score, 1.0);
  assert.equal(result.issues.length, 0);
});