#!/usr/bin/env node
/**
 * Phase 3: キーワード評価と優先順位付け
 *
 * 収集したキーワードを検索意図で分類し、ビジネス価値を考慮して優先順位付けする。
 * スコアに基づいて推奨アクション（新規記事作成 / 既存ページ改善 / 監視）を割り当てる。
 *
 * 使用法:
 *   node process/phase3-score.mjs
 *   node process/phase3-score.mjs --dry-run <outdir>
 *
 * TODO(codex): 残実装
 * - LLM 意図分類の本格運用化（--use-llm 時のみ tools/llm-ask.mjs 呼出。既定はルールベース）
 *
 * 実装済み: Score = Volume × BusinessValue ÷ Difficulty、降順ソート、CSV出力、推奨アクション割当
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** ルールベースの検索意図分類フォールバック（llm-ask 不可時 / 失敗時） */
export function classifyIntentRule(text) {
  const t = text || '';
  if (/価格|費用|単価|料金|見積|値段/.test(t)) return 'Transactional';
  if (/比較|ランキング|違い|評判|口コミ|事例|選び方|おすすめ|費用相場|費用目安/.test(t)) return 'Commercial';
  if (/とは|意味|メリット|デメリット|基礎|知識|ガイド|やり方|方法|マニュアル/.test(t)) return 'Informational';
  return 'Commercial'; // 展示会ブース制作は受注直結キーワードが中心のため既定は Commercial
}

async function classifyIntent(keyword, useLlm = false) {
  await Promise.resolve();
  if (useLlm) {
    // tools/llm-ask.mjs 経由の LLM 分類（--use-llm 時のみ。dry-run/既定はルールベース）
    const llmAsk = path.join(__dirname, '..', '..', 'tools', 'llm-ask.mjs');
    if (fs.existsSync(llmAsk)) {
      try {
        const { execFile } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const run = promisify(execFile);
        const { stdout } = await run(
          process.execPath,
          [llmAsk, '--provider', 'gemini', '--category', 'classification',
            `以下のキーワードを検索意図で分類してください: Informational / Commercial / Transactional。キーワード: ${keyword}`],
          { timeout: 30000 }
        );
        const m = String(stdout).match(/Transactional|Commercial|Informational/);
        if (m) return m[0];
      } catch {
        // LLM 呼び出し失敗時はルールベースへフォールバック
      }
    }
  }
  return classifyIntentRule(keyword);
}

export function calculateScore(kw, bizValue) {
  // 実装予定: 優先度スコア計算
  // VolumeはGSCが利用不可の場合、推定値（1-100）かプレースホルダ（50）を使用
  const volume = kw.volume || 50;
  const difficulty = kw.difficulty || 30;
  const service = bizValue.services.find(s => s.category === kw.category);
  const businessValue = service ? service.estimated_unit_price * service.close_rate * service.weight : 0;
  return Math.round((volume * businessValue) / Math.max(difficulty, 1));
}

function getRecommendedAction(score, allScores) {
  // スコアのパーセンタイルに基づいて推奨アクションを割り当て
  if (allScores.length === 0) return '監視';
  const sorted = [...allScores].sort((a, b) => b - a);
  const topThreshold = sorted[Math.min(Math.floor(sorted.length * 0.3), sorted.length - 1)];
  const midThreshold = sorted[Math.min(Math.floor(sorted.length * 0.6), sorted.length - 1)];
  if (score >= topThreshold) return '新規記事作成';
  if (score >= midThreshold) return '既存ページ改善';
  return '監視';
}

async function main() {
  const isDryRun = process.argv.includes('--dry-run');
  const dryRunIndex = process.argv.indexOf('--dry-run');
  const outdir = isDryRun && dryRunIndex + 1 < process.argv.length
    ? path.resolve(process.argv[dryRunIndex + 1])
    : null;
  if (isDryRun && !outdir) {
    console.error('Usage: node process/phase3-score.mjs --dry-run <outdir>');
    process.exit(1);
  }

  const kwPath = isDryRun
    ? path.join(outdir, 'raw-keywords.json')
    : path.join(__dirname, '..', 'output', 'raw-keywords.json');
  const keywords = JSON.parse(fs.readFileSync(kwPath, 'utf-8'));
  const bizValuePath = path.join(__dirname, '..', 'data', 'business-value.json');
  const bizValue = JSON.parse(fs.readFileSync(bizValuePath, 'utf-8'));

  const useLlm = process.argv.includes('--use-llm') && !isDryRun;
  const scored = [];
  for (const kw of keywords) {
    const intent = await classifyIntent(kw.text, useLlm);
    const score = calculateScore(kw, bizValue);
    scored.push({
      keyword: kw.text,
      intent,
      category: kw.category,
      volume: kw.volume || 50,
      difficulty: kw.difficulty || 30,
      business_value: bizValue.services.find(s => s.category === kw.category)?.estimated_unit_price || 0,
      score,
    });
  }

  scored.sort((a, b) => b.score - a.score);

  // 推奨アクション割り当て
  const allScores = scored.map(k => k.score);
  const withAction = scored.map(kw => ({
    ...kw,
    recommended_action: getRecommendedAction(kw.score, allScores),
  }));

  const outPath = isDryRun
    ? path.join(outdir, 'keywords-priority.csv')
    : path.join(__dirname, '..', 'output', 'keywords-priority.csv');

  const header = 'priority,keyword,intent,category,volume,difficulty,business_value,score,recommended_action';
  const rows = withAction.map((kw, i) =>
    `${i + 1},${kw.keyword},${kw.intent},${kw.category},${kw.volume},${kw.difficulty},${kw.business_value},${kw.score},${kw.recommended_action}`
  );
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, [header, ...rows].join('\n'));
  console.log(`Phase 3 complete: ${scored.length} keywords scored → ${outPath}`);
}

// 直接実行時のみ main() を走らせる（テストから import された場合は実行しない）
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => {
    console.error('Phase 3 failed:', e.message);
    process.exit(1);
  });
}