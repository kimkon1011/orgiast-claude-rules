/**
 * Multi-stage Evaluation Chain
 *
 * 複数の評価手法を直列に実行し、前段を通過しないと次段に進まない。
 * 早期不合格でコスト節約。各評価は OpenEvals と互換性のある
 * 共通インターフェースで記述する。
 *
 * Usage:
 *   const chain = new EvalChain({ evaluators: [lintEval, testEval, visualEval, aiEval] });
 *   const result = await chain.evaluate({ files: ['index.html'], context: {} });
 *
 * @module eval-chain
 */

/**
 * @typedef {Object} EvalItem
 * @property {string} id - 評価項目の一意識別子
 * @property {string} name - 評価項目名
 * @property {number} score - 0〜1 のスコア
 * @property {number} [threshold=0.7] - 合格閾値
 * @property {string} [feedback] - 不合格理由
 * @property {boolean} [critical=true] - 不合格でチェーン停止
 */

/**
 * @typedef {Object} EvalResult
 * @property {boolean} passed - 全体の合格判定
 * @property {number} overallScore - 全項目の加重平均
 * @property {EvalItem[]} items - 各評価項目の結果
 * @property {string[]} failedItems - 不合格項目ID一覧
 * @property {boolean} chainBroken - 途中でチェーンが停止されたか
 */

/**
 * 単一の評価関数の定義
 */
export class EvalStep {
  /**
   * @param {Object} config
   * @param {string} config.name - ステップ名（例: 'lint-check'）
   * @param {string} config.category - カテゴリ（'static'|'functional'|'visual'|'model'）
   * @param {(input: {files: Object<string,string>, context: Object}) => Promise<EvalItem[]>} config.evaluate
   * @param {boolean} [config.critical=true] - 不合格でチェーン停止
   */
  constructor({ name, category, evaluate, critical = true }) {
    this.name = name;
    this.category = category;
    this.evaluate = evaluate;
    this.critical = critical;
  }
}

/**
 * 評価チェーン
 */
export class EvalChain {
  /**
   * @param {Object} config
   * @param {EvalStep[]} config.evaluators - 直列に実行する評価ステップ
   * @param {number} [config.defaultThreshold=0.7]
   */
  constructor({ evaluators, defaultThreshold = 0.7 }) {
    this.evaluators = evaluators;
    this.defaultThreshold = defaultThreshold;
  }

  /**
   * 評価を実行する
   * @param {{files: Object<string,string>, context?: Object}} input
   * @returns {Promise<EvalResult>}
   */
  async evaluate(input = { files: {}, context: {} }) {
    const allItems = [];
    const failedItems = [];
    let chainBroken = false;

    for (const step of this.evaluators) {
      if (chainBroken) {
        allItems.push({
          id: `${step.name}-skipped`,
          name: step.name,
          score: 0,
          threshold: this.defaultThreshold,
          feedback: '前段チェーンで不合格のためスキップ',
          critical: false,
          skipped: true,
        });
        continue;
      }

      let items;
      try {
        items = await step.evaluate(input);
      } catch (err) {
        items = [{
          id: `${step.name}-error`,
          name: step.name,
          score: 0,
          threshold: this.defaultThreshold,
          feedback: `評価実行エラー: ${err.message}`,
          critical: step.critical,
          error: true,
        }];
      }

      for (const item of items) {
        const threshold = item.threshold ?? this.defaultThreshold;
        const passed = item.score >= threshold;

        allItems.push({ ...item, threshold });

        if (!passed) {
          failedItems.push(item.id);
          if (step.critical) {
            chainBroken = true; // この段でチェーン停止
          }
        }
      }
    }

    const scoredItems = allItems.filter((i) => !i.skipped && !i.error);
    const overallScore = scoredItems.length > 0
      ? scoredItems.reduce((sum, i) => sum + i.score, 0) / scoredItems.length
      : 0;

    return {
      passed: failedItems.length === 0,
      overallScore: Math.round(overallScore * 100) / 100,
      items: allItems,
      failedItems,
      chainBroken,
    };
  }

  /**
   * 評価結果のテキストレポートを生成する
   * @param {EvalResult} result
   * @returns {string}
   */
  static formatReport(result) {
    const lines = ['## Eval Chain 結果', ''];
    lines.push(`全体判定: ${result.passed ? '✅ 合格' : '❌ 不合格'}`);
    lines.push(`総合スコア: ${(result.overallScore * 100).toFixed(0)}%`);
    if (result.chainBroken) lines.push('⚠️ チェーンが途中で停止しました');
    lines.push('');

    for (const item of result.items) {
      const passed = item.score >= (item.threshold ?? 0.7);
      const label = item.skipped ? '⏭️' : passed ? '✅' : '❌';
      lines.push(`  ${label} ${item.name}: ${(item.score * 100).toFixed(0)}% (閾値: ${(item.threshold * 100).toFixed(0)}%)`);
      if (item.feedback) lines.push(`     → ${item.feedback}`);
    }

    if (result.failedItems.length > 0) {
      lines.push('');
      lines.push(`不合格項目: ${result.failedItems.join(', ')}`);
    }

    return lines.join('\n');
  }
}

