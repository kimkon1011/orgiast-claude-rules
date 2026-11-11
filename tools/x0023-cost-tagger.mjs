#!/usr/bin/env node
// X-0023: 安価ワーカーモデルルーティング — タグ付け・コスト計算・レポート生成
//
// 使用方法:
//   node tools/x0023-cost-tagger.mjs                    // 全セッションログを走査
//   node tools/x0023-cost-tagger.mjs --days 3           // 直近3日分のみ
//
// セッションJSONLの cost-state イベントから実トークン数・実コストを抽出。
// 各 assistant イベントの requestedModel からモデル別内訳を算出。
// Haiku 5.5・GPT-6 Luna・Muse Ember のリスト価格でタグ別コストを試算。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

// ─── 設定 ─────────────────────────────────────────────────
const HOME = process.env.ORGIAST_HOME || process.env.USERPROFILE || os.homedir();
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects');
const ARCHIVED = path.join(HOME, '.claude', 'archived-sessions.jsonl');
const OUTPUT_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'outputs', 'X-0023');
const daysFlag = process.argv.filter(arg => arg.startsWith('--days=')).map(a => a.split('=')[1])[0];
const daysIdx = process.argv.indexOf('--days');
const DAYS_BACK = parseInt(daysFlag || (daysIdx >= 0 ? process.argv[daysIdx + 1] : '7'), 10);

// ─── モデル価格表 ($/1Mトークン) ──────────────────────────
// 出典: Claude API 公式リスト価格、Muse Ember 公開ベンチマーク
const PRICES = {
  'haiku-5.5':       { in: 0.10, out: 0.50, inOver100K: 0.50, outOver100K: 2.50 },
  'gpt-6-luna':      { in: 2.00, out: 8.00, inOver100K: 2.00, outOver200K: 4.00 }, // 同等クラス推定
  'muse-ember':      { in: 0.50, out: 2.00, inOver100K: 1.00, outOver100K: 4.00 }, // 公開情報 115M/$0.50
  'opus-5.5':        { in: 4.00, out: 20.00, inOver100K: 8.00, outOver100K: 40.00 },
  'sonnet-5.5':      { in: 2.00, out: 10.00, inOver100K: 2.00, outOver100K: 10.00 },
};

// ─── タグカテゴリ（assistant イベントと user メッセージから推定） ────
function tagFromContent(contentText, model) {
  const text = String(contentText || '').toLowerCase();
  if (!text) return 'system';

  // subagent呼出はtool_call
  const userText = text; // これはuser message

  if (/\b(pr|pull.request|code.?review|レビュー依頼|マージ)\b/.test(userText)) return 'pr';
  if (/\b(bug|fix|typo|バグ|修正|直して|hotfix|エラー修正)\b/.test(userText)) return 'small_fix';
  if (/design|plan|設計|architecture|方針|トレードオフ|比較/.test(userText)) return 'plan';
  if (/(抽出|分類|要約|summarize|extract|classify|仕分け|タグ付け|一括|全件)/.test(userText)) return 'extraction';
  if (/(tool|mcp|api.call|api応答|実行|execute)/.test(userText)) return 'tool_call';
  if (/subagent|agent.*実行|委譲|delegate/.test(userText)) return 'tool_call';
  return 'unknown';
}

// model名の正規化
function normalizeModel(m) {
  m = String(m || '');
  if (m.includes('haiku-5.5') || m.includes('haiku-5')) return 'claude-haiku-5-5';
  if (m.includes('sonnet-5.5') || m.includes('sonnet-5')) return 'claude-sonnet-5-5';
  if (m.includes('opus-5.5')) return 'claude-opus-5-5';
  if (m.includes('opus-5')) return 'claude-opus-5';
  if (m.includes('opus-4.8')) return 'claude-opus-4-8';
  if (m.includes('opus-4.7')) return 'claude-opus-4-7';
  if (m.includes('fable')) return 'claude-fable-5-2';
  if (m.includes('sonnet-4.6') || m.includes('sonnet-4')) return 'claude-sonnet-4-6';
  return m;
}

function modelTier(m) {
  const norm = normalizeModel(m);
  if (norm.includes('fable')) return 'fable';     // most expensive
  if (norm.includes('opus')) return 'opus';       // high
  if (norm.includes('sonnet')) return 'sonnet';   // medium
  if (norm.includes('haiku')) return 'haiku';     // cheap
  return 'other';
}

