import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NO_OP_PATTERNS, TODO_SIMILARITY_THRESHOLD,
  appendImprovementTodos, calculateKpi, clusterBySimilarity, isInNightlyWindow,
  formatText, githubRepo, improvementTodos, normalizeTodo, parseBatchLog, parseRun, parseTodos,
  queryPullRequests, similarity, todoTokens,
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

test('similarity は同一文字列で1、無関係な文字列で0に近い', () => {
  const tokens = todoTokens('auto-session の exit 1 誤報を直す');
  assert.equal(similarity(tokens, tokens), 1);
  assert.ok(similarity(tokens, todoTokens('Growi マニュアルを取り込む')) < 0.1);
});

test('補足だけが違う近似TODOは同じクラスタになる', () => {
  const items = [
    'auto-session の exit 1 誤報を直す （上記「次の1目的」）',
    'auto-session の exit 1 誤報を直す （上記「次の1目的」／下の a55cee2f ブロックに詳細）',
  ];
  assert.equal(clusterBySimilarity(items, { threshold: TODO_SIMILARITY_THRESHOLD, keyOf: (item) => item }).length, 1);
});

test('近似重複TODOのどれかに✅があればクラスタ全体を完了扱いする', () => {
  const parsed = parseTodos('## 残TODO\n1. auto-session の exit 1 誤報を直す （次の目的）\n## 履歴\n## 残TODO\n2. auto-session の exit 1 誤報を直す （詳細） → ✅ 2026-09-02 完了');
  assert.equal(parsed.todos.length, 1);
  assert.equal(parsed.todos[0].completed, true);
  assert.equal(parsed.todos[0].completedDate, '2026-09-02');
  assert.equal(parsed.duplicateTodoLines, 1);
});

test('clusterBySimilarity は同じ入力に対して決定的である', () => {
  const items = ['alpha beta', 'alpha beta gamma', '別の仕事'];
  const cluster = () => clusterBySimilarity(items, { threshold: 0.5, keyOf: (item) => item });
  assert.deepEqual(cluster(), cluster());
});

test('gh 失敗時は prYieldRate を null のまま保持し、0に丸めない', () => {
  const pullRequests = queryPullRequests(date, 'owner/repo', { runGh: () => ({ status: 1, stderr: 'offline' }) });
  const kpi = calculateKpi({ date, todoParse: parseTodos(''), runs: [run()], batch: baseBatch, pullRequests });
  assert.equal(kpi.prsCreated, null);
  assert.deepEqual(kpi.prNumbers, []);
  assert.equal(kpi.prYieldRate, null);
});

test('夜間窓外に作成されたPRを除外し、境界上は含める', () => {
  const prs = [
    { number: 1, createdAt: '2026-09-01T17:59:59+09:00' },
    { number: 2, createdAt: '2026-09-01T18:00:00+09:00' },
    { number: 3, createdAt: '2026-09-02T09:00:00+09:00' },
    { number: 4, createdAt: '2026-09-02T09:01:00+09:00' },
  ];
  const result = queryPullRequests(date, 'owner/repo', { runGh: () => ({ status: 0, stdout: JSON.stringify(prs) }) });
  assert.deepEqual(result, { prsCreated: 2, prNumbers: [2, 3] });
});

test('GitHub remote URLをghのowner/repo形式に正規化する', () => {
  assert.equal(githubRepo('https://github.com/owner/repo.git'), 'owner/repo');
  assert.equal(githubRepo('git@github.com:owner/repo.git'), 'owner/repo');
});

test('成果率30%未満かつ5セッション以上だけ改善TODOを起票する', () => {
  const base = { date, batchRan: true, batchCompleted: true, failedSteps: [], noOpRate: 0, closeRate: null };
  assert.match(improvementTodos({ ...base, sessions: 5, prsCreated: 1, prYieldRate: 0.2 })[0], /夜間 5 セッションに対し PR は 1 本（成果率 20\.0%）/);
  assert.deepEqual(improvementTodos({ ...base, sessions: 4, prsCreated: 0, prYieldRate: 0 }), []);
  assert.deepEqual(improvementTodos({ ...base, sessions: 5, prsCreated: 2, prYieldRate: 0.4 }), []);
  assert.deepEqual(improvementTodos({ ...base, sessions: 5, prsCreated: null, prYieldRate: null }), []);
});

test('topicConcentration はJSONにもtextにも現れない', () => {
  const kpi = calculateKpi({ date, todoParse: parseTodos(''), runs: [run()], batch: baseBatch, pullRequests: { prsCreated: 1, prNumbers: [204] } });
  assert.equal('topicConcentration' in kpi, false);
  assert.doesNotMatch(JSON.stringify(kpi), /topicConcentration|テーマ集中/);
  assert.doesNotMatch(formatText(kpi), /topicConcentration|テーマ集中/);
  assert.match(formatText(kpi), /成果 1PR\/1セッション = 100\.0%/);
});