/**
 * ビルトイン評価関数: HTML の妥当性チェック
 */
export const htmlValidator = new EvalStep({
  name: 'html-validator',
  category: 'static',
  evaluate: async ({ files }) => {
    const items = [];
    for (const [filePath, content] of Object.entries(files)) {
      if (!filePath.endsWith('.html') && !filePath.endsWith('.htm')) continue;

      const issues = [];

      // 必須タグの存在確認
      if (!/<\!DOCTYPE html>/i.test(content)) issues.push('DOCTYPE 宣言なし');
      if (!/<html/i.test(content)) issues.push('<html> タグなし');
      if (!/<head/i.test(content)) issues.push('<head> なし');
      if (!/<body/i.test(content)) issues.push('<body> なし');
      if (!/<title>[^<]+<\/title>/i.test(content)) issues.push('<title> なし');
      if (!/lang=(["'])/i.test(content)) issues.push('html lang 属性なし');
      if (!/<meta\s+[^>]*charset/i.test(content)) issues.push('charset meta なし');
      if (!/<meta\s+[^>]*name=["']viewport["']/i.test(content)) issues.push('viewport meta なし');

      // 閉じタグ漏れの簡易チェック
      const openTags = (content.match(/<(\w+)[^>]*>/g) || []).length;
      const closeTags = (content.match(/<\/(\w+)>/g) || []).length;
      if (Math.abs(openTags - closeTags) > 3) issues.push('閉じタグ不一致の可能性');

      // ランドマークの確認
      const hasMain = /<main[\s>]/i.test(content);
      const hasNav = /<nav[\s>]/i.test(content);
      const landmarks = [hasMain, hasNav].filter(Boolean).length;

      items.push({
        id: `html-${filePath}`,
        name: `HTML妥当性: ${filePath}`,
        score: issues.length === 0 ? 1.0 : Math.max(0, 1 - issues.length * 0.2),
        threshold: 0.6,
        feedback: issues.length > 0 ? issues.join('; ') : undefined,
        critical: true,
      });

      items.push({
        id: `landmark-${filePath}`,
        name: `ランドマーク: ${filePath}`,
        score: landmarks >= 1 ? 1.0 : 0.3,
        threshold: 0.5,
        feedback: landmarks === 0 ? 'ランドマーク要素（main, nav など）が不足' : undefined,
        critical: false,
      });
    }
    return items;
  },
  critical: true,
});

/**
 * ビルトイン評価関数: CSS 品質チェック
 */
export const cssValidator = new EvalStep({
  name: 'css-validator',
  category: 'static',
  evaluate: async ({ files }) => {
    const items = [];
    for (const [filePath, content] of Object.entries(files)) {
      if (!filePath.endsWith('.css')) continue;

      const issues = [];
      // !important の過剰使用
      const importantCount = (content.match(/!important/g) || []).length;
      if (importantCount > 3) issues.push(`!important が ${importantCount} 回使用されています`);

      // px 指定の比率（em/rem 推奨）
      const pxMatches = content.match(/\d+px/g) || [];
      const totalValues = content.match(/\d+(px|em|rem|%|vh|vw)/g) || [];
      const pxRatio = totalValues.length > 0 ? pxMatches.length / totalValues.length : 0;
      if (pxRatio > 0.8) issues.push(`px 指定が ${(pxRatio * 100).toFixed(0)}%（em/rem 推奨）`);

      // メディアクエリの存在確認
      const hasMediaQuery = /@media/i.test(content);
      if (!hasMediaQuery) issues.push('メディアクエリなし（レスポンシブ非対応の可能性）');
      if (hasMediaQuery && !/@media\s*\(prefers-color-scheme/i.test(content)) {
        // ダークモード未対応は警告のみ
      }

      items.push({
        id: `css-${filePath}`,
        name: `CSS品質: ${filePath}`,
        score: issues.length === 0 ? 1.0 : Math.max(0.3, 1 - issues.length * 0.15),
        threshold: 0.5,
        feedback: issues.length > 0 ? issues.join('; ') : undefined,
        critical: false,
      });
    }
    return items;
  },
  critical: false,
});