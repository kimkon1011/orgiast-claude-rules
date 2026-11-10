// site-test-suites.test.mjs — テストスイートのテスト
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkHtmlValidity,
  checkLinks,
  checkSeoMeta,
  checkPerformance,
  checkStructure,
  checkWcagBasic
} from './site-test-suites.mjs';

describe('checkHtmlValidity', () => {
  it('有効なHTMLで全チェックPASS', () => {
    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width">
<title>テスト</title>
</head>
<body>
<h1>見出し</h1>
<main>本文</main>
</body>
</html>`;
    const result = checkHtmlValidity(html);
    assert.equal(result.suite, 'html-valid');
    assert.equal(result.status, 'pass');
    assert.equal(result.checks.length, 7);
    assert.equal(result.checks.every(c => c.passed), true);
  });

  it('DOCTYPE欠落でFAIL', () => {
    const html = `<html lang="ja"><head><title>テスト</title></head><body><h1>見出し</h1><main>本文</main></body></html>`;
    const result = checkHtmlValidity(html);
    assert.equal(result.status, 'fail');
    assert.equal(result.checks[0].passed, false);
    assert.equal(result.checks[0].name, 'DOCTYPE存在');
  });

  it('空文字列で全FAIL', () => {
    const result = checkHtmlValidity('');
    assert.equal(result.status, 'fail');
    assert.equal(result.checks.every(c => !c.passed), true);
  });
});

describe('checkLinks', () => {
  it('空配列でPASS（スキップ扱い）', () => {
    const result = checkLinks([]);
    assert.equal(result.status, 'pass');
    assert.equal(result.summary, 'SKIP（リンク0件）');
  });

  it('有効リンクでPASS', () => {
    const result = checkLinks([{ href: 'https://example.com', text: 'Example' }]);
    assert.equal(result.status, 'pass');
  });

  it('href空でFAIL', () => {
    const result = checkLinks([{ href: '', text: '空' }]);
    assert.equal(result.status, 'fail');
    assert.equal(result.checks[0].passed, false);
  });

  it('nullでPASS（undefined扱い）', () => {
    const result = checkLinks(null);
    assert.equal(result.status, 'pass');
  });
});

describe('checkSeoMeta', () => {
  it('適切な値でPASS', () => {
    const result = checkSeoMeta({
      title: '展示会ブース制作【オージャスト】2026年 SDGs対応リユースブースのご案内',
      description: '株式会社オージャストが提供する展示会ブース制作サービスのご案内です。ブースデザインから設営・撤去までワンストップで対応いたします。SDGs対応のリユースブース（Reブース）で従来比コスト40％削減とCO2排出量77％削減を実現。まずは無料相談・お見積りをお申し込みください。',
      h1Count: 1,
      hasCanonical: true,
      hasOgTitle: true
    });
    assert.equal(result.status, 'pass');
  });

  it('title無しでFAIL', () => {
    const result = checkSeoMeta({
      title: '',
      description: 'a'.repeat(140),
      h1Count: 1,
      hasCanonical: true,
      hasOgTitle: true
    });
    assert.equal(result.status, 'fail');
    assert.equal(result.checks[0].passed, false);
  });

  it('description超過でWARN（重大違反無し）', () => {
    const result = checkSeoMeta({
      title: '展示会ブース制作【オージャスト】2026年 SDGs対応リユースブースのご案内',
      description: 'a'.repeat(200),
      h1Count: 1,
      hasCanonical: true,
      hasOgTitle: true
    });
    assert.equal(result.status, 'warn');
  });

  it('h1無しでFAIL', () => {
    const result = checkSeoMeta({
      title: '30字以上60字以内の適切なタイトル文',
      description: '120字以上を確保したテスト用メタディスクリプションです。',
      h1Count: 0,
      hasCanonical: true,
      hasOgTitle: true
    });
    assert.equal(result.status, 'fail');
  });
});

describe('checkPerformance', () => {
  it('適正値でPASS', () => {
    const result = checkPerformance({ htmlSize: 10000, imageCount: 5 });
    assert.equal(result.status, 'pass');
  });

  it('HTML超過でWARN', () => {
    const result = checkPerformance({ htmlSize: 100000, imageCount: 5 });
    assert.equal(result.status, 'warn');
  });

  it('画像超過でWARN', () => {
    const result = checkPerformance({ htmlSize: 10000, imageCount: 25 });
    assert.equal(result.status, 'warn');
  });

  it('両方超過でWARN', () => {
    const result = checkPerformance({ htmlSize: 100000, imageCount: 30 });
    assert.equal(result.status, 'warn');
  });
});

describe('checkStructure', () => {
  it('正しい見出し階層でPASS', () => {
    const result = checkStructure({
      headings: [{ level: 1, text: 'H1' }, { level: 2, text: 'H2' }, { level: 3, text: 'H3' }],
      images: [{ hasAlt: true }, { hasAlt: true }]
    });
    assert.equal(result.status, 'pass');
  });

  it('h1→h3飛び越しでFAIL', () => {
    const result = checkStructure({
      headings: [{ level: 1, text: 'H1' }, { level: 3, text: 'H3（飛び越し）' }],
      images: []
    });
    assert.equal(result.status, 'fail');
    assert.equal(result.checks[0].passed, false);
  });

  it('alt欠落画像でFAIL', () => {
    const result = checkStructure({
      headings: [{ level: 1, text: 'H1' }],
      images: [{ hasAlt: false }]
    });
    assert.equal(result.status, 'fail');
    assert.equal(result.checks[1].passed, false);
  });
});

describe('checkWcagBasic', () => {
  it('適正要素でPASS', () => {
    const result = checkWcagBasic([
      { tag: 'a', hasAlt: false, tabindex: 0 },
      { tag: 'img', hasAlt: true, tabindex: -1 },
      { tag: 'button', hasAlt: false, tabindex: 0 }
    ]);
    assert.equal(result.status, 'pass');
  });

  it('alt欠落imgでWARN', () => {
    const result = checkWcagBasic([
      { tag: 'img', hasAlt: false, tabindex: -1 }
    ]);
    assert.equal(result.checks[0].passed, true); // tabindex OK
    assert.equal(result.checks[1].passed, false); // alt欠落
    assert.equal(result.status, 'warn');
  });

  it('空配列でPASS', () => {
    const result = checkWcagBasic([]);
    assert.equal(result.status, 'pass');
  });
});