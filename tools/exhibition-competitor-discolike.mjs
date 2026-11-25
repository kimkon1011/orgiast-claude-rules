#!/usr/bin/env node
/**
 * 展示会ブース競合調査 - DiscoLike類似企業検索
 * AIニュース提案 [X-0020] Step 2-3
 *
 * 使い方:
 *   1. DISCOLIKE_API_KEY 環境変数を設定
 *   2. node tools/exhibition-competitor-discolike.mjs
 *
 * 前提: DiscoLike APIキー発行済み (https://docs.discolike.com/api/access/)
 * 出力: auto-session-repo/research/discolike-results-{{date}}.json
 */

const API_KEY = process.env.DISCOLIKE_API_KEY;
if (!API_KEY) {
  console.error("DISCOLIKE_API_KEY が設定されていません");
  console.error("1. https://docs.discolike.com/api/access/ からAPIキーを発行");
  console.error("2. export DISCOLIKE_API_KEY=your_key_here");
  process.exit(1);
}

const TARGET_DOMAINS = [
  "threeb.co.jp",       // スリービー（中小・SEO強い）
  "tohgashi.co.jp",     // トーガシ（中堅・年間3000件）
  "box1.co.jp",         // ボックス・ワン（中堅・25.5億）
  "fujiya-net.co.jp",   // フジヤ（大規模・参考ベンチマーク）
  "sakurain.co.jp",     // サクラインターナショナル（海外・SRDS）
];

async function main() {
  // --- 件数確認（課金回避）---
  console.log("=== count-matching-domains ===");
  const countRes = await fetch(
    `https://api.discolike.com/v1/count?domain=${TARGET_DOMAINS.map(d => `domain=${d}`).join('&')}&employee_range=1,500&country=JP`,
    { headers: { "X-API-Key": API_KEY } }
  );
  const count = await countRes.json();
  console.log(`ヒット件数: ${count.total} 件`);
  console.log(`課金見込み: ${count.new_records} 件（新規のみ課金）`);

  // --- 類似企業検索 ---
  console.log("\n=== discover-similar-companies ===");
  const params = new URLSearchParams();
  TARGET_DOMAINS.forEach(d => params.append("domain", d));
  params.set("employee_range", "1,500");
  params.set("country", "JP");
  params.set("max_records", "500");
  params.set("format", "json");

  const discoverRes = await fetch(
    `https://api.discolike.com/v1/discover?${params.toString()}`,
    { headers: { "X-API-Key": API_KEY } }
  );
  const data = await discoverRes.json();

  // --- 結果をファイル保存 ---
  const date = new Date().toISOString().split('T')[0].replace(/-/g, '');
  const fs = await import('fs');
  const outPath = `research/discolike-results-${date}.json`;
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2));
  console.log(`\n結果保存: ${outPath}`);
  console.log(`取得件数: ${data.companies?.length || 0} 社`);

  // --- 簡易サマリ ---
  if (data.companies?.length) {
    console.log("\n=== 上位10社 ===");
    data.companies.slice(0, 10).forEach((c, i) => {
      console.log(`${i+1}. ${c.name} (${c.domain}) - 類似度: ${c.similarity}`);
    });
  }
}

main().catch(e => {
  console.error("エラー:", e.message);
  process.exit(1);
});