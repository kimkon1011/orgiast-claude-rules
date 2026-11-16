#!/usr/bin/env node

/**
 * X-0019 AI SEO Agent Workflow — 検証CLIツール
 *
 * Usage:
 *   node tools/ai-seo-agent-workflow.mjs --list
 *   node tools/ai-seo-agent-workflow.mjs --scenario plan
 *   node tools/ai-seo-agent-workflow.mjs --mode daily
 *   node tools/ai-seo-agent-workflow.mjs --mode weekly --json
 *   node tools/ai-seo-agent-workflow.mjs --mode cron-setup
 *   node tools/ai-seo-agent-workflow.mjs --mode report
 *   node tools/ai-seo-agent-workflow.mjs --mode daily --dry-run
 *   node tools/ai-seo-agent-workflow.mjs  (all scenarios)
 */

// ── Data ──────────────────────────────────────────────────────────────────

const SCENARIOS = [
  { key: 'plan',     label: '実装パス別 月額コスト試算' },
  { key: 'keywords', label: 'キーワード機会スコアリング' },
  { key: 'minisite', label: 'ミニサイト企画テンプレート生成' },
];

const MODES = [
  { key: 'daily',      label: '日次: GSCキーワード発見 → スコアリング → レポート' },
  { key: 'weekly',     label: '週次: 競合分析 + コンテンツギャップ + 週次レポート' },
  { key: 'cron-setup', label: 'cron設定生成 (Linux systemd / GitHub Actions YAML)' },
  { key: 'report',     label: '最後の実行結果サマリ' },
];

const COST_PATHS = [
  {
    label: 'A: Claude Code + GAS',
    monthly: '$0〜5',
    setup: '1〜2日',
    note: '既存環境流用、GAS無料枠内。制約: GAS実行時間6分/回制限',
  },
  {
    label: 'B: Hermes/OpenClaw on VPS',
    monthly: '$10〜30',
    setup: '1〜2週間',
    note: 'VPS費用 $10.89/月（Hetzner CX22）+ API従量 $0〜20/月',
  },
  {
    label: 'C: カスタムNode.js',
    monthly: '$1〜10',
    setup: '3〜5日',
    note: 'API従量 $1〜10/月、VPS不要（GitHub Actions無料枠）',
  },
];

const KEYWORD_DATA = [
  { kw: '展示会ブース 費用 相場', volume: 1200, rank: 25, competition: '中' },
  { kw: '小規模ブース デザイン',  volume: 800,  rank: 18, competition: '低' },
  { kw: '展示会 集客 施策',      volume: 600,  rank: 30, competition: '高' },
  { kw: 'イベント企画 代行',     volume: 400,  rank: 12, competition: '中' },
  { kw: 'ブース製作 会社 比較',  volume: 350,  rank: 35, competition: '高' },
  { kw: '展示会 ブース レンタル', volume: 900,  rank: null, competition: '低' },
  { kw: 'ブース装飾 会社',       volume: 500,  rank: 22, competition: '中' },
  { kw: '展示会 出展 準備',      volume: 700,  rank: null, competition: '低' },
];

const MAX_VOLUME = Math.max(...KEYWORD_DATA.map(d => d.volume));

const COMPETITION_SCORE = { 低: 0.3, 中: 0.15, 高: 0 };

const MINISITE_TEMPLATES = [
  {
    theme: '展示会ブース 費用 相場',
    targetKw: ['ブース費用', '相場', '予算', '坪単価'],
    content: '費用テーブル + 規模別事例 + 見積依頼CTA',
  },
  {
    theme: '小規模ブース デザイン',
    targetKw: ['小規模', '3坪', '6坪', '島ブース'],
    content: '実績ギャラリー + レイアウト例 + 費用目安',
  },
  {
    theme: '展示会 集客 施策',
    targetKw: ['集客', 'ノベルティ', 'ブース誘導'],
    content: '施策リスト + 事例 + チェックリストDL',
  },
  {
    theme: 'イベント企画 代行',
    targetKw: ['イベント企画', '運営代行', '丸投げ'],
    content: 'サービス一覧 + フローチャート + 実績',
  },
  {
    theme: 'ブース製作 会社 比較',
    targetKw: ['ブース製作会社', '選び方', '比較'],
    content: '選定基準 + 自社の強み + 比較表',
  },
];

// ── Mock data for execution modes ─────────────────────────────────────────

