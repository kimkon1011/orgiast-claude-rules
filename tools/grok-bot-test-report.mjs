// grok-bot-test-report.mjs — Grok Bot 向けテスト結果レポート生成
import fs from 'node:fs';
//
// 使い方:
//   node tools/grok-bot-test-report.mjs --results <results.json> [--url <URL>] [--description <変更内容>] [--preview <URL>]
//   node tools/grok-bot-test-report.mjs --help

const STATUS_ICONS = { pass: '✅', fail: '❌', warn: '⚠️' };
const STATUS_LABELS = { pass: 'PASS', fail: 'FAIL', warn: 'WARN' };

/**
 * テスト結果からGrok Bot向けMarkdownレポートを生成
 * @param {Array} results - site-test-runner の results 配列
 * @param {object} [options]
 * @param {string} [options.url] - 検査対象URL
 * @param {string} [options.changeDescription] - 変更内容の説明
 * @param {string} [options.previewUrl] - プレビューURL
 * @returns {string} マークダウンレポート
 */
export function generateReport(results, options = {}) {
  const { url = '', changeDescription = '', previewUrl = '' } = options;

  if (!Array.isArray(results) || results.length === 0) {
    return `✅ サイト更新テスト結果（テストなし、スキップされました）\n\n対象: ${url}\n変更: ${changeDescription || '(なし)'}\n\n📋 テストは実行されませんでした。`;
  }

  const overall = results.some(r => r.status === 'fail') ? 'fail'
    : results.some(r => r.status === 'warn') ? 'warn'
    : 'pass';

  const overallIcon = STATUS_ICONS[overall];
  const overallLabel = STATUS_LABELS[overall];

  // 各スイート結果の整形
  const suiteLines = results.map(r => {
    const icon = STATUS_ICONS[r.status] || '❓';
    const label = STATUS_LABELS[r.status] || 'UNKNOWN';
    return `  ${r.suite}: ${icon} ${label}（${r.summary}）`;
  }).join('\n');

  // 詳細（FAIL/WARNのみ）
  const detailEntries = results.filter(r => r.status !== 'pass');
  let detailsSection = '';
  if (detailEntries.length > 0) {
    const detailLines = detailEntries.flatMap(r =>
      r.checks
        .filter(c => !c.passed)
        .map(c => `    - ${c.name}: ${c.detail || 'FAIL'}`)
    );
    if (detailLines.length > 0) {
      detailsSection = `\n📝 詳細（不合格チェック）\n${detailLines.join('\n')}`;
    }
  }

  // 推奨アクション
  let actionText;
  if (overall === 'fail') {
    actionText = '修正後、再度テストを実行してください。不合格チェックを先に修正する必要があります。';
  } else if (overall === 'warn') {
    actionText = '警告を確認してください。重大な問題はありませんが、推奨事項に対応することをお勧めします。';
  } else {
    actionText = '全テスト合格。プレビューを確認後、承認してデプロイ可能です。';
  }

  // プレビューリンク
  const previewLine = previewUrl
    ? `\n🔗 プレビュー: ${previewUrl}\n`
    : '';

  return [
    `${overallIcon} サイト更新テスト結果`,
    `━━━━━━━━━━━━━━━━━━━`,
    `対象: ${url}`,
    `変更: ${changeDescription || '(指定なし)'}`,
    ``,
    `📋 テスト結果（全体: ${overallIcon} ${overallLabel}）`,
    suiteLines,
    detailsSection,
    ``,
    `🔄 推奨アクション: ${actionText}`,
    previewLine,
  ].join('\n');
}

/**
 * CLI エントリポイント
 */
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`Grok Bot テストレポート生成 v1.0

使い方:
  node tools/grok-bot-test-report.mjs --results <results.json>
  node tools/grok-bot-test-report.mjs --results <results.json> --url <URL>
  node tools/grok-bot-test-report.mjs --sample

オプション:
  --results <file|json>  テスト結果JSON（ファイルパス または JSON文字列）
  --url <URL>            検査対象URL
  --description <text>   変更内容の説明
  --preview <URL>        プレビューURL
  --sample               サンプルレポートを表示`);
    process.exit(0);
  }

  if (args.includes('--sample')) {
    const sampleResults = [
      { suite: 'html-valid', status: 'pass', checks: Array(7).fill({ passed: true }), summary: '7/7 checks passed' },
      { suite: 'links', status: 'pass', checks: [{ passed: true }], summary: '3 links OK' },
      { suite: 'seo-meta', status: 'warn', checks: [
        { passed: true, name: 'title長さ', detail: '42字' },
        { passed: false, name: 'description長さ', detail: '90字（短すぎ）' },
      ], summary: '1 warning' },
    ];
    console.log(generateReport(sampleResults, {
      url: 'https://orgiast.jp/',
      changeDescription: 'トップページ更新（実績数3→5）',
      previewUrl: 'https://preview.orgiast.jp/pr-1234/'
    }));
    process.exit(0);
  }

  const resultsIndex = args.indexOf('--results');
  const urlIndex = args.indexOf('--url');
  const descIndex = args.indexOf('--description');
  const previewIndex = args.indexOf('--preview');

  if (resultsIndex === -1) {
    console.error('--results は必須です');
    process.exit(1);
  }

  let results;
  const resultsVal = args[resultsIndex + 1];
  try {
    results = JSON.parse(resultsVal);
  } catch {
    try {
      results = JSON.parse(fs.readFileSync(resultsVal, 'utf-8'));
    } catch {
      console.error('--results のJSONパースに失敗しました');
      process.exit(1);
    }
  }

  const url = urlIndex !== -1 ? args[urlIndex + 1] : '';
  const description = descIndex !== -1 ? args[descIndex + 1] : '';
  const preview = previewIndex !== -1 ? args[previewIndex + 1] : '';

  console.log(generateReport(
    results.results || results,
    { url, changeDescription: description, previewUrl: preview }
  ));
  process.exit(0);
}

// CLI
if (process.argv[1] && process.argv[1].endsWith('grok-bot-test-report.mjs') && !process.argv[1].endsWith('test.mjs')) {
  main();
}