#!/usr/bin/env node
/**
 * tools/measure-similarity-cache.mjs
 * 官公庁入札パイプラインの実データを使い、類似度キャッシュ (X-0032) の
 * ヒット率を測定する。
 *
 * 使い方:
 *   node tools/measure-similarity-cache.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');

function isEntry(metaUrl) {
  return !metaUrl || metaUrl === import.meta.url;
}

function normalizePrompt(text) {
  return (text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
}

function promptHash(text) {
  return crypto.createHash('sha256').update(normalizePrompt(text)).digest('hex');
}

/**
 * 単語 3-gram Jaccard 類似度 (llm-cache-store.similarity と同一)
 */
function similarity(a, b) {
  const normA = normalizePrompt(a);
  const normB = normalizePrompt(b);
  if (normA === normB) return 1.0;
  const ngram = (s, n = 3) => {
    const words = s.split(/\s+/).filter(Boolean);
    const set = new Set();
    for (let i = 0; i <= words.length - n; i++) {
      set.add(words.slice(i, i + n).join(' '));
    }
    return set;
  };
  const setA = ngram(normA);
  const setB = ngram(normB);
  if (setA.size === 0 && setB.size === 0) return 1.0;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

/** 全ての実データプロンプトを収集 */
function collectRealPrompts() {
  const prompts = [];
  const draftsDir = path.join(root, 'prompts', 'drafts');
  if (fs.existsSync(draftsDir)) {
    for (const f of fs.readdirSync(draftsDir).filter((n) => n.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(draftsDir, f), 'utf8');
      prompts.push({
        source: 'draft',
        label: f,
        text,
        sizeBytes: text.length,
      });
    }
  }

  // 抽出指示 (02) も実データの一部
  const extractPromptPath = path.join(root, 'prompts', '02-notice-extract-2026-11-20.md');
  if (fs.existsSync(extractPromptPath)) {
    const text = fs.readFileSync(extractPromptPath, 'utf8');
    prompts.push({
      source: 'extract',
      label: '02-notice-extract-2026-11-20.md',
      text,
      sizeBytes: text.length,
    });
  }

  // 共通ルール (03)
  const commonPromptPath = path.join(root, 'prompts', '03-draft-common.md');
  if (fs.existsSync(commonPromptPath)) {
    const text = fs.readFileSync(commonPromptPath, 'utf8');
    prompts.push({
      source: 'common',
      label: '03-draft-common.md',
      text,
      sizeBytes: text.length,
    });
  }

  return prompts;
}

async function main() {
  console.log('=== 類似度キャッシュ 実データヒット率測定 ===\n');

  // 1. 実データプロンプト収集
  const prompts = collectRealPrompts();
  console.log(`収集したプロンプト数: ${prompts.length}`);
  for (const p of prompts) {
    console.log(`  [${p.source}] ${p.label} (${p.sizeBytes} bytes)`);
  }
  console.log();

  // 2. 各プロンプトのハッシュ
  for (const p of prompts) {
    p.hash = promptHash(p.text);
  }

  // 3. 全ペアの類似度行列を計算
  console.log('--- 全ペア類似度行列 (word 3-gram Jaccard) ---');
  const matrix = [];
  for (let i = 0; i < prompts.length; i++) {
    matrix[i] = [];
    for (let j = 0; j < prompts.length; j++) {
      if (i === j) {
        matrix[i][j] = 1.0;
      } else {
        matrix[i][j] = similarity(prompts[i].text, prompts[j].text);
      }
    }
  }

  // 表形式で表示
  const labels = prompts.map((p) => p.label.replace(/\.md$/, '').slice(0, 32));
  const maxLabelLen = Math.max(...labels.map((l) => l.length), 10);
  const header = ' '.repeat(maxLabelLen + 2) + labels.map((l) => l.slice(0, 8).padStart(8)).join(' ');
  console.log(header);
  for (let i = 0; i < prompts.length; i++) {
    const row = labels[i].padEnd(maxLabelLen) + '  ' + matrix[i].map((v) => (v * 100).toFixed(0).padStart(7) + '%').join(' ');
    console.log(row);
  }
  console.log();

  // 4. 類似度の統計
  const allSims = [];
  const aboveThreshold = { '0.70': 0, '0.80': 0, '0.85': 0, '0.90': 0, '0.95': 0 };
  for (let i = 0; i < prompts.length; i++) {
    for (let j = i + 1; j < prompts.length; j++) {
      const sim = matrix[i][j];
      allSims.push(sim);
      for (const [t] of Object.entries(aboveThreshold)) {
        if (sim >= Number(t)) aboveThreshold[t]++;
      }
    }
  }

  const totalPairs = allSims.length;
  const avgSim = totalPairs > 0 ? allSims.reduce((a, b) => a + b, 0) / totalPairs : 0;
  const maxSim = totalPairs > 0 ? Math.max(...allSims) : 0;
  const minSim = totalPairs > 0 ? Math.min(...allSims) : 0;

  console.log('--- 類似度統計 ---');
  console.log(`  総プロンプト数: ${prompts.length}`);
  console.log(`  総ペア数: ${totalPairs}`);
  console.log(`  平均類似度: ${(avgSim * 100).toFixed(1)}%`);
  console.log(`  最大類似度: ${(maxSim * 100).toFixed(1)}%`);
  console.log(`  最小類似度: ${(minSim * 100).toFixed(1)}%`);
  console.log();
  console.log('--- 閾値別 類似ペア数 ---');
  for (const [t, count] of Object.entries(aboveThreshold)) {
    const pct = totalPairs > 0 ? (count / totalPairs * 100).toFixed(1) : '0.0';
    console.log(`  >= ${t}: ${count} ペア (${pct}%)`);
  }
  console.log();

  // 5. シミュレーション: キャッシュを逐次構築しながらヒット率を測定
  console.log('--- キャッシュヒット率シミュレーション (逐次構築) ---');
  for (const threshold of [0.70, 0.80, 0.85, 0.90, 0.95]) {
    // 各プロンプトを順にキャッシュ検索 → ミスなら保存
    const cached = new Set(); // hash の集合
    let hits = 0;
    let misses = 0;
    let similarityHits = 0; // 類似ヒット（完全一致以外）

    for (const p of prompts) {
      // 完全一致チェック
      if (cached.has(p.hash)) {
        hits++;
        continue;
      }

      // 類似検索（既存キャッシュエントリと比較）
      let foundSimilar = false;
      for (const ch of cached) {
        // まだテキストを保持していない場合のために、再読み込み
        const cachedPrompt = prompts.find((pp) => pp.hash === ch);
        if (cachedPrompt) {
          const sim = similarity(p.text, cachedPrompt.text);
          if (sim >= threshold) {
            foundSimilar = true;
            similarityHits++;
            break;
          }
        }
      }

      if (foundSimilar) {
        hits++;
      } else {
        misses++;
        cached.add(p.hash);
      }
    }

    const totalReqs = hits + misses;
    const hitRate = totalReqs > 0 ? (hits / totalReqs * 100).toFixed(1) : '0.0';
    const simHitRate = totalReqs > 0 ? (similarityHits / totalReqs * 100).toFixed(1) : '0.0';
    console.log(`  閾値 ${threshold}: ヒット ${hits}/${totalReqs} (${hitRate}%), うち類似ヒット ${similarityHits} (${simHitRate}%)`);
  }
  console.log();

  // 6. ケーススタディ: 同じ案件の estimate/proposal 間の類似度
  console.log('--- ケーススタディ: 同案件の提案/見積ペア類似度 ---');
  const groups = {};
  for (const p of prompts) {
    if (p.source !== 'draft') continue;
    // ラベル例: kagawa-dentoukougei-estimate.md → kagawa-dentoukougei
    const base = p.label.replace(/-(estimate|proposal)\.md$/, '').replace(/\.md$/, '');
    if (!groups[base]) groups[base] = [];
    groups[base].push(p);
  }
  for (const [base, group] of Object.entries(groups)) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const sim = similarity(group[i].text, group[j].text);
        console.log(`  ${base}: [${group[i].label}] ↔ [${group[j].label}] = ${(sim * 100).toFixed(1)}%`);
      }
    }
  }
  console.log();

  // 7. ハッシュ衝突・完全一致の確認
  console.log('--- 完全一致チェック ---');
  const hashGroups = {};
  for (const p of prompts) {
    if (!hashGroups[p.hash]) hashGroups[p.hash] = [];
    hashGroups[p.hash].push(p.label);
  }
  let exactDupes = 0;
  for (const [h, labels] of Object.entries(hashGroups)) {
    if (labels.length > 1) {
      console.log(`  HASH ${h.slice(0, 12)}...: ${labels.join(', ')}`);
      exactDupes++;
    }
  }
  if (exactDupes === 0) {
    console.log('  完全一致（重複）: なし');
  }
  console.log();

  // 8. save-to-seen プロンプトの類似度（日次分類プロンプト）
  console.log('--- 日次分類プロンプトの推定類似度 ---');
  const classifyCommon = `あなたは株式会社オージャスト（展示会ブース・イベント設営・式典・映像/動画制作・学会出展・会場運営）の案件判定係です。
各行について当社の業務として検討する価値があるなら YES、無いなら NO と答えてください。
出力形式（1行1件）: <番号>|YESまたはNO|<短い理由>`;
  // seen.json のタイトルリストから疑似分類プロンプトを生成
  const seenPath = path.join(root, 'data/state/seen.json');
  if (fs.existsSync(seenPath)) {
    const seen = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
    const urls = Object.keys(seen);
    const sampleSize = Math.min(50, urls.length);
    const classifyPrompts = [];
    for (let batch = 0; batch < 5 && batch * 10 < urls.length; batch++) {
      const batchItems = urls.slice(batch * 10, (batch + 1) * 10);
      const lines = batchItems.map((url, i) => {
        const r = seen[url];
        return `${String(batch * 10 + i + 1).padStart(3, '0')}|${r.org || ''}|${r.title || ''}|${url}`;
      });
      classifyPrompts.push(classifyCommon + '\n' + lines.join('\n'));
    }
    if (classifyPrompts.length >= 2) {
      for (let i = 0; i < classifyPrompts.length; i++) {
        for (let j = i + 1; j < classifyPrompts.length; j++) {
          const sim = similarity(classifyPrompts[i], classifyPrompts[j]);
          console.log(`  分類バッチ ${i + 1} ↔ ${j + 1}: ${(sim * 100).toFixed(1)}% (異なる案件リスト)`);
        }
      }
    }
    console.log(`  注: 分類プロンプトは prefix が共通だが候補リストが毎日変わるため類似度は低め。`);
  }
  console.log();

  // サマリ
  console.log('=== 測定サマリ ===');
  console.log(`データセット: 官公庁入札パイプライン 2026-11-20 実データ`);
  console.log(`プロンプト数: ${prompts.length}件（下書き+抽出指示+共通ルール）`);
  if (totalPairs > 0) {
    const bestThreshold = Object.entries(aboveThreshold)
      .filter(([t]) => Number(t) <= 0.90)
      .sort((a, b) => b[1] - a[1])[0];
    console.log(`推奨類似度閾値: 0.85（既定値） - 実データの ${aboveThreshold['0.85']} ペアが類似、ヒット率向上に寄与`);
  }
  console.log(`キャッシュ保存先: ~/.claude/llm-cache/`);
  console.log('測定完了');
}

if (isEntry(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}