const DAILY_MOCK_GSC_DATA = [
  { query: '展示会 ブース 費用',         impressions: 3420, clicks: 145, ctr: 4.24, position: 12.3, date: '2026-11-14' },
  { query: 'イベント ブース 製作',       impressions: 1890, clicks: 89,  ctr: 4.71, position:  8.7, date: '2026-11-14' },
  { query: '小規模 展示 出展 费用',      impressions: 1560, clicks: 34,  ctr: 2.18, position: 19.5, date: '2026-11-14' },
  { query: '展示会 装飾 業者',           impressions:  780, clicks: 67,  ctr: 8.59, position:  5.2, date: '2026-11-14' },
  { query: 'ブース デザイン 格安',       impressions:  640, clicks: 22,  ctr: 3.44, position: 14.1, date: '2026-11-14' },
  { query: 'ノベルティ 展示会 おすすめ', impressions:  510, clicks: 41,  ctr: 8.04, position:  6.8, date: '2026-11-14' },
  { query: '展示会 集客 アイデア',       impressions:  430, clicks: 38,  ctr: 8.84, position:  7.3, date: '2026-11-14' },
];

const WEEKLY_MOCK_COMPETITOR_DATA = [
  { competitor: '株式会社A展示',     overlappingKws: 45, contentGapScore: 0.72, strength: 'コスト試算ページが充実',    weakness: '実績ギャラリーが薄い' },
  { competitor: 'ブースB製作所',      overlappingKws: 32, contentGapScore: 0.58, strength: 'SEO全体のドメインパワー',  weakness: '小規模ブース向け記事がない' },
  { competitor: 'Cイベントソリューション', overlappingKws: 28, contentGapScore: 0.45, strength: '集客施策の網羅性',       weakness: 'ミニサイトのUXが悪い' },
  { competitor: '株式会社D企画',      overlappingKws: 21, contentGapScore: 0.61, strength: '動画コンテンツが多い',      weakness: 'テキスト記事が浅い' },
];

// ── Helpers ───────────────────────────────────────────────────────────────

function scoreKeyword({ volume, rank, competition }) {
  const volScore = (volume / MAX_VOLUME) * 0.4;
  const rankScore = rank != null ? (1 - rank / 50) * 0.3 : 0;
  const compScore = (COMPETITION_SCORE[competition] ?? 0) * 0.3;
  return Math.round((volScore + rankScore + compScore) * 1000) / 1000;
}

function separator() {
  console.log('─'.repeat(56));
}

function dryRunPrefix(isDryRun) {
  if (isDryRun) process.stdout.write('【DRY-RUN】');
}

function jsonOrText(data, useJson) {
  if (useJson) {
    console.log(JSON.stringify(data));
    return;
  }
  return data; // caller prints
}

// ── Scenario runners ──────────────────────────────────────────────────────

function runList(useJson) {
  const scenarios = SCENARIOS.map(s => ({ key: s.key, label: s.label }));
  const modes = MODES.map(m => ({ key: m.key, label: m.label }));
  if (useJson) return jsonOrText({ scenarios, modes }, true);
  console.log('利用可能シナリオ:\n');
  scenarios.forEach(s => console.log(`  ${s.key.padEnd(12)} ${s.label}`));
  console.log();
  console.log('利用可能モード:\n');
  modes.forEach(m => console.log(`  ${m.key.padEnd(14)} ${m.label}`));
  console.log();
}

function runPlan(useJson) {
  const data = COST_PATHS.map(p => ({
    path: p.label,
    monthlyCost: p.monthly,
    setupPeriod: p.setup,
    notes: p.note,
  }));
  if (useJson) return jsonOrText(data, true);

  console.log('【実装パス別 月額コスト試算】\n');
  COST_PATHS.forEach(p => {
    console.log(`  ${p.label}`);
    console.log(`    月額: ${p.monthly}  |  導入期間: ${p.setup}`);
    console.log(`    ${p.note}\n`);
  });
}

function runKeywords(useJson) {
  const data = KEYWORD_DATA.map(d => ({
    keyword: d.kw,
    volume: d.volume,
    rank: d.rank,
    competition: d.competition,
    score: scoreKeyword(d),
  }));
  if (useJson) return jsonOrText(data, true);

  console.log('【キーワード機会スコアリング】\n');
  console.log('  キーワード'.padEnd(28) + '検索数  順位  競合  スコア');
  console.log('  ' + '─'.repeat(54));
  const sorted = [...data].sort((a, b) => b.score - a.score);
  sorted.forEach(d => {
    const rankStr = d.rank != null ? String(d.rank).padStart(2) : '--';
    console.log(
      `  ${d.keyword.padEnd(26)} ${String(d.volume).padStart(5)}  ${rankStr}位  ${d.competition}  ${d.score.toFixed(3)}`
    );
  });
  console.log();
}

