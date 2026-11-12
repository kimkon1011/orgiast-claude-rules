#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

/**
 * Analyzes website HTML or site specs for deficiencies in:
 * 1. Mobile responsiveness (viewport meta, responsive styles)
 * 2. Page speed / asset optimization (image lazy loading, script defer, webp)
 * 3. SEO & Content completeness (meta tags, JSON-LD, case studies, FAQ)
 *
 * Returns deficiency scores and actionable improvement recommendations.
 */
export function analyzeSiteDeficiencies(htmlContent, options = {}) {
  const deficiencies = [];
  let mobileScore = 100;
  let speedScore = 100;
  let seoScore = 100;

  // 1. Mobile Responsiveness Check
  if (!htmlContent.includes('<meta name="viewport"')) {
    mobileScore -= 40;
    deficiencies.push({
      category: 'mobile',
      severity: 'high',
      issue: 'Missing viewport meta tag for mobile responsiveness',
      recommendation: 'Add <meta name="viewport" content="width=device-width, initial-scale=1.0">'
    });
  }
  if (!htmlContent.includes('@media') && !htmlContent.includes('flex') && !htmlContent.includes('grid')) {
    mobileScore -= 30;
    deficiencies.push({
      category: 'mobile',
      severity: 'medium',
      issue: 'Lack of responsive CSS layout (media queries, flexbox, or grid)',
      recommendation: 'Implement CSS Flexbox/Grid and responsive breakpoints'
    });
  }

  // 2. Speed / Performance Check
  const imgTags = htmlContent.match(/<img[^>]*>/gi) || [];
  const unoptimizedImgs = imgTags.filter(img => !img.includes('loading="lazy"') && !img.includes('.webp') && !img.includes('.svg'));
  if (unoptimizedImgs.length > 0) {
    speedScore -= Math.min(40, unoptimizedImgs.length * 10);
    deficiencies.push({
      category: 'speed',
      severity: 'medium',
      issue: `${unoptimizedImgs.length} images lack lazy loading or WebP format`,
      recommendation: 'Convert images to WebP and add loading="lazy" attributes'
    });
  }
  const syncScripts = (htmlContent.match(/<script[^>]*src=[^>]*>/gi) || []).filter(s => !s.includes('async') && !s.includes('defer'));
  if (syncScripts.length > 0) {
    speedScore -= Math.min(30, syncScripts.length * 10);
    deficiencies.push({
      category: 'speed',
      severity: 'medium',
      issue: `${syncScripts.length} blocking synchronous script tags detected`,
      recommendation: 'Add defer or async attributes to external script tags'
    });
  }

  // 3. SEO & Content Deficiency Check
  if (!htmlContent.includes('<title>') || htmlContent.includes('<title></title>')) {
    seoScore -= 30;
    deficiencies.push({
      category: 'seo',
      severity: 'high',
      issue: 'Missing or empty title tag',
      recommendation: 'Provide concise, keyword-optimized page title'
    });
  }
  if (!htmlContent.includes('name="description"')) {
    seoScore -= 20;
    deficiencies.push({
      category: 'seo',
      severity: 'high',
      issue: 'Missing meta description tag',
      recommendation: 'Add meta description (120-160 chars) summarizing page value proposition'
    });
  }
  if (!htmlContent.includes('application/ld+json')) {
    seoScore -= 30;
    deficiencies.push({
      category: 'seo',
      severity: 'medium',
      issue: 'Missing JSON-LD structured data (Organization, FAQPage, or Service)',
      recommendation: 'Embed schema.org JSON-LD structured data for Google & AI search discovery'
    });
  }

  const overallDeficiencyScore = Math.round(100 - (mobileScore * 0.35 + speedScore * 0.35 + seoScore * 0.30));

  return {
    target: options.target || 'site-sample',
    timestamp: new Date().toISOString(),
    overallDeficiencyScore, // 0 = perfect, 100 = severe deficiencies
    scores: {
      mobile: Math.max(0, mobileScore),
      speed: Math.max(0, speedScore),
      seo: Math.max(0, seoScore)
    },
    deficiencyCount: deficiencies.length,
    deficiencies,
    pipelinePlan: {
      builder: 'Claude Code CLI + Cloudflare Pages',
      actions: [
        'Generate responsive HTML/CSS scaffold',
        'Optimize assets with WebP and lazy loading',
        'Add JSON-LD structured data schemas',
        'Host on Cloudflare Pages global CDN'
      ]
    }
  };
}

// CLI handler
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename || '')) {
  const args = process.argv.slice(2);
  let targetArg = 'sample';
  let outputArg = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--target' && args[i + 1]) {
      targetArg = args[i + 1];
      i++;
    } else if (args[i] === '--output' && args[i + 1]) {
      outputArg = args[i + 1];
      i++;
    }
  }

  let sampleHtml = `
    <html>
      <head>
        <title>競合ブース制作会社</title>
      </head>
      <body>
        <h1>展示会ブース施工</h1>
        <img src="booth1.jpg">
        <script src="app.js"></script>
      </body>
    </html>
  `;

  if (fs.existsSync(targetArg)) {
    sampleHtml = fs.readFileSync(targetArg, 'utf-8');
  }

  const report = analyzeSiteDeficiencies(sampleHtml, { target: targetArg });

  if (outputArg) {
    fs.mkdirSync(path.dirname(outputArg), { recursive: true });
    fs.writeFileSync(outputArg, JSON.stringify(report, null, 2), 'utf-8');
    console.log(`Report written to ${outputArg}`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
}
