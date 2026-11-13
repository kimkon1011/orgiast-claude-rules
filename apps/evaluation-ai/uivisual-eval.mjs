/**
 * UI Visual Evaluation Engine (X-0018)
 *
 * 構築エージェントと評価エージェントを分離したUI改善ループの評価側。
 * 視覚的一貫性・独創性・ユーザビリティの各基準でUI生成物を評価し、
 * 合格/不合格と具体的なフィードバックを返す。
 *
 * @module uivisual-eval
 */

/**
 * 既定の評価基準と重み
 */
export const DEFAULT_CRITERIA = Object.freeze({
  visualConsistency: Object.freeze({
    weight: 3,
    items: Object.freeze([
      { id: 'V1', name: 'カラーパレット統一', description: '既定のカラートークンに従っているか' },
      { id: 'V2', name: 'タイポグラフィ統一', description: 'フォントサイズ・行間・ウェイトの一貫性' },
      { id: 'V3', name: 'スペーシング統一', description: 'マージン・パディングが単位の倍数か' },
      { id: 'V4', name: 'コンポーネント統一', description: '同じ意味の要素に同じスタイルか' },
      { id: 'V5', name: '状態の一貫性', description: 'hover/focus/active/disabledの実装' },
    ]),
  }),
  originality: Object.freeze({
    weight: 2,
    items: Object.freeze([
      { id: 'O1', name: 'テンプレート回避', description: '既存テンプレートの完全コピーでないか' },
      { id: 'O2', name: 'レイアウトバリエーション', description: '全画面が同一レイアウトでないか' },
      { id: 'O3', name: 'ビジュアル階層', description: '重要度に応じた視覚的強調が適切か' },
    ]),
  }),
  usability: Object.freeze({
    weight: 2,
    items: Object.freeze([
      { id: 'U1', name: '応答性', description: '320px〜1920pxでレイアウトが崩れないか' },
      { id: 'U2', name: 'アクセシビリティ', description: 'WCAG 2.1 AAを満たすか' },
      { id: 'U3', name: '読込みパフォーマンス', description: '基本最適化が施されているか' },
    ]),
  }),
});

/**
 * 判定結果の型
 * @typedef {Object} EvaluationResult
 * @property {Object} scores - カテゴリ別スコア
 * @property {Array<{id:string, name:string, score:number, feedback:string}>} details - 項目別詳細
 * @property {number} totalScore - 加重総合スコア（1〜5）
 * @property {'pass'|'revision'} verdict - 合格/改訂要求
 * @property {Array<string>} revisionItems - 改訂が必要な項目ID一覧
 */

/**
 * 既定の合格閾値
 */
export const DEFAULT_PASS_THRESHOLD = 3.5;

/**
 * すべてのカテゴリと評価項目をフラットな配列で取得する
 * @returns {Array<{id:string, category:string, name:string, description:string}>}
 */
export function getAllCriteriaItems() {
  const items = [];
  for (const [category, group] of Object.entries(DEFAULT_CRITERIA)) {
    for (const item of group.items) {
      items.push({ ...item, category });
    }
  }
  return items;
}

/**
 * 各評価項目のスコア（1〜5）を受け取り、加重総合スコアを計算する
 * @param {Object<string, number>} scores - 項目IDをキーとするスコアオブジェクト
 * @param {Object} [options]
 * @param {number} [options.passThreshold=3.5]
 * @returns {EvaluationResult}
 */
export function evaluate(scores = {}, { passThreshold = DEFAULT_PASS_THRESHOLD } = {}) {
  const details = [];
  let weightedSum = 0;
  let totalWeight = 0;

  for (const [category, group] of Object.entries(DEFAULT_CRITERIA)) {
    for (const item of group.items) {
      const score = Number(scores[item.id]);
      const validScore = Number.isFinite(score) && score >= 1 && score <= 5 ? score : null;
      const effectiveScore = validScore ?? 3; // 未評価は中間点

      details.push({
        id: item.id,
        name: item.name,
        category,
        score: effectiveScore,
        maxScore: 5,
        feedback: validScore === null
          ? `「${item.name}」は未評価です。確認してください。`
          : generateFeedback(item.id, item.name, effectiveScore),
      });

      weightedSum += effectiveScore * group.weight;
      totalWeight += group.weight;
    }
  }

  const totalScore = totalWeight > 0 ? Math.round((weightedSum / totalWeight) * 100) / 100 : 0;
  const revisionItems = details
    .filter((d) => d.score < passThreshold)
    .map((d) => d.id);

  return {
    scores: Object.fromEntries(details.map((d) => [d.id, d.score])),
    details,
    totalScore,
    verdict: totalScore >= passThreshold && revisionItems.length === 0 ? 'pass' : 'revision',
    revisionItems,
    passThreshold,
  };
}

/**
 * スコアに応じたフィードバック文を生成する
 * @param {string} id - 基準ID
 * @param {string} name - 基準名
 * @param {number} score - スコア（1〜5）
 * @returns {string}
 */
function generateFeedback(id, name, score) {
  if (score >= 4.5) return `「${name}」は良好です。`;
  if (score >= 3.5) return `「${name}」は概ね基準を満たしていますが、改善の余地があります。`;
  if (score >= 2.5) return `「${name}」に改善が必要です。`;
  return `「${name}」は大幅な改善が必要です。`;
}

/**
 * CSSテキストから色の使用状況を分析する（簡易版）
 * @param {string} cssText
 * @returns {{colors:string[], warnings:string[]}}
 */
export function analyzeColors(cssText) {
  const colorPattern = /#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)/g;
  const matches = cssText.match(colorPattern) ?? [];
  const unique = [...new Set(matches.map((c) => c.toLowerCase()))];
  const warnings = [];
  if (unique.length > 10) warnings.push(`色の種類が${unique.length}色と多いです。3〜5色に絞ることを推奨します。`);
  if (unique.length === 0) warnings.push('CSSに色指定が見つかりません。');
  return { colors: unique, warnings };
}

/**
 * HTMLテキストから基本的なアクセシビリティ問題を検出する（簡易版）
 * @param {string} htmlText
 * @returns {{issues:string[], imgAlts:number, labels:number}}
 */
export function analyzeAccessibility(htmlText) {
  const issues = [];
  const imgPattern = /<img[^>]*>/gi;
  const imgAlts = [];
  let match;
  while ((match = imgPattern.exec(htmlText)) !== null) {
    const tag = match[0];
    if (!/alt=(["'])/i.test(tag) && !tag.includes('alt=""')) {
      imgAlts.push(tag.slice(0, 60));
    }
  }
  if (imgAlts.length > 0) issues.push(`${imgAlts.length}個の<img>にalt属性がありません。`);
  const labelCount = (htmlText.match(/<label\b/gi) ?? []).length;
  const ariaLabelCount = (htmlText.match(/aria-label=/gi) ?? []).length;
  if (labelCount + ariaLabelCount < 3) issues.push('フォームラベルやaria-labelが少ないです。');
  return { issues, imgAlts: imgAlts.length, labels: labelCount + ariaLabelCount };
}
