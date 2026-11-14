/**
 * Code Validator
 *
 * AI生成コードの静的検証・機能テスト・視覚評価を統合し、
 * Eval Chain への入力データを生成する。
 *
 * @module code-validator
 */

/**
 * ファイルセットを静的解析する
 * @param {Object<string, string>} files - ファイルパス→内容のマップ
 * @returns {Object} lint結果
 */
export function staticAnalyze(files) {
  const issues = [];

  for (const [filePath, content] of Object.entries(files)) {
    const ext = filePath.split('.').pop().toLowerCase();

    if (ext === 'html' || ext === 'htm') {
      issues.push(...analyzeHtml(content, filePath));
    } else if (ext === 'css') {
      issues.push(...analyzeCss(content, filePath));
    } else if (ext === 'js' || ext === 'mjs' || ext === 'jsx') {
      issues.push(...analyzeJs(content, filePath));
    }
  }

  return {
    totalIssues: issues.length,
    errors: issues.filter((i) => i.severity === 'error'),
    warnings: issues.filter((i) => i.severity === 'warning'),
    info: issues.filter((i) => i.severity === 'info'),
    issues,
    passed: issues.filter((i) => i.severity === 'error').length === 0,
  };
}

function analyzeHtml(content, filePath) {
  const issues = [];
  const lines = content.split('\n');

  // インラインスクリプト・スタイルの検出
  const inlineScripts = (content.match(/<script[^>]*>/gi) || []).filter((t) => !t.includes('src='));
  if (inlineScripts.length > 0) {
    issues.push({
      severity: 'warning',
      file: filePath,
      line: 0,
      message: `インラインスクリプトが ${inlineScripts.length} 個あります。外部ファイル化を推奨`,
      rule: 'inline-script',
    });
  }

  // スキップリンクの有無
  if (!content.includes('skip') && !content.includes('Skip')) {
    issues.push({
      severity: 'warning',
      file: filePath,
      line: 0,
      message: 'スキップリンク（skip to content）がありません',
      rule: 'skip-link',
    });
  }

  // heading 構造のチェック
  const hLevels = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/<h([1-6])[\s>]/i);
    if (m) hLevels.push({ level: parseInt(m[1]), line: i + 1 });
  }
  if (hLevels.length > 0 && hLevels[0].level !== 1) {
    issues.push({
      severity: 'warning',
      file: filePath,
      line: hLevels[0].line,
      message: `最初の見出しが h1 ではなく h${hLevels[0].level} です`,
      rule: 'heading-order',
    });
  }
  for (let i = 1; i < hLevels.length; i++) {
    if (hLevels[i].level - hLevels[i - 1].level > 1) {
      issues.push({
        severity: 'error',
        file: filePath,
        line: hLevels[i].line,
        message: `h${hLevels[i - 1].level} から h${hLevels[i].level} に飛んでいます（見出しレベルスキップ）`,
        rule: 'heading-skip',
      });
    }
  }

  return issues;
}

function analyzeCss(content, filePath) {
  const issues = [];

  // ブラウザプレフィックスなしの最新CSSプロパティのチェック
  const modernProperties = ['container', 'has()', 'dvh', 'svh', 'lvh', 'view-transition'];
  const hasModern = modernProperties.some((p) => content.includes(p));

  // 色指定の一貫性
  const hexColors = (content.match(/#[0-9a-fA-F]{3,8}/g) || []).length;
  const rgbColors = (content.match(/rgba?\(/g) || []).length;
  const hslColors = (content.match(/hsla?\(/g) || []).length;

  const colorFormats = [hexColors > 0, rgbColors > 0, hslColors > 0].filter(Boolean).length;
  if (hexColors + rgbColors + hslColors > 0 && colorFormats >= 2) {
    issues.push({
      severity: 'warning',
      file: filePath,
      line: 0,
      message: '色指定方式が混在しています（hex / rgb / hsl）',
      rule: 'color-consistency',
    });
  }

  return issues;
}

function analyzeJs(content, filePath) {
  const issues = [];

  // console.log の残骸
  const consoleLogs = (content.match(/console\.(log|debug|info)\(/g) || []).length;
  if (consoleLogs > 0) {
    issues.push({
      severity: 'warning',
      file: filePath,
      line: 0,
      message: `console. 出力が ${consoleLogs} 個残っています`,
      rule: 'no-console',
    });
  }

  // TODO/FIXME
  const todos = (content.match(/(TODO|FIXME|HACK|XXX)/g) || []).length;
  if (todos > 0) {
    issues.push({
      severity: 'info',
      file: filePath,
      line: 0,
      message: `未処理のコメントマーカーが ${todos} 個あります`,
      rule: 'no-todo',
    });
  }

  // グローバルな var 宣言
  const varDeclarations = (content.match(/\bvar\s+\w+/g) || []).length;
  if (varDeclarations > 0) {
    issues.push({
      severity: 'warning',
      file: filePath,
      line: 0,
      message: `var 宣言が ${varDeclarations} 個あります。let/const に置き換えてください`,
      rule: 'no-var',
    });
  }

  return issues;
}

/**
 * コードが実行可能か簡易検証する
 * @param {string} code - JavaScript コード
 * @returns {{valid: boolean, error: string|null}}
 */
export function validateSyntax(code) {
  try {
    new Function(code);
    return { valid: true, error: null };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}

/**
 * アクセシビリティの簡易スコアを計算する
 * @param {string} html - HTML コンテンツ
 * @returns {{score: number, issues: string[]}}
 */
export function accessibilityScore(html) {
  const issues = [];

  // img alt
  const imgCount = (html.match(/<img[\s>]/gi) || []).length;
  const altCount = (html.match(/alt=/gi) || []).length;
  if (imgCount > altCount) issues.push(`${imgCount - altCount}個の画像にalt属性がありません`);

  // form label
  const inputCount = (html.match(/<(input|select|textarea)[\s>]/gi) || []).length;
  const labelCount = (html.match(/<label[\s>]/gi) || []).length;
  const ariaLabelCount = (html.match(/aria-label=/gi) || []).length;
  if (inputCount > labelCount + ariaLabelCount) {
    issues.push(`${inputCount - labelCount - ariaLabelCount}個の入力にラベルがありません`);
  }

  // 色コントラスト（簡易: style属性の色指定のみ）
  // 本格的なチェックは Playwright + axe-core で行う

  const score = issues.length === 0 ? 1.0 : Math.max(0.3, 1 - issues.length * 0.2);
  return { score, issues };
}

export default { staticAnalyze, validateSyntax, accessibilityScore };