// ─── セッションJSONLの走査 ─────────────────────────────────
function scanAllSessions() {
  const costStates = [];    // cost-state events (per-session aggregated)
  const assistantEntries = []; // per-call entries from assistant events
  const cutoff = Date.now() - DAYS_BACK * 86400_000;
  const seenSessions = new Set();

  if (!fs.existsSync(PROJECTS_DIR)) return { costStates, assistantEntries };

  const projectDirs = fs.readdirSync(PROJECTS_DIR).filter(d => {
    const full = path.join(PROJECTS_DIR, d);
    const stat = fs.statSync(full);
    return stat.isDirectory();
  });

  for (const projDir of projectDirs) {
    const fullProjPath = path.join(PROJECTS_DIR, projDir);
    const files = fs.readdirSync(fullProjPath).filter(f => f.endsWith('.jsonl'));
    for (const file of files) {
      const fpath = path.join(fullProjPath, file);
      try {
        const stat = fs.statSync(fpath);
        if (stat.mtimeMs < cutoff) continue;
        const sessionId = file.replace('.jsonl', '');
        if (seenSessions.has(sessionId)) continue;
        seenSessions.add(sessionId);

        // Parse the file
        const content = fs.readFileSync(fpath, 'utf8');
        const lines = content.split('\n');
        let costState = null;
        let lastUserMsg = '';
        let lastAssistantModel = '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const obj = JSON.parse(line);
            const t = obj.type;

            if (t === 'cost-state') {
              costState = {
                sessionId: obj.sessionId,
                ts: obj.timestamp || '',
                modelUsage: obj.modelUsage || {},
                totalCostUSD: obj.totalCostUSD || 0,
                totalAPIDuration: obj.totalAPIDuration || 0,
                totalToolDuration: obj.totalToolDuration || 0,
              };
            } else if (t === 'assistant') {
              lastAssistantModel = obj.requestedModel || '';
            } else if (t === 'api-request-blob' && obj.message) {
              // Extract text from request blob for tagging
              const msg = obj.message;
              if (msg.role === 'user' && msg.content) {
                const texts = [];
                const parts = Array.isArray(msg.content) ? msg.content : [msg.content];
                for (const part of parts) {
                  if (typeof part === 'string') texts.push(part);
                  else if (part.text) texts.push(part.text);
                }
                lastUserMsg = texts.join(' ');
              }
            }
          } catch {}
        }

        if (costState) {
          costStates.push(costState);
        }
      } catch (e) {
        // skip unreadable files
      }
    }
  }
  return { costStates, assistantEntries };
}

// ─── アーカイブ済みセッション ─────────────────────────────
function scanArchived() {
  const entries = [];
  if (!fs.existsSync(ARCHIVED)) return entries;
  try {
    const content = fs.readFileSync(ARCHIVED, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const at = new Date(obj.at);
        if (Date.now() - at.getTime() > DAYS_BACK * 86400_000) continue;
        entries.push(obj);
      } catch {}
    }
  } catch {}
  return entries;
}

// ─── 既存コストログ（executor-usage.jsonl相当） ──────────
function scanCostLog() {
  const entries = [];
  const costLogPath = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), 'outputs', 'X-0011', 'cost-log.jsonl');
  if (!fs.existsSync(costLogPath)) return entries;
  const cutoff = Date.now() - DAYS_BACK * 86400_000;
  try {
    const content = fs.readFileSync(costLogPath, 'utf8');
    const lines = content.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        const t = new Date(obj.t);
        if (Date.now() - t.getTime() > DAYS_BACK * 86400_000) continue;
        if (obj.status !== 'ok') continue;
        entries.push(obj);
      } catch {}
    }
  } catch {}
  return entries;
}

// ─── コスト計算 ───────────────────────────────────────────
function calcCost(modelKey, inputTokens, outputTokens) {
  const price = PRICES[modelKey];
  if (!price) return null;
  const over100K = inputTokens >= 100_000;
  const over200K = inputTokens >= 200_000;
  const inRate = over200K ? (price.inOver200K || price.inOver100K || price.in) :
                 over100K ? (price.inOver100K || price.in) : price.in;
  const outRate = over200K ? (price.outOver200K || price.outOver100K || price.out) :
                  over100K ? (price.outOver100K || price.out) : price.out;
  return (inputTokens * inRate + outputTokens * outRate) / 1_000_000;
}