function runMinisite(useJson) {
  const data = MINISITE_TEMPLATES.map(t => ({
    theme: t.theme,
    targetKeywords: t.targetKw,
    contentStructure: t.content,
  }));
  if (useJson) return jsonOrText(data, true);

  console.log('【ミニサイト企画テンプレート】\n');
  MINISITE_TEMPLATES.forEach((t, i) => {
    console.log(`  ${i + 1}. テーマ: ${t.theme}`);
    console.log(`     狙うKW: ${t.targetKw.join(', ')}`);
    console.log(`     コンテンツ構成: ${t.content}\n`);
  });
}

// ── Mode runners ──────────────────────────────────────────────────────────

/**
 * 日次パイプライン: GSC Keyword Finder → スコアリング → レポート生成
 */
function runDaily(useJson, isDryRun) {
  if (useJson) {
    const now = new Date().toISOString();
    const scored = DAILY_MOCK_GSC_DATA
      .map(d => ({ ...d, opportunityScore: scoreOpportunity(d) }))
      .sort((a, b) => b.opportunityScore - a.opportunityScore);
    const report = buildDailyReport(DAILY_MOCK_GSC_DATA);
    return jsonOrText({
      mode: 'daily', dryRun: isDryRun, timestamp: now,
      totalQueries: DAILY_MOCK_GSC_DATA.length,
      scoredKeywords: scored,
      report,
    }, true);
  }

  dryRunPrefix(isDryRun);
  console.log('【日次パイプライン】GSCキーワード発見 → スコアリング → レポート\n');

  // Step 1: Fetch GSC data
  dryRunPrefix(isDryRun);
  if (!isDryRun) console.log('1. GSCキーワードデータ取得... ✓');
  else console.log('1. GSCキーワードデータ取得... [SKIP]');
  const gscData = isDryRun ? [] : DAILY_MOCK_GSC_DATA;

  if (!isDryRun) {
    console.log(`   取得件数: ${gscData.length}クエリ`);
    console.log(`   合計impressions: ${gscData.reduce((s, d) => s + d.impressions, 0).toLocaleString()}`);
    console.log(`   合計clicks: ${gscData.reduce((s, d) => s + d.clicks, 0).toLocaleString()}\n`);
  }

  // Step 2: Score keywords
  dryRunPrefix(isDryRun);
  if (!isDryRun) console.log('2. キーワードスコアリング... ✓\n');
  else console.log('2. キーワードスコアリング... [SKIP]\n');

  if (!isDryRun) {
    const scored = gscData
      .map(d => ({
        query: d.query,
        impressions: d.impressions,
        clicks: d.clicks,
        ctr: d.ctr,
        position: d.position,
        opportunityScore: scoreOpportunity(d),
      }))
      .sort((a, b) => b.opportunityScore - a.opportunityScore);

    const top3 = scored.slice(0, 3);
    console.log('   スコアTOP3:');
    top3.forEach(d => {
      console.log(`     ${d.opportunityScore.toFixed(3)}  ${d.query} (imp:${d.impressions}, pos:${d.position})`);
    });
    console.log();
  }

  // Step 3: Generate report
  dryRunPrefix(isDryRun);
  if (!isDryRun) console.log('3. レポート生成... ✓\n');
  else console.log('3. レポート生成... [SKIP]\n');

  if (!isDryRun) {
    const report = buildDailyReport(gscData);
    console.log('   レポートサマリ:');
    console.log(`     日付: ${report.date}`);
    console.log(`     分析クエリ数: ${report.totalQueries}`);
    console.log(`     高機会クエリ数: ${report.highOpportunityCount}`);
    console.log(`     推奨アクション: ${report.recommendations}`);
    console.log();
  }

  const now = new Date().toISOString();
  return { mode: 'daily', dryRun: isDryRun, timestamp: now };
}

/**
 * 週次パイプライン: 競合分析 + コンテンツギャップ + 週次レポート
 */
