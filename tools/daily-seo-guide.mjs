#!/usr/bin/env node
/**
 * daily-seo-guide.mjs — 毎朝1本SEOガイド生成ワークフロー
 *
 * X-0011: gumツールで毎朝1本のSEOガイド作成
 *
 * 流れ:
 * 1. GSC Keyword Finder で高IMP低CTRキーワードを取得
 * 2. 展示会ブース関連キーワードを優先選択
 * 3. codex-do 経由でLLMにSEOガイドを生成させる
 * 4. 内部リンクを追加
 * 5. WordPress 下書きとして保存
 *
 * 使い方:
 *   node tools/daily-seo-guide.mjs [--dry-run] [--keyword "自由記入"]
 *     [--site https://www.orgiast.jp] [--publish-draft]
 */

import { execSync } from 'child_process';
import { existsSync, writeFileSync, mkdirSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ===== 設定 =====
const CONFIG = {
  siteUrl: 'https://www.orgiast.jp',
  outputDir: resolve(REPO_ROOT, 'outputs', 'X-0011', 'guides'),
  codexDoPath: resolve(REPO_ROOT, 'tools', 'codex-do.mjs'),
  guideTemplatePath: resolve(REPO_ROOT, 'outputs', 'X-0011', 'guide-template.md'),
};

// ===== ガイド生成プロンプト =====
function buildGuidePrompt(keyword, siteUrl) {
  return `あなたは展示会ブース制作の専門SEOライターです。
以下のキーワードで、株式会社オージャスト（https://www.orgiast.jp）のサイトに掲載する
SEOガイド記事を1本作成してください。

## ターゲットキーワード
「${keyword}」

## 記事の要件
1. タイトル: キーワードを含む30〜50字のSEOタイトル
2. meta description: 120字以内
3. 本文: 2,000〜3,000字（マークダウン形式）
4. 構成: h2見出しを3〜5個、h3見出しを適宜
5. CTA: 最後に「まずはお気軽にご相談ください」系のCTAを自然に配置
6. 内部リンク: 以下のプレースホルダを含める
   - [実績事例への内部リンク: /event/XXXX]
   - [制作ガイドへの内部リンク: /topics/XXXX]
   - [サービス案内への内部リンク: /event]
7. 専門性: 展示会ブース業界の実践的アドバイスを含める
8. オリジナリティ: 一般的なSEO記事の焼き直しではなく、施工会社ならではの知見を前面に

## 出力形式
最初に --- で区切ったYAML frontmatter、その後に本文。
---
title: "記事タイトル"
description: "meta description"
keyword: "${keyword}"
target_audience: "展示会出展を検討中の企業マーケ担当者"
word_count: 2500
---

[ここに本文]`;
}

// ===== 内部リンク解決 =====
async function resolveInternalLinks(markdownBody, siteUrl) {
  // sitemap.xml から内部リンク候補を取得
  let sitemapUrls = [];
  try {
    const resp = await fetch(`${siteUrl}/sitemap.xml`);
    const xml = await resp.text();
    // 簡易パース: <loc> タグからURL抽出
    const locs = xml.match(/<loc>(.*?)<\/loc>/g) || [];
    sitemapUrls = locs.map(l => l.replace(/<\/?loc>/g, '').trim());
  } catch (e) {
    console.error('⚠ sitemap.xml 取得失敗:', e.message);
    return markdownBody;
  }

  // プレースホルダを実際のURLに置換
  let result = markdownBody;

  // 実績事例リンク
  const eventUrls = sitemapUrls.filter(u => u.includes('/event/'));
  if (eventUrls.length > 0 && result.includes('[実績事例への内部リンク')) {
    const pick = eventUrls[Math.floor(Math.random() * eventUrls.length)];
    result = result.replace(/\[実績事例への内部リンク:.*?\]/, `[施工実績](${pick})`);
  }

  // 制作ガイドリンク
  const topicUrls = sitemapUrls.filter(u => u.includes('/topics/'));
  if (topicUrls.length > 0 && result.includes('[制作ガイドへの内部リンク')) {
    const pick = topicUrls[Math.floor(Math.random() * topicUrls.length)];
    result = result.replace(/\[制作ガイドへの内部リンク:.*?\]/, `[制作ノウハウ](${pick})`);
  }

  // サービス案内リンク
  if (result.includes('[サービス案内への内部リンク')) {
    result = result.replace(/\[サービス案内への内部リンク:.*?\]/, `[ブース制作サービス](${siteUrl}/event)`);
  }

  return result;
}

// ===== WordPress 下書き投稿 =====
async function publishDraft(title, content) {
  // WordPress REST API で下書き保存
  const wpApiUrl = `${CONFIG.siteUrl}/wp-json/wp/v2/posts`;
  const wpUser = process.env.WP_USER;
  const wpAppPassword = process.env.WP_APP_PASSWORD;

  if (!wpUser || !wpAppPassword) {
    console.error('⚠ WordPress 認証情報なし (WP_USER / WP_APP_PASSWORD) — 下書き保存スキップ');
    console.log('   下書き内容:', CONFIG.outputDir);
    return null;
  }

  const auth = Buffer.from(`${wpUser}:${wpAppPassword}`).toString('base64');

  try {
    const resp = await fetch(wpApiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
      body: JSON.stringify({
        title,
        content,
        status: 'draft',
      }),
    });

    if (!resp.ok) {
      const errBody = await resp.text();
      throw new Error(`WordPress API error ${resp.status}: ${errBody}`);
    }

    const post = await resp.json();
    console.error(`✅ 下書き保存完了: ${post.link}`);
    return post;
  } catch (e) {
    console.error('❌ WordPress投稿失敗:', e.message);
    return null;
  }
}