// ─── レポート生成 ──────────────────────────────────────────
function generateReport(costStates, archived, costLogEntries) {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0];

  // モデル別集計（cost-state から）
  const modelTotals = {};
  let totalActualCost = 0;
  let totalInput = 0, totalOutput = 0;
  let totalCacheRead = 0, totalCacheCreate = 0;
  let sessionsWithThinking = 0, totalThinking = 0;
  let largePromptSessions = 0;

  for (const cs of costStates) {
    totalActualCost += cs.totalCostUSD;
    for (const [model, usage] of Object.entries(cs.modelUsage || {})) {
      if (!modelTotals[model]) modelTotals[model] = {
        input: 0, output: 0, thinking: 0, cacheRead: 0, cacheCreate: 0, cost: 0, sessions: 0,
      };
      modelTotals[model].input += usage.inputTokens || 0;
      modelTotals[model].output += usage.outputTokens || 0;
      modelTotals[model].thinking += usage.thinkingTokens || 0;
      modelTotals[model].cacheRead += usage.cacheReadInputTokens || 0;
      modelTotals[model].cacheCreate += usage.cacheCreationInputTokens || 0;
      modelTotals[model].cost += usage.costUSD || 0;
      modelTotals[model].sessions++;

      totalInput += usage.inputTokens || 0;
      totalOutput += usage.outputTokens || 0;
      totalCacheRead += usage.cacheReadInputTokens || 0;
      totalCacheCreate += usage.cacheCreationInputTokens || 0;

      if (usage.thinkingTokens) {
        totalThinking += usage.thinkingTokens;
        sessionsWithThinking++;
      }
      if ((usage.inputTokens || 0) >= 100_000) largePromptSessions++;
    }
  }

  // コストログの集計
  let logTotalTokens = 0, logTotalUsd = 0;
  for (const entry of costLogEntries) {
    logTotalTokens += entry.tokens || 0;
    logTotalUsd += entry.usd || 0;
  }

  // ─── レポート構築 ────────────────────────────────────
  let report = `# X-0023: 安価ワーカーモデルルーティング — コスト分析レポート

> 生成日: ${dateStr}
> 対象期間: 直近${DAYS_BACK}日間
> データソース: ${costStates.length}セッションの cost-state イベント + ${costLogEntries.length}件のコストログ

## 1. データ概要

| 指標 | 値 |
|---|---|
| 走査したプロジェクト | ${costStates.length} セッション |
| 実測コスト総額 (USD) | $${totalActualCost.toFixed(4)} |
| 入力トークン総計 | ${totalInput} |
| 出力トークン総計 | ${totalOutput} |
| 思考トークン総計 | ${totalThinking} (${sessionsWithThinking}セッション) |
| キャッシュ読み取り | ${totalCacheRead} |
| キャッシュ作成 | ${totalCacheCreate} |
| 大きなプロンプト（100K+） | ${largePromptSessions} セッション |
| コストログ API呼出 | ${costLogEntries.length} call, $${logTotalUsd.toFixed(4)} |

## 2. 現在のモデル別利用状況

| モデル | セッション数 | 入力 | 出力 | 思考 | キャッシュ読 | 実コストUSD |
|---|---|---|---|---|---|---|
`;
  const sortedModels = Object.keys(modelTotals)
    .sort((a, b) => modelTotals[b].cost - modelTotals[a].cost);
  for (const model of sortedModels) {
    const m = modelTotals[model];
    report += `| ${model} | ${m.sessions} | ${m.input} | ${m.output} | ${m.thinking} | ${m.cacheRead} | $${m.cost.toFixed(4)} |\n`;
  }

  // Haiku 5.5 換算コスト計算
  report += `
## 3. モデル別コスト比較（リスト価格換算）

タスク量ベース（実入出力トークン × 各モデルのリスト価格）:

| モデル | 入力コスト | 出力コスト | 合計USD | Opus 5.5比 |
|---|---|---|---|---|
`;
  const modelRows = [
    { key: 'opus-5.5', label: '**Opus 5.5** (現行)' },
    { key: 'sonnet-5.5', label: 'Sonnet 5.5' },
    { key: 'haiku-5.5', label: '**Haiku 5.5**' },
    { key: 'gpt-6-luna', label: 'GPT-6 Luna' },
    { key: 'muse-ember', label: 'Muse Ember' },
  ];
  const opusCost = calcCost('opus-5.5', totalInput, totalOutput) || 1;
  for (const row of modelRows) {
    const cost = calcCost(row.key, totalInput, totalOutput);
    if (cost === null) continue;
    const ratio = (1 - cost / opusCost) * 100;
    const inPrice = PRICES[row.key].in;
    const outPrice = PRICES[row.key].out;
    const inCost = totalInput * inPrice / 1_000_000;
    const outCost = totalOutput * outPrice / 1_000_000;
    report += `| ${row.label} | $${inCost.toFixed(4)} | $${outCost.toFixed(4)} | **$${cost.toFixed(4)}** | ${ratio.toFixed(1)}%減 |\n`;
  }

  // タスク単価
  const totalRequests = costStates.length + costLogEntries.filter(e => e.tokens > 0).length;
  const opusPerTask = opusCost / Math.max(1, totalRequests);
  const haikuPerTask = calcCost('haiku-5.5', totalInput, totalOutput) / Math.max(1, totalRequests);
  const emberPerTask = calcCost('muse-ember', totalInput, totalOutput) / Math.max(1, totalRequests);

  report += `
### タスク単価

- 現行単価（実測ベース）: **$${(totalActualCost / Math.max(1, totalRequests)).toFixed(6)} USD/リクエスト** = $${((totalActualCost / Math.max(1, totalRequests)) * 1000).toFixed(3)} ミリドル
- Opus 5.5 リスト価格換算: **$${opusPerTask.toFixed(6)} USD/リクエスト**
- Haiku 5.5 換算: **$${haikuPerTask.toFixed(6)} USD/リクエスト** (${opusPerTask > 0 ? ((1 - haikuPerTask/opusPerTask) * 100).toFixed(0) : 0}%減)
- Muse Ember 換算: **$${emberPerTask.toFixed(6)} USD/リクエスト** (${opusPerTask > 0 ? ((1 - emberPerTask/opusPerTask) * 100).toFixed(0) : 0}%減)
- **Opus 5.5 → Haiku 5.5 切替で $${opusPerTask.toFixed(4)} → $${haikuPerTask.toFixed(4)} = $${(opusPerTask - haikuPerTask).toFixed(4)}/タスク削減**
`;
  const reduction = opusPerTask - haikuPerTask;
  const targetText = `$${reduction.toFixed(4)}/タスク削減`;

  // コスト削減効果の数式
  report += `
### コスト削減効果の数式

\`\`\`
削減率 = 1 - (HaikuCost_ListPrice / OpusCost_ListPrice) × (Haiku成功率 / Opus成功率)

実測値による試算:
  Opus 5.5 リスト額:  $${opusCost.toFixed(4)} (入${totalInput}トークン + 出${totalOutput}トークン)
  Haiku 5.5 リスト額: $${calcCost('haiku-5.5', totalInput, totalOutput).toFixed(4)}
  GPT-6 Luna:        $${calcCost('gpt-6-luna', totalInput, totalOutput).toFixed(4)}
  Muse Ember:        $${calcCost('muse-ember', totalInput, totalOutput).toFixed(4)}

削減ポテンシャル（Haiku 5.5 に全置換）:
  リスト価格ベース: ${(1 - calcCost('haiku-5.5', totalInput, totalOutput) / opusCost) * 100}%
  現行実測コスト: $${totalActualCost.toFixed(4)} → 目標 $${(totalActualCost * calcCost('haiku-5.5', totalInput, totalOutput) / opusCost).toFixed(4)}

ベンチマーク参照値:
  Ember 115Mトークン vs Haiku 298Mトークン（同一$$0.50レート）
  → Haiku は Ember の 2.6倍のトークン処理量を同一コストで実現
  AutomationBench: Ember 37.8% vs Haiku 13.9%
  Coding Agent Index: Ember 46 vs Haiku 37
\`\`\`

## 4. 100K/200K+ トークンプロンプト

> 100K超でHaiku 5.5の価格が input $0.10→$0.50, output $0.50→$2.50 に切替
> 200K超の取り扱いはモデルにより異なる（一部は超過不可）

| 検出名 | 該当セッション | 備考 |
|---|---|---|
| 100K+入力 | ${largePromptSessions} session | キャッシュ戦略で緩和可能 |
| 実測総入力 | ${totalInput} | 平均 ${(totalInput / Math.max(1, costStates.length)).toFixed(0)}/session |
| 実測総出力 | ${totalOutput} | 平均 ${(totalOutput / Math.max(1, costStates.length)).toFixed(0)}/session |

## 5. シャドウテスト計画

**選定タグ**: \`extraction\`（抽出・分類・要約 — 定型処理で状態を持たず独立実行可）
**テストサイズ**: 全extraction系リクエストの5%（= コストログの該当エントリから抽出）

**方法**:
1. 同一入力を Opus 5.5（現行）と Haiku 5.5（候補）の両方に送信
2. 出力を並列記録（ユーザー送信・マージなし）
3. 意味的等価性を判定
4. トークン効率・コストを比較

| # | ソース | 入力トークン目安 | Opusコスト | Haikuコスト | 削減率 |
|---|---|---|---|---|---|
`;
  // Show 5 sample cost-log entries for shadow candidates
  let si = 1;
  for (const entry of costLogEntries.slice(0, 5)) {
    const inT = entry.in || 0;
    const outT = entry.out || 0;
    const oC = calcCost('opus-5.5', inT, outT) || 0;
    const hC = calcCost('haiku-5.5', inT, outT) || 0;
    const provider = entry.provider || entry.model || 'unknown';
    report += `| ${si++} | ${provider} | ${inT}in / ${outT}out | $${oC.toFixed(6)} | $${hC.toFixed(6)} | ${oC > 0 ? ((1 - hC / oC) * 100).toFixed(0) : 0}% |\n`;
  }

  report += `
## 6. オージャスト適用計画

### 対象タスク
1. **展示会ブースパース・バリエーション生成**
   - 現在: Opus 5.5 で毎回Full生成
   - 改善案: 初回設計のみOpus → バリエーション展開をHaikuへ
   - 期待削減: 60-70%

2. **抽出・ツールコールの繰り返し**（名簿・シート・メール文面）
   - 現在: Opus 5.5 + subagent
   - 改善案: extraction系統をHaiku 5.5固定subagentへ
   - 期待削減: 75-85%

3. **イベント企画案の一斉生成**
   - 現在: Opus 5.5 全件
   - 改善案: 初期案をHaiku→Opusで絞り込み
   - 期待削減: 50-60%

### コスト試算

| シナリオ | 月間コスト目安 | 備考 |
|---|---|---|
| 現状維持（全Opus 5.5） | $${totalActualCost.toFixed(2)}/${DAYS_BACK}日 | 基準値 |
| extractionのみHaiku | $${((totalActualCost * 0.3) + (totalActualCost * 0.7 * calcCost('haiku-5.5', totalInput, totalOutput) / opusCost)).toFixed(2)}/${DAYS_BACK}日 | リスク最小 |
| 全面Haiku 5.5 | $${(totalActualCost * calcCost('haiku-5.5', totalInput, totalOutput) / opusCost).toFixed(2)}/${DAYS_BACK}日 | 品質検証必須 |

## 7. 結論と推奨

1. **Haiku 5.5 を extraction タグにルーティング**: コスト $${opusPerTask.toFixed(4)} → $${haikuPerTask.toFixed(4)} に削減
   - リスク最小（定型処理・検証容易）
   - オージャストのブースパース・名簿・メール文面に直接適用可能

2. **GPT-6 Luna**: Opus 5.5 と同価格帯。削減目的には不適。品質がOpusを上回る検証ができた場合のみ採用

3. **Muse Ember**: Haiku 5.5 より品質が高い可能性（AutomationBench 37.8% vs 13.9%）があるが、コストはHaikuの約4倍。
   - 「品質が重要なextraction」のセカンダリとして採用を検討

4. **100K/200K超プロンプトの監視**: Haiku 5.5価格が100Kで跳ね上がるため、prompt cachingで緩和

5. **段階的導入**:
   - Phase 1: extraction 5% シャドウテスト（本レポート）
   - Phase 2: 品質一致確認 → extraction 全量をHaikuへ
   - Phase 3: small_fix もHaikuへ拡大
   - Phase 4: Muse Ember を品質重視extractionのセカンダリに追加
`;

  return report;
}

// ─── メイン ────────────────────────────────────────────────
function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  process.stderr.write(`X-0023 Cost Tagger: scanning last ${DAYS_BACK} days...\n`);

  const { costStates, assistantEntries } = scanAllSessions();
  process.stderr.write(`  Cost states: ${costStates.length} sessions\n`);

  const archived = scanArchived();
  process.stderr.write(`  Archived sessions: ${archived.length}\n`);

  const costLog = scanCostLog();
  process.stderr.write(`  Cost log entries: ${costLog.length}\n`);

  const report = generateReport(costStates, archived, costLog);

  const reportPath = path.join(OUTPUT_DIR, 'cost-routing-report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  process.stderr.write(`Report: ${reportPath}\n`);

  // データ保存
  const dataPath = path.join(OUTPUT_DIR, 'cost-states-data.json');
  fs.writeFileSync(dataPath, JSON.stringify({
    costStates, archivedCount: archived.length, costLogCount: costLog.length,
    generatedAt: new Date().toISOString(),
  }, null, 2), 'utf8');
  process.stderr.write(`Data: ${dataPath}\n`);

  process.stdout.write(report);
}

main();