function runWeekly(useJson, isDryRun) {
  if (useJson) {
    const now = new Date().toISOString();
    const report = buildWeeklyReport();
    const gaps = computeContentGaps();
    return jsonOrText({
      mode: 'weekly', dryRun: isDryRun, timestamp: now,
      competitors: WEEKLY_MOCK_COMPETITOR_DATA,
      contentGaps: gaps,
      report,
    }, true);
  }
  dryRunPrefix(isDryRun);
  console.log('【週次パイプライン】競合分析 + コンテンツギャップ + 週次レポート\n');

  // Step 1: Competitor analysis
  dryRunPrefix(isDryRun);
  if (!isDryRun) console.log('1. 競合分析... ✓\n');
  else console.log('1. 競合分析... [SKIP]\n');

  if (!isDryRun) {
    console.log('   競合状況:');
    WEEKLY_MOCK_COMPETITOR_DATA.forEach(c => {
      console.log(`     ${c.competitor}`);
      console.log(`       重複KW: ${c.overlappingKws}件 | ギャップスコア: ${c.contentGapScore}`);
      console.log(`       強み: ${c.strength}`);
      console.log(`       弱み: ${c.weakness}\n`);
    });
  }

  // Step 2: Content gap
  dryRunPrefix(isDryRun);
  if (!isDryRun) console.log('2. コンテンツギャップ分析... ✓\n');
  else console.log('2. コンテンツギャップ分析... [SKIP]\n');

  if (!isDryRun) {
    const gaps = computeContentGaps();
    console.log('   発見されたギャップ:');
    gaps.forEach(g => {
      console.log(`     [${g.priority.toUpperCase()}] ${g.theme}`);
      console.log(`       競合カウント: ${g.competitorCount}社 | 自社: ${g.hasOurContent ? 'あり' : 'なし'}`);
      console.log(`       推奨KV: ${g.recommendedKw}`);
      console.log(`       アクション: ${g.action}\n`);
    });
  }

  // Step 3: Weekly report
  dryRunPrefix(isDryRun);
  if (!isDryRun) console.log('3. 週次レポート生成... ✓\n');
  else console.log('3. 週次レポート生成... [SKIP]\n');

  if (!isDryRun) {
    const report = buildWeeklyReport();
    console.log('   週次レポートサマリ:');
    console.log(`     集計期間: ${report.period}`);
    console.log(`     分析競合数: ${report.competitorCount}`);
    console.log(`     ギャップ数: ${report.gapCount}`);
    console.log(`     スコア変化: ${report.trendDirection}`);
    console.log(`     推奨アクション: ${report.recommendations}`);
    console.log();
  }

  const now = new Date().toISOString();
  return { mode: 'weekly', dryRun: isDryRun, timestamp: now };
}

/**
 * cron設定生成: systemd + GitHub Actions YAML
 */
function runCronSetup(useJson, _isDryRun) {
  // dryRun has no effect here — we generate static config, no API calls
  const configs = {
    systemd: generateSystemdConfig(),
    githubActions: generateGithubActionsConfig(),
  };

  if (useJson) return jsonOrText({ mode: 'cron-setup', configs }, true);

  console.log('【cron設定生成】\n');

  console.log('=== systemd timer (Linux VPS用) ===\n');
  console.log(configs.systemd.service);
  console.log();
  console.log(configs.systemd.timer);
  console.log();
  console.log('有効化コマンド:');
  console.log('  sudo cp ai-seo-daily.service ai-seo-daily.timer /etc/systemd/system/');
  console.log('  sudo systemctl daemon-reload');
  console.log('  sudo systemctl enable ai-seo-daily.timer');
  console.log('  sudo systemctl start ai-seo-daily.timer\n');

  separator();

  console.log('\n=== GitHub Actions (schedule) ===\n');
  console.log(configs.githubActions);
  console.log();

  return { mode: 'cron-setup', configs };
}

/**
 * 最後の実行結果サマリ
 */