// ===== メイン =====
async function main() {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const shouldPublish = args.includes('--publish-draft');
  const forceKeyword = args.includes('--keyword') ? args[args.indexOf('--keyword') + 1] : null;

  const siteUrl = args.includes('--site') ? args[args.indexOf('--site') + 1] : CONFIG.siteUrl;

  console.error('='.repeat(50));
  console.error(`📅 日次SEOガイド生成ワークフロー`);
  console.error(`   日付: ${new Date().toISOString().split('T')[0]}`);
  console.error(`   サイト: ${siteUrl}`);
  console.error(`   Dry-run: ${isDryRun}`);
  console.error(`   公開: ${shouldPublish}`);
  console.error('='.repeat(50));

  // Step 1: キーワード取得
  let keyword = forceKeyword;
  if (!keyword) {
    console.error('\n🔍 Step 1: GSCから高IMP低CTRキーワードを取得...');
    try {
      const gscResult = execSync(
        `process.execPath "${CONFIG.codexDoPath}" "GSC高IMP低CTRキーワード分析を実行" --kind investigate --cwd "${REPO_ROOT}" --origin unattended`,
        { encoding: 'utf8', timeout: 120000, windowsHide: true }
      );
      console.error('   GSC結果:', gscResult.slice(0, 500));
    } catch (e) {
      console.error('   GSC取得失敗:', e.message);
      console.error('   フォールバック: 汎用キーワードを使用');
    }
  }

  // Step 2: キーワード決定
  if (!keyword) {
    // フォールバック: 展示会ブース関連の汎用キーワード
    const fallbackKeywords = [
      '展示会ブース制作 費用 相場',
      '大阪 展示会ブース デザイン',
      '初めての展示会出展 準備ガイド',
      '小規模ブース 集客 レイアウト',
      '展示会 施工会社 選び方',
    ];
    keyword = fallbackKeywords[new Date().getDate() % fallbackKeywords.length];
  }
  console.error(`\n🎯 Step 2: 選定キーワード = "${keyword}"`);

  // Step 3: SEOガイド生成
  console.error('\n✍️  Step 3: SEOガイド生成中...');
  const prompt = buildGuidePrompt(keyword, siteUrl);

  let guideContent;
  try {
    const result = execSync(
      `process.execPath "${CONFIG.codexDoPath}" "${prompt.replace(/"/g, '\\"')}" --kind implement --cwd "${REPO_ROOT}" --origin unattended`,
      { encoding: 'utf8', timeout: 300000, windowsHide: true }
    );
    guideContent = result;
  } catch (e) {
    console.error('   codex-do 実行失敗:', e.message);
    // フォールバック: 簡易ガイド生成
    guideContent = `---
title: "${keyword}の完全ガイド"
description: "${keyword}について詳しく解説します。"
keyword: "${keyword}"
---
# ${keyword}

## はじめに

${keyword}について、展示会ブース制作の専門会社が詳しく解説します。

## ${keyword}の基礎知識

展示会出展を成功させるには、${keyword}の理解が不可欠です。

[まずはお気軽にご相談ください](https://www.orgiast.jp/contact)
`;
  }

  // Step 4: 内部リンク解決
  console.error('\n🔗 Step 4: 内部リンク解決中...');
  const finalContent = await resolveInternalLinks(guideContent, siteUrl);

  // Step 5: 保存
  console.error('\n💾 Step 5: 保存中...');
  mkdirSync(CONFIG.outputDir, { recursive: true });

  const dateStr = new Date().toISOString().split('T')[0];
  const slug = keyword.replace(/[\s　]+/g, '-').replace(/[^\w-]/g, '').slice(0, 50);
  const outputPath = resolve(CONFIG.outputDir, `${dateStr}-${slug}.md`);
  writeFileSync(outputPath, finalContent, 'utf8');
  console.error(`   保存先: ${outputPath}`);

  // Step 6: WordPress 公開（任意）
  if (shouldPublish && !isDryRun) {
    console.error('\n🚀 Step 6: WordPress 下書き保存...');
    const titleMatch = finalContent.match(/^title:\s*"(.*)"/m);
    const title = titleMatch ? titleMatch[1] : keyword;
    const bodyMatch = finalContent.match(/---\n[\s\S]*?---\n([\s\S]*)/);
    const body = bodyMatch ? bodyMatch[1] : finalContent;

    await publishDraft(title, body);
  }

  // サマリ
  console.error('\n' + '='.repeat(50));
  console.error(`✅ 完了`);
  console.error(`   キーワード: ${keyword}`);
  console.error(`   出力: ${outputPath}`);
  console.error(`   文字数: ${finalContent.length}`);
  if (isDryRun) console.error('   モード: Dry Run（保存のみ）');
  if (forceKeyword) console.error('   キーワード: 指定値');
  console.error('='.repeat(50));
}

main().catch(err => {
  console.error('❌ 致命的エラー:', err.message);
  process.exit(1);
});
