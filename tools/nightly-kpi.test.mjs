import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_OP_PATTERNS, appendImprovementTodos, calculateKpi, isInNightlyWindow,
  normalizeTodo, parseBatchLog, parseRun, parseTodos,
} from './nightly-kpi.mjs';

const date = '2026-09-02';
const baseBatch = parseBatchLog('2026-09-02 03:00:00 / nightly-batch / ok:開始\n2026-09-02 03:10:00 / サマリ / nightly-batch 完了: ok');

function run(overrides = {}) {
  return {
    todo: 'テーマA', summary: '', startedAt: '2026-09-01T19:00:00+09:00', endedAt: '2026-09-01T19:10:00+09:00',
    status: 'success', launchFailed: false,
    stdout: JSON.stringify({ total_cost_usd: 1, modelUsage: { 'claude-sonnet-5': { inputTokens: 100000, outputTokens: 10000, cacheCreationInputTokens: 20000, cacheReadInputTokens: 30000 } }, result: '' }),
    ...overrides,
  };
}

test('ログファイル不在は batchRan=false で、0/0を正常扱いしない', () => {
  assert.deepEqual(parseBatchLog(null), { batchRan: false, batchCompleted: false, batchStepsOk: 0, batchStepsTotal: 0, failedSteps: [], lastStep: null });
});

test('ログがあってもサマリ行がなければ未完了、errorステップを列挙する', () => {
  const result = parseBatchLog('2026-09-02 03:00:00 / start / ok:開始\n2026-09-02 03:01:00 / digest / error:終了コード1');
  assert.equal(result.batchRan, true);
  assert.equal(result.batchCompleted, false);
  assert.deepEqual(result.failedSteps, ['digest']);
  assert.equal(result.lastStep, 'digest');
});

test('全残TODOブロックを読み、装飾違いの重複を1件に畳む', () => {
  const parsed = parseTodos('## 残TODO（最新）\n1. **同じ TODO**\n## 別\nx\n## 残TODO\n9. ~~同じ TODO~~ → ✅ 2026-09-02 完了');
  assert.equal(parsed.todos.length, 1);
  assert.equal(parsed.duplicateTodoLines, 1);
  assert.equal(parsed.todos[0].completed, true);
});

test('完了日付きと未完了の混在から消化量と残件を算出する', () => {
  const todoParse = parseTodos('## 残TODO\n1. A → ✅ 2026-09-02 完了\n2. B\n3. C → ✅ 2026-09-01 完了');
  const kpi = calculateKpi({ date, todoParse, runs: [], batch: baseBatch });
  assert.equal(kpi.closedOvernight, 2);
  assert.equal(kpi.backlogAtEnd, 1);
  assert.equal(kpi.backlogAtStart, 3);
  assert.equal(kpi.closeRate, 2 / 3);
});

test('日付なしの完了は dateUnknown に分離して消化量に含めない', () => {
  const kpi = calculateKpi({ date, todoParse: parseTodos('## 残TODO\n1. A ✅ 完了'), runs: [], batch: baseBatch });
  assert.equal(kpi.dateUnknown, 1);
  assert.equal(kpi.closedOvernight, 0);
});

test('壊れた stdout JSON でもセッション件数を数え、コスト不明にする', () => {
  const kpi = calculateKpi({ date, todoParse: parseTodos(''), runs: [run({ stdout: '{broken' })], batch: baseBatch });
  assert.equal(kpi.sessions, 1);
  assert.equal(kpi.costUnknownSessions, 1);
  assert.equal(kpi.nightCostUsd, null);
});

test('noOp の各名前付きパターンを判定する', () => {
  const samples = ['コード変更は不要', '差分ゼロ', '既に修正済み', '変更ゼロ', '実装は不要', '再実装は行わなかった', 'already fixed', 'already resolved', 'already merged', 'no code', 'no new code'];
  assert.equal(NO_OP_PATTERNS.length, 8);
  for (const text of samples) assert.equal(parseRun(run({ summary: text })).noOp, true, text);
  assert.equal(parseRun(run({ summary: 'コードを変更した' })).noOp, false);
});

test('既知トークンで netSavingUsd = supervisor - night - wasted', () => {
  const active = run({ stdout: JSON.stringify({ modelUsage: { 'claude-sonnet-5': { inputTokens: 1_000_000, outputTokens: 1_000_000, cacheCreationInputTokens: 1_000_000, cacheReadInputTokens: 1_000_000 } } }) });
  const noop = run({ summary: '差分ゼロ', stdout: JSON.stringify({ total_cost_usd: 2, modelUsage: { 'claude-sonnet-5': { inputTokens: 1_000_000 } } }) });
  const kpi = calculateKpi({ date, todoParse: parseTodos(''), runs: [active, noop], batch: baseBatch });
  assert.equal(kpi.nightCostUsd, 24.05); // sonnet 22.05 + 実測 2
  assert.equal(kpi.supervisorEquivalentUsd, 41.75); // opus 36.75 + 5
  assert.equal(kpi.wastedUsd, 2);
  assert.equal(kpi.netSavingUsd, 15.7);
});

test('夜間窓の境界をローカル時刻で判定する', () => {
  assert.equal(isInNightlyWindow('2026-09-01T17:59:00+09:00', date), false);
  assert.equal(isInNightlyWindow('2026-09-01T18:00:00+09:00', date), true);
  assert.equal(isInNightlyWindow('2026-09-02T09:00:00+09:00', date), true);
  assert.equal(isInNightlyWindow('2026-09-02T09:01:00+09:00', date), false);
});

test('同内容の未消化TODOがあれば再起票せず、新規だけ先頭ブロックへ追加する', () => {
  const markdown = '## 残TODO（先頭）\n1. **P0: 同じ障害**\n## 完了条件\nx\n## 残TODO\n1. 履歴';
  const result = appendImprovementTodos(markdown, ['P0: 同じ障害', 'P1: 新しい改善']);
  assert.deepEqual(result.added, ['P1: 新しい改善']);
  assert.equal((result.markdown.match(/P0: 同じ障害/g) ?? []).length, 1);
  assert.match(result.markdown, /2\. P1: 新しい改善\n## 完了条件/);
});

test('normalizeTodo は番号・装飾・完了注記を除去する', () => {
  assert.equal(normalizeTodo('2. ~~**A  B**~~ → ✅ 2026-09-02 完了'), 'A B');
});