function runReport(useJson, _isDryRun) {
  // Simulated last run data; in production would read from state file
  const lastRun = {
    timestamp: new Date().toISOString(),
    daily: {
      lastRun: '2026-11-15T03:00:00Z',
      queriesAnalyzed: 342,
      opportunitiesFound: 12,
      topKeyword: '展示会 ブース 費用',
    },
    weekly: {
      lastRun: '2026-11-15T03:00:00Z',
      competitorsAnalyzed: 4,
      gapsFound: 3,
      trendDirection: '上昇',
    },
    totalRuns: 47,
    errors: 1,
    lastError: '2026-11-14 05:12 UTC — GSC API rate limit (429), auto-retry succeeded',
    uptime: '97.9%',
  };

  if (useJson) return jsonOrText({ mode: 'report', lastRun }, true);

  console.log('【最終実行サマリ】\n');

  console.log(`  最終実行: ${lastRun.daily.lastRun}`);
  console.log(`  --- 日次 ---`);
  console.log(`  分析クエリ数: ${lastRun.daily.queriesAnalyzed}`);
  console.log(`  発見機会数: ${lastRun.daily.opportunitiesFound}`);
  console.log(`  TOPキーワード: ${lastRun.daily.topKeyword}`);
  console.log(`  --- 週次 ---`);
  console.log(`  競合分析社数: ${lastRun.weekly.competitorsAnalyzed}`);
  console.log(`  コンテンツギャップ: ${lastRun.weekly.gapsFound}`);
  console.log(`  トレンド: ${lastRun.weekly.trendDirection}`);
  console.log(`  --- 全体 ---`);
  console.log(`  総実行回数: ${lastRun.totalRuns}`);
  console.log(`  エラー: ${lastRun.errors}件`);
  if (lastRun.errors > 0) {
    console.log(`  最終エラー: ${lastRun.lastError}`);
  }
  console.log(`  稼働率: ${lastRun.uptime}\n`);

  return { mode: 'report', lastRun };
}

// ── Mode helper functions ─────────────────────────────────────────────────

function scoreOpportunity(d) {
  const impressionScore = Math.min(d.impressions / 5000, 1) * 0.35;
  const ctrScore = Math.min(d.ctr / 10, 1) * 0.25;
  const positionScore = d.position <= 5 ? 0.4 :
    d.position <= 10 ? 0.3 :
    d.position <= 20 ? 0.2 : 0.1;
  return Math.round((impressionScore + ctrScore + positionScore) * 1000) / 1000;
}

function buildDailyReport(gscData) {
  const highOpportunity = gscData.filter(d => scoreOpportunity(d) > 0.7);
  return {
    date: '2026-11-14',
    totalQueries: gscData.length,
    highOpportunityCount: highOpportunity.length,
    recommendations: highOpportunity.length >= 3
      ? '高機会クエリに対してミニサイト/CTAページの作成を優先'
      : '新規キーワードの発掘を継続',
  };
}

function computeContentGaps() {
  return [
    {
      theme: '予算別ブースプラン比較',
      priority: 'high',
      competitorCount: 3,
      hasOurContent: false,
      recommendedKw: '展示会 ブース 予算 5万, 展示会 予算別 プラン',
      action: '「5万円/10万円/30万円」の3プラン比較記事を作成',
    },
    {
      theme: '展示会 出展チェックリスト',
      priority: 'high',
      competitorCount: 4,
      hasOurContent: true,
      recommendedKw: '展示会 出展 準備 リスト, 展示会 持ち物',
      action: '既存記事にダウンロード可能なチェックリストを追加',
    },
    {
      theme: '業種別 展示会成功事例',
      priority: 'medium',
      competitorCount: 2,
      hasOurContent: false,
      recommendedKw: '業種別 展示会 事例, IT 展示会 成功例',
      action: '製造業/IT/飲食の3業種の事例記事を新規作成',
    },
  ];
}

function buildWeeklyReport() {
  return {
    period: '2026-11-09 ~ 2026-11-15',
    competitorCount: 4,
    gapCount: 3,
    trendDirection: '上昇 (キーワード被覆範囲 +8%)',
    recommendations: '予算別プラン記事の作成を今週中に着手。チェックリストDL化は優先度高い。',
  };
}

function generateSystemdConfig() {
  return {
    service: `# /etc/systemd/system/ai-seo-daily.service
[Unit]
Description=AI SEO Agent — Daily pipeline
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=seo-agent
WorkingDirectory=/opt/ai-seo-agent
ExecStart=/usr/bin/node /opt/ai-seo-agent/tools/ai-seo-agent-workflow.mjs --mode daily
StandardOutput=journal
StandardError=journal
Restart=no

# Security
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/opt/ai-seo-agent/data
`,
    timer: `# /etc/systemd/system/ai-seo-daily.timer
[Unit]
Description=AI SEO Agent — Daily timer (03:00 JST)

[Timer]
OnCalendar=*-*-* 03:00:00 Asia/Tokyo
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
`,
  };
}

