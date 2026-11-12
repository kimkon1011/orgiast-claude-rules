import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeSiteDeficiencies } from './site-deficiency-analyzer.mjs';

test('analyzeSiteDeficiencies detects mobile, speed, and SEO deficiencies', () => {
  const deficientHtml = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>競合サイト</title>
      </head>
      <body>
        <h1>サンプル</h1>
        <img src="photo.jpg">
        <script src="main.js"></script>
      </body>
    </html>
  `;

  const report = analyzeSiteDeficiencies(deficientHtml, { target: 'competitor.example.com' });

  assert.equal(report.target, 'competitor.example.com');
  assert.ok(report.overallDeficiencyScore > 40, 'Should detect significant overall deficiencies');
  assert.equal(report.scores.mobile, 30, 'Should flag missing viewport meta & responsive CSS');
  assert.equal(report.scores.speed, 80, 'Should flag unoptimized image and sync script');
  assert.equal(report.scores.seo, 50, 'Should flag missing meta description and JSON-LD');
  assert.ok(report.deficiencyCount >= 5);
  assert.ok(report.pipelinePlan.actions.length > 0);
});

test('analyzeSiteDeficiencies calculates high scores for optimized HTML', () => {
  const optimizedHtml = `
    <!DOCTYPE html>
    <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>株式会社オージャスト | 展示会ブース制作</title>
        <meta name="description" content="株式会社オージャストの展示会ブース制作・企画設計施工サービス。">
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Organization",
            "name": "株式会社オージャスト"
          }
        </script>
        <style>
          .container { display: flex; flex-direction: column; }
          @media (min-width: 768px) { .container { flex-direction: row; } }
        </style>
        <script src="app.js" defer></script>
      </head>
      <body>
        <div class="container">
          <h1>展示会ブース制作サービス</h1>
          <img src="booth.webp" loading="lazy" alt="展示会ブース施工例">
        </div>
      </body>
    </html>
  `;

  const report = analyzeSiteDeficiencies(optimizedHtml, { target: 'orgiast.jp' });

  assert.equal(report.overallDeficiencyScore, 0, 'Should have 0 deficiency score for optimized HTML');
  assert.equal(report.scores.mobile, 100);
  assert.equal(report.scores.speed, 100);
  assert.equal(report.scores.seo, 100);
  assert.equal(report.deficiencyCount, 0);
});
