/**
 * Build Agent (X-0018)
 *
 * 構築エージェントは評価エージェントからのフィードバックを受け取り、
 * UIの修正を適用する。修正内容を変更差分として記録し、
 * 再評価のために評価エンジンを呼び出すループを制御する。
 *
 * @module build-agent
 */

import { evaluate, DEFAULT_PASS_THRESHOLD } from './uivisual-eval.mjs';

/**
 * 試行履歴のエントリ
 * @typedef {Object} IterationRecord
 * @property {number} iteration - 試行回数
 * @property {Object<string, number>} scores - 項目別スコア
 * @property {number} totalScore - 総合スコア
 * @property {'pass'|'revision'} verdict - 判定
 * @property {Array<string>} appliedFixes - 適用した修正の説明
 */

/**
 * UI改善ループを実行する
 *
 * @param {Function} buildFn - (feedback:string[]) => Promise<string[]> 修正を適用する関数。変更説明の配列を返す
 * @param {Function} scoreFn - () => Promise<Object<string, number>> 現在のUIを評価してスコアを返す関数
 * @param {Object} [options]
 * @param {number} [options.maxIterations=3] - 最大試行回数
 * @param {number} [options.passThreshold=3.5] - 合格閾値
 * @param {(record:IterationRecord) => void} [options.onIteration] - 各試行後のコールバック
 * @returns {Promise<{passed:boolean, records:IterationRecord[], finalVerdict:'pass'|'revision', summary:string}>}
 */
export async function runImprovementLoop(buildFn, scoreFn, {
  maxIterations = 3,
  passThreshold = DEFAULT_PASS_THRESHOLD,
  onIteration,
} = {}) {
  const records = [];

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    // 現在のスコアを取得
    const currentScores = await scoreFn();
    const result = evaluate(currentScores, { passThreshold });

    const record = {
      iteration,
      scores: result.scores,
      totalScore: result.totalScore,
      verdict: result.verdict,
      appliedFixes: [],
    };

    if (result.verdict === 'pass') {
      records.push(record);
      if (onIteration) onIteration(record);
      return {
        passed: true,
        records,
        finalVerdict: 'pass',
        summary: `試行${iteration}で合格しました（総合スコア: ${result.totalScore}）。`,
      };
    }

    // 改善が必要な項目のフィードバックを収集
    const feedback = result.details
      .filter((d) => d.score < passThreshold)
      .map((d) => `[${d.id}] ${d.feedback}`);

    // 構築エージェントに修正を依頼
    const fixes = await buildFn(feedback);
    record.appliedFixes = fixes;
    records.push(record);
    if (onIteration) onIteration(record);

    // 最終試行後はループ終了
    if (iteration === maxIterations) {
      // 最終スコアを再取得
      const finalScores = await scoreFn();
      const finalResult = evaluate(finalScores, { passThreshold });
      records[records.length - 1].scores = finalResult.scores;
      records[records.length - 1].totalScore = finalResult.totalScore;
      records[records.length - 1].verdict = finalResult.verdict;

      return {
        passed: finalResult.verdict === 'pass',
        records,
        finalVerdict: finalResult.verdict,
        summary: finalResult.verdict === 'pass'
          ? `最大試行回数${maxIterations}回で合格しました（最終スコア: ${finalResult.totalScore}）。`
          : `最大試行回数${maxIterations}回に達しましたが不合格です（最終スコア: ${finalResult.totalScore}）。改訂項目: ${finalResult.revisionItems.join(', ')}`,
      };
    }
  }

  // 到達しない（ループ内でreturnされる）
  return {
    passed: false,
    records,
    finalVerdict: 'revision',
    summary: 'ループが異常終了しました。',
  };
}

/**
 * 試行履歴からレポートテキストを生成する
 * @param {IterationRecord[]} records
 * @returns {string}
 */
export function formatReport(records) {
  const lines = ['## UI改善ループ レポート', ''];
  for (const record of records) {
    lines.push(`### 試行 ${record.iteration}`);
    lines.push(`- 総合スコア: ${record.totalScore}`);
    lines.push(`- 判定: ${record.verdict === 'pass' ? '✅ 合格' : '🔄 改訂要求'}`);
    lines.push(`- スコア詳細: ${JSON.stringify(record.scores)}`);
    if (record.appliedFixes.length > 0) {
      lines.push('- 適用した修正:');
      for (const fix of record.appliedFixes) {
        lines.push(`  - ${fix}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}
