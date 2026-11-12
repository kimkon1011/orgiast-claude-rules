import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluate, getAllCriteriaItems, analyzeColors, analyzeAccessibility, DEFAULT_PASS_THRESHOLD } from '../uivisual-eval.mjs';
import { runImprovementLoop, formatReport } from '../build-agent.mjs';

test('評価基準は11項目（V5+O3+U3）である', () => {
  const items = getAllCriteriaItems();
  assert.equal(items.length, 11);
  const ids = items.map((i) => i.id);
  assert.ok(ids.includes('V1'));
  assert.ok(ids.includes('O3'));
  assert.ok(ids.includes('U2'));
});

test('全項目が最高点で合格する', () => {
  const scores = { V1: 5, V2: 5, V3: 5, V4: 5, V5: 5, O1: 5, O2: 5, O3: 5, U1: 5, U2: 5, U3: 5 };
  const result = evaluate(scores);
  assert.equal(result.verdict, 'pass');
  assert.equal(result.totalScore, 5);
  assert.deepEqual(result.revisionItems, []);
});

test('全項目が最低点で改訂要求になる', () => {
  const scores = { V1: 1, V2: 1, V3: 1, V4: 1, V5: 1, O1: 1, O2: 1, O3: 1, U1: 1, U2: 1, U3: 1 };
  const result = evaluate(scores);
  assert.equal(result.verdict, 'revision');
  assert.equal(result.totalScore, 1);
  assert.equal(result.revisionItems.length, 11);
});

test('一部の項目が低得点でも全体が閾値以上なら合格する', () => {
  // 全項目3.5以上なら合格
  const scores = { V1: 4, V2: 4, V3: 4, V4: 4, V5: 4, O1: 3.5, O2: 4, O3: 4, U1: 4, U2: 4, U3: 4 };
  const result = evaluate(scores);
  assert.equal(result.verdict, 'pass');
});

test('1項目でも閾値未満なら改訂要求になる', () => {
  const scores = { V1: 5, V2: 5, V3: 5, V4: 5, V5: 5, O1: 5, O2: 5, O3: 5, U1: 5, U2: 1, U3: 5 };
  const result = evaluate(scores);
  assert.equal(result.verdict, 'revision');
  assert.ok(result.revisionItems.includes('U2'));
});

test('未評価項目は中間点（3）として扱われる', () => {
  const scores = { V1: 5, V2: 5, V3: 5 };
  const result = evaluate(scores);
  assert.equal(result.scores.V1, 5);
  assert.equal(result.scores.U1, 3);
  assert.equal(result.scores.O1, 3);
});

test('閾値をカスタム設定できる', () => {
  const scores = { V1: 4, V2: 4, V3: 4, V4: 4, V5: 4, O1: 4, O2: 4, O3: 4, U1: 4, U2: 4, U3: 4 };
  const result = evaluate(scores, { passThreshold: 4.5 });
  assert.equal(result.verdict, 'revision');
});

test('カラートークン数が閾値を超えると警告が出る', () => {
  const css = '.a{color:#ff0000}.b{color:#00ff00}.c{color:#0000ff}.d{color:#ffff00}.e{color:#ff00ff}.f{color:#00ffff}.g{color:#123456}.h{color:#654321}.i{color:#abcdef}.j{color:#fedcba}.k{color:#aabbcc}';
  const analysis = analyzeColors(css);
  assert.ok(analysis.colors.length > 10);
  assert.ok(analysis.warnings.length > 0);
});

test('alt属性のない画像を検出する', () => {
  const html = '<img src="a.jpg"><img src="b.jpg" alt="説明"><img src="c.jpg">';
  const analysis = analyzeAccessibility(html);
  assert.equal(analysis.imgAlts, 2);
  assert.ok(analysis.issues.length > 0);
});

test('改善ループは1回で合格する', async () => {
  let callCount = 0;
  const buildFn = async () => ['コントラスト比を改善しました'];
  const scoreFn = async () => {
    callCount += 1;
    return { V1: 5, V2: 5, V3: 5, V4: 5, V5: 5, O1: 5, O2: 5, O3: 5, U1: 5, U2: 5, U3: 5 };
  };
  const result = await runImprovementLoop(buildFn, scoreFn, { maxIterations: 3 });
  assert.equal(result.passed, true);
  assert.equal(callCount, 1);
  assert.equal(result.records.length, 1);
});

test('改善ループは不合格のまま最大試行回数に達する', async () => {
  let callCount = 0;
  const buildFn = async (feedback) => {
    assert.ok(feedback.length > 0);
    return ['修正を試みました'];
  };
  const scoreFn = async () => {
    callCount += 1;
    return { V1: 2, V2: 2, V3: 2, V4: 2, V5: 2, O1: 2, O2: 2, O3: 2, U1: 2, U2: 2, U3: 2 };
  };
  const result = await runImprovementLoop(buildFn, scoreFn, { maxIterations: 3 });
  assert.equal(result.passed, false);
  assert.equal(callCount, 4); // 3回 + 最終再評価
  assert.equal(result.records.length, 3);
  assert.equal(result.finalVerdict, 'revision');
});

test('レポートが正しいフォーマットで生成される', () => {
  const records = [
    { iteration: 1, scores: { V1: 3 }, totalScore: 3, verdict: 'revision', appliedFixes: ['色を修正'] },
    { iteration: 2, scores: { V1: 5 }, totalScore: 5, verdict: 'pass', appliedFixes: [] },
  ];
  const report = formatReport(records);
  assert.ok(report.includes('試行 1'));
  assert.ok(report.includes('試行 2'));
  assert.ok(report.includes('✅ 合格'));
  assert.ok(report.includes('🔄 改訂要求'));
  assert.ok(report.includes('色を修正'));
});
