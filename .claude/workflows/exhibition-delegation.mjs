export const meta = {
  name: 'exhibition-delegation',
  description: '展示会企画を計画→ブースデザイン実装→レビューの3体サブエージェントに委譲する',
  phases: [
    { title: '計画', detail: '変更すべきファイル一覧を計画エージェントが立案' },
    { title: '実装', detail: 'ブースデザイン文書5点を実装エージェントが作成' },
    { title: 'レビュー', detail: '作成文書をレビューエージェントが検証' },
  ],
};

// Phase 1: 計画
phase('計画');
log('=== Phase 1: 計画エージェント起動 ===');

const planResult = await agent(
  `あなたは展示会企画の計画エージェントです。
株式会社オージャスト（https://orgiast.jp）の展示会ブース制作プロジェクトにおいて、
新しいクライアント向けの展示会企画を立案してください。

## クライアント想定
- クライアントID: C0056-2027-kansai-monodzukuri
- 企���名: 三共精機株式会社（精密機械部品製造）
- 展示会: 2027 関西ものづくりワールド（インテックス大阪）
- ブースサイズ: 6m × 3m（18m²）
- 予算: 150万円〜200万円
- 目的: 新規リード獲得（目標50件）とブランド認知向上
- ターゲット: 製造業の設備投資担当者・製造部長

## 既存リソース（活用すること）
1. apps/expo-apply/freebies/exhibition-planning-template.md — 展示会出展計画テンプレート
2. apps/expo-apply/freebies/booth-readiness-diagnostic.md — ブース準備度診断
3. apps/expo-apply/freebies/booth-preparation-checklist.md — 準備チェックリスト
4. docs/ai-news-x0009-sme-exhibition-strategy-shift.md — 展示会戦略ナレッジ
5. data/booth-projects.json — 過去プロジェクトデータ（C0056三共精機の実績あり）

## 依頼
このタスクで「変えるべきファイル」を変更順に一覧で出してください。
1. どの既存ファイルを修正するか
2. どの新しいファイルを作成するか
3. それぞれの変更内容の概要と優先順位`,
  { label: 'plan-agent', phase: '計画', model: 'sonnet' }
);

log(`計画完了: ${planResult.length} chars`);
log('計画内容を実装エージェントへ引き継ぎます');

// Phase 2: 実装
phase('実装');
log('=== Phase 2: ブースデザイン実装エージェント起動 ===');

