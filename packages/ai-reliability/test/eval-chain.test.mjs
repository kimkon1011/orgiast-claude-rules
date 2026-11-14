import assert from 'node:assert/strict';
import test from 'node:test';
import { EvalChain, EvalStep, htmlValidator, cssValidator } from '../eval-chain.mjs';

test('EvalChain は全合格で passed=true を返す', async () => {
  const chain = new EvalChain({
    evaluators: [
      new EvalStep({
        name: 'pass',
        category: 'static',
        evaluate: async () => [{ id: 'test', name: 'test', score: 1.0 }],
      }),
    ],
  });
  const result = await chain.evaluate({ files: {} });
  assert.equal(result.passed, true);
  assert.equal(result.overallScore, 1.0);
});

test('EvalChain は不合格で passed=false を返す', async () => {
  const chain = new EvalChain({
    evaluators: [
      new EvalStep({
        name: 'fail',
        category: 'static',
        evaluate: async () => [{ id: 'test', name: 'test', score: 0.3, threshold: 0.7 }],
      }),
    ],
  });
  const result = await chain.evaluate({ files: {} });
  assert.equal(result.passed, false);
  assert.ok(result.failedItems.includes('test'));
});

test('EvalChain は critical な不合格でチェーンを停止する', async () => {
  let step2Ran = false;
  const chain = new EvalChain({
    evaluators: [
      new EvalStep({
        name: 'critical-fail',
        category: 'static',
        evaluate: async () => [{ id: 'cf', name: 'critical', score: 0, threshold: 0.7, critical: true }],
        critical: true,
      }),
      new EvalStep({
        name: 'skipped',
        category: 'functional',
        evaluate: async () => { step2Ran = true; return [{ id: 'skip', name: 'skipped', score: 1.0 }]; },
      }),
    ],
  });
  const result = await chain.evaluate({ files: {} });
  assert.equal(result.passed, false);
  assert.equal(result.chainBroken, true);
  assert.equal(step2Ran, false);
  // スキップされたステップも結果に含まれる
  const skippedItem = result.items.find((i) => i.id === 'skipped-skipped');
  assert.ok(skippedItem?.skipped);
});

test('EvalChain は non-critical な不合格でもチェーンを継続する', async () => {
  let step2Ran = false;
  const chain = new EvalChain({
    evaluators: [
      new EvalStep({
        name: 'soft-fail',
        category: 'static',
        evaluate: async () => [{ id: 'sf', name: 'soft', score: 0, threshold: 0.7, critical: false }],
        critical: false,
      }),
      new EvalStep({
        name: 'still-runs',
        category: 'functional',
        evaluate: async () => { step2Ran = true; return [{ id: 'run', name: 'runs', score: 1.0 }]; },
      }),
    ],
  });
  const result = await chain.evaluate({ files: {} });
  assert.equal(result.passed, false); // 不合格項目がある
  assert.equal(result.chainBroken, false);
  assert.equal(step2Ran, true);
});

test('EvalChain はレポートを生成できる', async () => {
  const chain = new EvalChain({
    evaluators: [
      new EvalStep({
        name: 'test',
        category: 'static',
        evaluate: async () => [{ id: 't1', name: 'test1', score: 1.0 }],
      }),
    ],
  });
  const result = await chain.evaluate({ files: {} });
  const report = EvalChain.formatReport(result);
  assert.ok(report.includes('合格'));
  assert.ok(report.includes('test1'));
});

test('EvalChain は評価関数のエラーをハンドリングする', async () => {
  const chain = new EvalChain({
    evaluators: [
      new EvalStep({
        name: 'throws',
        category: 'static',
        evaluate: async () => { throw new Error('eval crashed'); },
      }),
    ],
  });
  const result = await chain.evaluate({ files: {} });
  assert.equal(result.passed, false);
  assert.ok(result.items.some((i) => i.error));
});

test('htmlValidator は完全なHTMLを合格させる', async () => {
  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Test</title>
</head>
<body>
  <main><h1>Hello</h1></main>
</body>
</html>`;
  const result = await htmlValidator.evaluate({ files: { 'index.html': html } });
  const score = result.reduce((s, i) => s + i.score, 0) / result.length;
  assert.ok(score >= 0.7);
});

test('htmlValidator は不完全なHTMLを不合格にする', async () => {
  const html = `<div>no doctype</div>`;
  const result = await htmlValidator.evaluate({ files: { 'page.html': html } });
  const criticalItems = result.filter((i) => i.critical);
  for (const item of criticalItems) {
    assert.ok(item.score < item.threshold, `${item.id} should fail`);
  }
});

test('cssValidator はメディアクエリ不足を警告する', async () => {
  const css = `
    .box { color: #333; margin: 10px; padding: 20px; font-size: 16px; }
    .header { width: 100%; height: 50px; }
  `;
  const result = await cssValidator.evaluate({ files: { 'style.css': css } });
  const item = result.find((i) => i.id === 'css-style.css');
  assert.ok(item);
  assert.ok(item.score < 0.9, 'メディアクエリなしでやや低スコア');
  assert.ok(item.feedback ? item.feedback.includes('メディアクエリ') : true);
});