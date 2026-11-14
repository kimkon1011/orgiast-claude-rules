// site-test-suites.mjs — サイト更新テストスイート定義
//
// 各スイートは (target) => { suite, status, checks, summary } を返す。
// status: 'pass' | 'fail' | 'warn'

/**
 * HTML検証スイート
 * @param {string} html - 検査対象HTML文字列
 * @returns {{ suite: string, status: string, checks: Array, summary: string }}
 */
export function checkHtmlValidity(html) {
  const checks = [
    { name: 'DOCTYPE存在', passed: /<!DOCTYPE\s+html>/i.test(html), detail: '' },
    { name: 'html lang=ja', passed: /<html[^>]*\slang="ja"/i.test(html), detail: '' },
    { name: 'meta charset=UTF-8', passed: /<meta[^>]*charset=["\']?UTF-8["\']?/i.test(html), detail: '' },
    { name: 'meta viewport', passed: /<meta[^>]*name=["\']viewport["\']/i.test(html), detail: '' },
    { name: 'title存在', passed: /<title>[\s\S]*?<\/title>/i.test(html), detail: '' },
    { name: 'h1存在', passed: /<h1[^>]*>[\s\S]*?<\/h1>/i.test(html), detail: '' },
    { name: 'main存在', passed: /<main[^>]*>[\s\S]*?<\/main>/i.test(html), detail: '' },
  ];
  const failed = checks.filter(c => !c.passed);
  return {
    suite: 'html-valid',
    status: failed.length === 0 ? 'pass' : 'fail',
    checks,
    summary: `${checks.length - failed.length}/${checks.length} checks passed`
  };
}

/**
 * リンクチェックスイート
 * @param {Array<{href: string, text: string}>} links
 * @returns {{ suite: string, status: string, checks: Array, summary: string }}
 */
export function checkLinks(links) {
  if (!links || links.length === 0) {
    return {
      suite: 'links',
      status: 'pass',
      checks: [{ name: 'リンク存在', passed: true, detail: 'リンクなし（空のためスキップ）' }],
      summary: 'SKIP（リンク0件）'
    };
  }
  const checks = links.map((link, i) => ({
    name: `リンク[${i}]: ${link.href || '(空)'}`,
    passed: !!link.href && link.href.trim().length > 0,
    detail: !link.href ? 'href が空' : ''
  }));
  const failed = checks.filter(c => !c.passed);
  return {
    suite: 'links',
    status: failed.length === 0 ? 'pass' : 'fail',
    checks,
    summary: failed.length > 0 ? `${failed.length}/${checks.length} links failed` : `${checks.length} links OK`
  };
}

/**
 * SEOメタチェックスイート
 * @param {{ title: string, description: string, h1Count: number, hasCanonical: boolean, hasOgTitle: boolean }} meta
 * @returns {{ suite: string, status: string, checks: Array, summary: string }}
 */
export function checkSeoMeta(meta) {
  const t = meta || {};
  const hardChecks = [];
  const warnChecks = [];

  // 重大違反（存在しない → FAIL）
  hardChecks.push({
    name: 'title長さ',
    passed: !!t.title && t.title.trim().length > 0,
    detail: t.title ? `${t.title.length}字` : 'title無し',
  });
  hardChecks.push({
    name: 'h1重複チェック',
    passed: t.h1Count === 1,
    detail: `h1: ${t.h1Count}個`,
  });
  hardChecks.push({
    name: 'canonical存在',
    passed: !!t.hasCanonical,
    detail: t.hasCanonical ? 'あり' : 'なし',
  });
  hardChecks.push({
    name: 'og:title存在',
    passed: !!t.hasOgTitle,
    detail: t.hasOgTitle ? 'あり' : 'なし',
  });

  // 軽微違反（超過 → WARN）
  if (t.description && t.description.length > 160) {
    warnChecks.push({
      name: 'description長さ',
      passed: false,
      detail: `${t.description.length}字（超過）`,
    });
  } else {
    // description が範囲内なら合格チェックとして追加
    warnChecks.push({
      name: 'description長さ',
      passed: true,
      detail: t.description ? `${t.description.length}字` : '未設定（任意）',
    });
  }

  const checks = [...hardChecks, ...warnChecks];
  const failed = checks.filter(c => !c.passed);
  const hasFail = hardChecks.some(c => !c.passed);
  const hasWarn = warnChecks.some(c => !c.passed);
  const failedCount = failed.length;

  return {
    suite: 'seo-meta',
    status: hasFail ? 'fail' : hasWarn ? 'warn' : 'pass',
    checks,
    summary: failedCount > 0 ? `${failedCount} warnings/fails` : 'all OK',
  };
}

/**
 * パフォーマンス基本チェックスイート
 * @param {{ htmlSize: number, imageCount: number }} info
 * @returns {{ suite: string, status: string, checks: Array, summary: string }}
 */
export function checkPerformance(info) {
  const i = info || { htmlSize: 0, imageCount: 0 };
  const checks = [
    { name: 'HTMLサイズ', passed: i.htmlSize < 50 * 1024, detail: `${(i.htmlSize / 1024).toFixed(1)}KB` },
    { name: '画像数', passed: i.imageCount < 20, detail: `${i.imageCount}枚` },
  ];
  const failed = checks.filter(c => !c.passed);
  return {
    suite: 'performance',
    status: failed.length === 0 ? 'pass' : 'warn',
    checks,
    summary: failed.length > 0 ? `${failed.length} warnings` : 'all OK'
  };
}

/**
 * 構造チェックスイート
 * @param {{ headings: Array<{level: number, text: string}>, images: Array<{hasAlt: boolean}> }} elements
 * @returns {{ suite: string, status: string, checks: Array, summary: string }}
 */
export function checkStructure(elements) {
  const el = elements || { headings: [], images: [] };
  const checks = [];

  // 見出し階層飛び越しチェック
  let expectedLevel = 1;
  let headingSkip = false;
  for (const h of el.headings) {
    if (h.level > expectedLevel + 1) {
      headingSkip = true;
      break;
    }
    expectedLevel = Math.max(expectedLevel, h.level);
  }
  checks.push({
    name: '見出し階層（飛び越し無し）',
    passed: !headingSkip,
    detail: el.headings.length > 0
      ? `h1→h${Math.max(...el.headings.map(h => h.level))} ${headingSkip ? '飛び越しあり' : '正常'}`
      : '見出し無し（迂回）'
  });

  // img alt属性チェック
  const imagesNoAlt = el.images.filter(img => !img.hasAlt);
  checks.push({
    name: 'img alt属性',
    passed: imagesNoAlt.length === 0,
    detail: imagesNoAlt.length > 0 ? `${imagesNoAlt.length}件 alt欠落` : `全${el.images.length}件 altあり`
  });

  const failed = checks.filter(c => !c.passed);
  return {
    suite: 'structure',
    status: failed.length === 0 ? 'pass' : 'fail',
    checks,
    summary: failed.length > 0 ? `${failed.length} fails` : 'all OK'
  };
}

/**
 * アクセシビリティ基本チェックスイート
 * @param {Array<{tag: string, hasAlt: boolean, tabindex: number}>} elements
 * @returns {{ suite: string, status: string, checks: Array, summary: string }}
 */
export function checkWcagBasic(elements) {
  const el = elements || [];
  const checks = [];

  // フォーカス可能要素のtabindexチェック
  const focusable = el.filter(e => ['a', 'button', 'input', 'select', 'textarea'].includes(e.tag));
  const negativeTab = focusable.filter(e => e.tabindex !== undefined && e.tabindex < 0);
  checks.push({
    name: 'フォーカス要素の tabindex',
    passed: negativeTab.length === 0,
    detail: negativeTab.length > 0 ? `${negativeTab.length}件 tabindex<0` : `全${focusable.length}件 OK`
  });

  // img alt属性
  const imgs = el.filter(e => e.tag === 'img');
  const missingAlt = imgs.filter(e => !e.hasAlt);
  checks.push({
    name: 'img alt属性（WCAG 1.1.1）',
    passed: missingAlt.length === 0,
    detail: missingAlt.length > 0 ? `${missingAlt.length}件 alt欠落` : `全${imgs.length}件 altあり`
  });

  const failed = checks.filter(c => !c.passed);
  const status = failed.length > 0 && failed.filter(c => c.name.includes('tabindex')).length > 0 ? 'warn' : (failed.length > 0 ? 'warn' : 'pass');
  return {
    suite: 'wcag-basic',
    status,
    checks,
    summary: failed.length > 0 ? `${failed.length} warnings` : 'all OK'
  };
}