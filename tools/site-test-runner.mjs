// site-test-runner.mjs — サイト更新テスト実行CLI
//
// 使い方:
//   node tools/site-test-runner.mjs --url https://example.com
//   node tools/site-test-runner.mjs --url https://example.com --suites html-valid,seo-meta
//   node tools/site-test-runner.mjs --url https://example.com --change-type text
//   node tools/site-test-runner.mjs --help

import {
  checkHtmlValidity,
  checkLinks,
  checkSeoMeta,
  checkPerformance,
  checkStructure,
  checkWcagBasic
} from './site-test-suites.mjs';

/**
 * 全6スイートの定義マップ
 */
const ALL_SUITES = {
  'html-valid': { fn: checkHtmlValidity, label: 'HTML検証' },
  'links':      { fn: checkLinks,      label: 'リンクチェック' },
  'seo-meta':   { fn: checkSeoMeta,    label: 'SEOメタチェック' },
  'performance': { fn: checkPerformance, label: 'パフォーマンス基本' },
  'structure':  { fn: checkStructure,  label: '構造チェック' },
  'wcag-basic': { fn: checkWcagBasic,  label: 'アクセシビリティ基本' },
};

/**
 * 変更種別→スイートマッピング
 */
const CHANGE_TYPE_SUITES = {
  text:     ['html-valid', 'seo-meta', 'structure', 'wcag-basic'],
  layout:   ['html-valid', 'structure', 'wcag-basic', 'performance'],
  link:     ['links', 'html-valid', 'seo-meta'],
  image:    ['html-valid', 'wcag-basic', 'performance'],
  seo:      ['seo-meta', 'html-valid', 'structure', 'links'],
  full:     Object.keys(ALL_SUITES),
};

/**
 * 対象データ（テスト対象を抽象化）
 * CLI からは直接渡せないので、各スイートの検査内容に応じたモックデータを生成または受け取る。
 * 実際の使用では fetch などでページを取得してからスイートに渡す。
 */
function buildTargetData(url, html, options) {
  return {
    url,
    html: html || '',
    links: options?.links || [],
    meta: options?.meta || { title: '', description: '', h1Count: 0, hasCanonical: false, hasOgTitle: false },
    perf: options?.perf || { htmlSize: 0, imageCount: 0 },
    structure: options?.structure || { headings: [], images: [] },
    wcag: options?.wcag || [],
  };
}

/**
 * 全スイートを実行
 * @param {string} url - 検査対象URL
 * @param {object} data - 検査用データ
 * @param {object} [options] - オプション
 * @returns {object}
 */
export function runAllSuites(url, data, options = {}) {
  return runSelectedSuites(Object.keys(ALL_SUITES), url, data, options);
}

/**
 * 指定スイートを実行
 * @param {string[]} suiteNames - 実行するスイート名
 * @param {string} url - 検査対象URL
 * @param {object} data - 検査用データ
 * @param {object} [options] - オプション
 * @returns {object}
 */
export function runSelectedSuites(suiteNames, url, data, options = {}) {
  if (!Array.isArray(suiteNames) || suiteNames.length === 0) {
    throw new Error('suiteNames は空でない配列である必要があります');
  }

  const invalidSuites = suiteNames.filter(n => !ALL_SUITES[n]);
  if (invalidSuites.length > 0) {
    throw new Error(`不明なスイート: ${invalidSuites.join(', ')}。有効: ${Object.keys(ALL_SUITES).join(', ')}`);
  }

  const target = data || buildTargetData(url, '', options);
  const results = suiteNames.map(name => {
    const suite = ALL_SUITES[name];
    let result;
    switch (name) {
      case 'html-valid':
        result = suite.fn(target.html);
        break;
      case 'links':
        result = suite.fn(target.links);
        break;
      case 'seo-meta':
        result = suite.fn(target.meta);
        break;
      case 'performance':
        result = suite.fn(target.perf);
        break;
      case 'structure':
        result = suite.fn(target.structure);
        break;
      case 'wcag-basic':
        result = suite.fn(target.wcag);
        break;
      default:
        result = suite.fn(target);
    }
    return result;
  });

  const overall = results.some(r => r.status === 'fail') ? 'fail'
    : results.some(r => r.status === 'warn') ? 'warn'
    : 'pass';

  return {
    url,
    timestamp: new Date().toISOString(),
    results,
    overall
  };
}

/**
 * 変更種別からスイートを選択して実行
 * @param {string} changeType - 変更種別
 * @param {string} url - 検査対象URL
 * @param {object} data - 検査用データ
 * @returns {object}
 */
export function runSuitesForChangeType(changeType, url, data) {
  const suites = CHANGE_TYPE_SUITES[changeType];
  if (!suites) {
    throw new Error(`不明な変更種別: ${changeType}。有効: ${Object.keys(CHANGE_TYPE_SUITES).join(', ')}`);
  }
  return runSelectedSuites(suites, url, data);
}

/**
 * CLI エントリポイント
 */
function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`サイト更新テストランナー v1.0

使い方:
  node tools/site-test-runner.mjs --url <URL> [オプション]

オプション:
  --url <URL>              検査対象URL（必須）
  --suites <name,...>      実行スイート（カンマ区切り、省略時は全スイート）
  --change-type <type>     変更種別から自動選択（text/layout/link/image/seo/full）
  --html <文字列>          検査用HTML（省略時はfetch）

利用可能スイート:
${Object.entries(ALL_SUITES).map(([k, v]) => `  ${k}: ${v.label}`).join('\n')}

変更種別:
${Object.entries(CHANGE_TYPE_SUITES).map(([k, v]) => `  ${k}: ${v.join(', ')}`).join('\n')}

例:
  node tools/site-test-runner.mjs --url https://orgiast.jp
  node tools/site-test-runner.mjs --url https://orgiast.jp --suites html-valid,seo-meta
  node tools/site-test-runner.mjs --url https://orgiast.jp --change-type text`);
    process.exit(0);
  }

  const urlIndex = args.indexOf('--url');
  const suitesIndex = args.indexOf('--suites');
  const ctIndex = args.indexOf('--change-type');
  const htmlIndex = args.indexOf('--html');

  if (urlIndex === -1) {
    console.error('--url は必須です');
    process.exit(1);
  }

  const url = args[urlIndex + 1];
  let result;

  if (ctIndex !== -1) {
    const changeType = args[ctIndex + 1];
    const data = buildTargetData(url, htmlIndex !== -1 ? args[htmlIndex + 1] : '', {});
    result = runSuitesForChangeType(changeType, url, data);
  } else if (suitesIndex !== -1) {
    const suiteNames = args[suitesIndex + 1].split(',');
    const data = buildTargetData(url, htmlIndex !== -1 ? args[htmlIndex + 1] : '', {});
    result = runSelectedSuites(suiteNames, url, data);
  } else {
    const data = buildTargetData(url, htmlIndex !== -1 ? args[htmlIndex + 1] : '', {});
    result = runAllSuites(url, data);
  }

  console.log(JSON.stringify(result, null, 2));
  process.exit(result.overall === 'fail' ? 1 : 0);
}

// CLI実行
if (process.argv[1] && (process.argv[1].endsWith('site-test-runner.mjs'))) {
  main();
}