function generateGithubActionsConfig() {
  return `# .github/workflows/ai-seo-daily.yml
name: AI SEO Agent — Daily Pipeline

on:
  schedule:
    # 毎日 03:00 JST (UTC 18:00 前日)
    - cron: '0 18 * * *'
  workflow_dispatch:  # 手動実行用

jobs:
  seo-daily:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run daily SEO pipeline
        run: node tools/ai-seo-agent-workflow.mjs --mode daily --json
        env:
          GSC_API_CREDENTIALS: \${{ secrets.GSC_API_CREDENTIALS }}

      - name: Commit report
        run: |
          git config user.name "seo-agent[bot]"
          git config user.email "seo-agent@users.noreply.github.com"
          git add data/reports/
          git diff --quiet || git commit -m "chore(seo): daily report [skip ci]"
          git push

---
# .github/workflows/ai-seo-weekly.yml
name: AI SEO Agent — Weekly Pipeline

on:
  schedule:
    # 毎週月曜 05:00 JST (UTC 20:00 日曜)
    - cron: '0 20 * * 0'
  workflow_dispatch:

jobs:
  seo-weekly:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Run weekly SEO pipeline
        run: node tools/ai-seo-agent-workflow.mjs --mode weekly --json
        env:
          GSC_API_CREDENTIALS: \${{ secrets.GSC_API_CREDENTIALS }}

      - name: Commit weekly report
        run: |
          git config user.name "seo-agent[bot]"
          git config user.email "seo-agent@users.noreply.github.com"
          git add data/reports/
          git diff --quiet || git commit -m "chore(seo): weekly report [skip ci]"
          git push`;
}

// ── Main ──────────────────────────────────────────────────────────────────

function showHelp() {
  console.log(`AI SEO Agent Workflow — 検証CLIツール

使い方:
  node tools/ai-seo-agent-workflow.mjs             全シナリオ表示
  node tools/ai-seo-agent-workflow.mjs --list      一覧表示

シナリオ（設計検証用）:
  --scenario plan        実装パス別 月額コスト試算
  --scenario keywords    キーワード機会スコアリング
  --scenario minisite    ミニサイト企画テンプレート生成

実行モード（パイプライン実行）:
  --mode daily          日次: GSCキーワード発見 → スコアリング → レポート
  --mode weekly         週次: 競合分析 + コンテンツギャップ + 週次レポート
  --mode cron-setup      cron設定生成 (systemd / GitHub Actions YAML)
  --mode report         最後の実行結果サマリ

共通オプション:
  --json                JSON形式で出力
  --dry-run             API呼び出しをスキップして計画表示（daily/weeklyのみ有効）
  -h, --help            このヘルプを表示
`);
}

function showError(message) {
  const err = { error: true, message };
  console.error(`エラー: ${message}`);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(err) + '\n');
  }
  process.exit(1);
}

function main() {
  const args = process.argv.slice(2);
  const useJson = args.includes('--json');
  const isDryRun = args.includes('--dry-run');
  const listOnly = args.includes('--list');

  if (args.includes('-h') || args.includes('--help')) {
    showHelp();
    return;
  }

  const scenarioIdx = args.indexOf('--scenario');
  const scenario = scenarioIdx !== -1 ? args[scenarioIdx + 1] : null;

  const modeIdx = args.indexOf('--mode');
  const mode = modeIdx !== -1 ? args[modeIdx + 1] : null;

  // Validate scenario
  if (scenario && !SCENARIOS.some(s => s.key === scenario)) {
    showError(`不明なシナリオ「${scenario}」。--list で一覧を確認してください。`);
  }

  // Validate mode
  if (mode && !MODES.some(m => m.key === mode)) {
    showError(`不明なモード「${mode}」。--list で一覧を確認してください。`);
  }

  if (listOnly) {
    runList(useJson);
    return;
  }

  if (mode) {
    switch (mode) {
      case 'daily':      runDaily(useJson, isDryRun);    break;
      case 'weekly':     runWeekly(useJson, isDryRun);   break;
      case 'cron-setup': runCronSetup(useJson, isDryRun); break;
      case 'report':     runReport(useJson, isDryRun);    break;
    }
    return;
  }

  if (scenario) {
    switch (scenario) {
      case 'plan':     runPlan(useJson);     break;
      case 'keywords': runKeywords(useJson); break;
      case 'minisite': runMinisite(useJson); break;
    }
    return;
  }

  // No specific option → run all scenarios (not modes)
  if (!useJson) {
    runList(false);
    separator();
  }
  runPlan(useJson);
  if (!useJson) separator();
  runKeywords(useJson);
  if (!useJson) separator();
  runMinisite(useJson);
}

main();