const implementResult = await agent(
  `あなたは展示会ブースデザインの実装エージェントです。

## コンテキスト
株式会社オージャスト（https://orgiast.jp）が、クライアント「三共精機株式会社」（精密機械部品製造）の
「2027 関西ものづくりワールド」（インテックス大阪）向けに、6m×3m（18m²）のブースを企画・設計します。

予算: 150万円〜200万円
目的: 新規リード獲得（目標50件）とブランド認知向上
ターゲット: 製造業の設備投資担当者・製造部長

## 既存リソース
1. apps/expo-apply/freebies/exhibition-planning-template.md — テンプレート
2. apps/expo-apply/freebies/booth-readiness-diagnostic.md — 診断シート
3. apps/expo-apply/freebies/booth-preparation-checklist.md — チェックリスト
4. docs/ai-news-x0009-sme-exhibition-strategy-shift.md — 戦略ナレッジ
5. data/booth-projects.json — 過去プロジェクトデータ

## 以下の計画に基づいて実装してください

${planResult.slice(0, 3000)}

## タスク
以下の5つの文書を apps/expo-apply/projects/C0056-2027-kansai-monodzukuri/ に作成してください。

1. **01_企画概要.md**: 企業概要、出展目的（優先順位付き）、ターゲット定義（プライマリ/セカンダリ/ペルソナ）、
   KPI（リード50件、商談20件、成約3件、ROI 150%以上）、ブース基本スペック（6m×3m=18m²）、
   成功条件（最低/標準/最高の3段階）と測定方法（準備期〜長期の6フェーズ）、リスク管理

2. **02_ブース設計企画書.md**: デザインコンセプト（テーマ・カラースキーム）、
   6m×3mのAscii Artレイアウト図（エントランス→実機展示→商談席→資料配布のゾーニング）、
   導線設計（遠方視認→接近→展示見学→スタッフ接触→商談→名刺交換の8ステップ）、
   視認性確保策（遠方/中間/近接の3段階）、精密機械部品の展示方法（実機+パネル+デジタルのハイブリッド）

3. **03_スケジュール.md**: 12のマイルストーン（出展意思決定〜成約フォロー期限）、
   5フェーズ詳細（準備/企画デザイン/制作準備/実施/フォローアップ検証）、
   クリティカルパス、リスク対応スケジュール

4. **04_予算計画.md**: 推奨予算175万円の8カテゴリ配分（出展料/構築費/輸送費/設営撤去/ノベルティ/人件費/事前プロモ/予備費）、
   各カテゴリの詳細内訳、費用対効果試算（CPL/CPA/投資回収）、3シナリオ比較（最小150万/推奨175万/積極200万）、
   支払いスケジュール、費用管理ルール

5. **05_リード獲得戦略.md**: 目標50件のチャネル別分解、来場者属性別アプローチ（A明確ニーズ/B漠然関心/C通りすがり/D競合）、
   6ステップ接客フローとヒアリングシート、3段階フォローアップ、リードスコアリングモデル、
   ナーチャリングコンテンツカレンダー（展示会後12ヶ月間）、事前集客施策、効果測定指標

各ファイルはマークダウン形式・日本語で書いてください。`,
  { label: 'design-agent', phase: '実装', model: 'sonnet' }
);

log(`実装完了: ${implementResult.length} chars`);

// Phase 3: レビュー
phase('レビュー');
log('=== Phase 3: レビューエージェント起動 ===');

const reviewResult = await agent(
  `あなたは展示会企画のレビューエージェントです。
以下の5つの企画文書をレビューしてください。

## レビュー対象
apps/expo-apply/projects/C0056-2027-kansai-monodzukuri/
- 01_企画概要.md
- 02_ブース設計企画書.md
- 03_スケジュール.md
- 04_予算計画.md
- 05_リード獲得戦略.md

## 比較対象（既存リソース）
- apps/expo-apply/freebies/exhibition-planning-template.md
- docs/ai-news-x0009-sme-exhibition-strategy-shift.md
- data/booth-projects.json

## レビュー観点
1. **一貫性**: 5ファイル間で数値（予算・KPI・日程）に矛盾はないか
2. **テンプレート充足度**: exhibition-planning-template.md の全項目をカバーしているか
3. **実現可能性**: 予算150-200万円で6m×3mブースは実現可能か、KPIは現実的か
4. **具体性**: レイアウト・導線・展示方法は具体的か
5. **ナレッジ反映**: 投資思考・フォローアップ設計・継続改善サイクルが反映されているか
6. **改善提案**: 不足している点、追加すべき項目

## 出力形式
- 各ファイルの評価（良かった点・問題点）を表形式で
- 優先順位付きの改善提案リスト（P0/P1/P2）
- 総合評価（S/A/B/C/Dの5段階）`,
  { label: 'review-agent', phase: 'レビュー', model: 'sonnet' }
);

log(`レビュー完了: ${reviewResult.length} chars`);

// 結果サマリー
log('');
log('='.repeat(60));
log('  DELEGATION WORKFLOW COMPLETE');
log('='.repeat(60));
log(`  Phase 1 (計画): ${planResult.length} chars`);
log(`  Phase 2 (実装): ${implementResult.length} chars`);
log(`  Phase 3 (レビュー): ${reviewResult.length} chars`);
log('='.repeat(60));

return {
  planLength: planResult.length,
  implementLength: implementResult.length,
  reviewLength: reviewResult.length,
  phases: ['計画', '実装', 'レビュー'],
};
