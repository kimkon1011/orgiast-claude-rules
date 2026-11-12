# X-0028: Grok Bot + Muse 役割分担 毎朝ニュース収集設計

- **ステータス**: リサーチ完了（2026-11-12）
- **AIニュース提案**: Grok Bot に毎朝8時 X 重要情報最大5件（重複除外・新規性重視）、Muse に9時公式一次情報調査を設定。前回との差分のみ報告し重要度S/A/B分類。頻度は1日1回から始めむやみに増やさない。
- **オージャスト適用**: 競合ブース動向やイベントトレンドリサーチにこの分業を適用し毎日の情報収集実行コストを削減する。

---

## 1. 現状分析

### 1.1 既存の情報収集基盤

| 基盤 | 説明 | 現状の限界 |
|---|---|---|
| **x-ai-tips-collect.mjs** | xAI API (`/v1/responses` / `grok-4.6` / `x_search`) でXのAI活用Tipsを収集。6テーマ×日英、最大8 calls/日、推定$2/日。`~/.claude/ai-news-proposals.jsonl` へ提案蓄積。 | 汎用テーマ収集であり、展示会・競合ブースに特化していない。収集時刻固定なし（夜間batch依存）。 |
| **grok-bot-prompt-bridge.mjs** | Grok リサーチ結果 JSON → Claude Code 実装プロンプト変換ブリッジ。Phase1(Grok)→Phase2(Claude Code)の橋渡し。 | リサーチ駆動コーディング向けであり、定時ニュース収集には直接使えない。 |
| **muse-handoff.mjs** | 外部AIへの認証情報暗号化委譲（AES-256-GCM / 最小権限（scope/purpose/recipient束縛）/ TTL / 監査ログ）。 | 認証情報パイプライン機能のみ。Muse という外部AIの「リサーチエージェント」機能は未実装。 |
| **llm-ask.mjs** | 汎用LLM呼び出し（Gemini/DeepSeek/Groq等へ委譲可）。調査・分類・要約に `--kind investigate|classify|summarize`。 | 公式一次情報の定時収集に最適化されていない。 |

### 1.2 ギャップ分析

| 要件 | ギャップ | 埋め方 |
|---|---|---|
| 毎朝8時 X 重要情報 | x-ai-tips-collect は夜間batch依存。展示会向けトピックない。 | `config/x-ai-tips-topics.json` に展示会・競合トピック追加。cron で8時実行。 |
| 毎朝9時 公式一次情報 | 公式サイト調査用の定時スクリプトなし | `llm-ask --kind investigate` で実現。新規スクリプト `daily-official-research.mjs` でラップ。 |
| 重複除外・新規性 | x-ai-tips-collect はURL正規化済みだが、クロスソース重複除去なし。 | Grok x_search 結果 × 公式サイト調査結果の cross-dedup。 |
| S/A/B分類 | ai-news-proposals は `confidence:low` 固定。優先度なし。 | 重要度S/A/Bを明示した分類フィールド追加。 |
| 差分のみ報告 | 前回からの変化検出なし。 | 前日 state との diff を生成し、新規のみを報告。 |

---

## 2. 設計: Grok Bot（8時）＋ Muse（9時）役割分担

### 2.1 全体アーキテクチャ

```
毎朝ループ（cron / nightly-batch 拡張）
│
├── 08:00 ── Grok Bot レーン ──────────────────────────────────
│   │  xAI API (grok-4.6 + x_search) で X を検索
│   │  展示会 / ブース / イベント / AI / 営業 の5トピック
│   │  直近24時間、max 5件、重複除外、likes 10+
│   │
│   └──→ results/grok-${date}.json （未加工検索結果）
│
├── 08:30 ── 重複除去・重要度分類 ────────────────────────────
│   │  Grok 結果と前日までの既知URLを照合
│   │  S/A/B 自動分類（xAI API の confidence からマッピング）
│   │  重要度S: 競合の新製品・新サービス発表
│   │  重要度A: トレンド記事・業界動向
│   │  重要度B: 参考情報・汎用的な知見
│   │
│   └──→ results/deduped-${date}.json
│
├── 09:00 ── Muse レーン ────────────────────────────────────
│   │  llm-ask (Gemini/DeepSeek で Web検索) 
│   │  → 公式一次情報（会社発表・プレスリリース・イベント公式サイト）
│   │  展示会公式サイト、競合HPのニュース、業界団体発表
│   │  前日からの更新を確認、各ソース1件ずつ
│   │
│   └──→ results/muse-${date}.json
│
├── 09:30 ── 統合・レポート生成 ──────────────────────────────
│   │  Grok 結果 + Muse 結果 を統合
│   │  cross-dedup（同内容がXと公式両方 → 公式を優先）
│   │  S/A/B 並び替え
│   │  差分のみ（前日レポートと比較し新規のみ）
│   │
│   └──→ reports/daily-news-${date}.md
│       → Discord DM / kim-inbox へ配送
│
└── 10:00 ── 状態更新 ──────────────────────────────────────
    state.json 更新（既知URL・ハッシュ・分類履歴）
    ~/.claude/ai-news-proposals.jsonl に（採択候補として）追記
```

### 2.2 Grok Bot レーン（8時）詳細

**使用API**: xAI `/v1/responses`、model `grok-4.6`、tools `[{type:"x_search"}]`（x-ai-tips-collect と同じ方式）

**トピック（オージャスト向け）**:

| # | purpose | query |
|---|---------|-------|
| 1 | business | `展示会 ブース トレンド 2026 競合 最新` |
| 2 | business | `exhibition booth design trend 2026 innovation` |
| 3 | business | `イベント マーケティング BtoB 展示会 出展 効果` |
| 4 | business | `ブースデザイン AI 制作 効率化 実例` |
| 5 | business | `競合 展示会 出展 ニュース 発表` |

**制約**:
- 最大5件/テーマ（合計25件上限だが、重要度S/A/Bフィルター後5件に絞る）
- 直近24時間以内の投稿
- `likes >= 10`（x-ai-tips-collect と同じ閾値）
- 重複URLは排除（state.json の既知リストと照合）
- 自社（orgiast/jpドメイン）関連は除外しない（必要なら不要分を後処理）

**既存コードの再利用**:
- `x-ai-tips-collect.mjs` の設定追加モード（`--purpose business` だけ実行）
- または新規 `tools/daily-grok-research.mjs`（薄いラッパー）

### 2.3 Muse レーン（9時）詳細

Muse はこの設計では「公式一次情報調査エージェント」のロール名であり、特定AI製品ではなく既存の `llm-ask.mjs` 経由で Gemini Flash / DeepSeek へ委譲する。

**方式**: `tools/llm-ask.mjs --kind investigate` に公式サイトURL一覧と調査クエリを渡す。

**調査対象（オージャスト向け）**:

| # | 調査対象 | 調査クエリ |
|---|---------|-----------|
| 1 | 主要競合（野村興産・八興・田中ブース等）のHPニュース | `各社URLのニュース/お知らせページ 前日からの更新を抽出` |
| 2 | 展示会業界ニュースサイト | `展示会業界の最新ニュース プレスリリース` |
| 3 | イベント企画・運営関連の公式発表 | `イベント業界の新サービス ツール プラットフォーム発表` |
| 4 | 日本展示会協会・業界団体 | `展示会協会の最新情報 ガイドライン改正 統計` |

**新規スクリプト設計案**: `tools/daily-muse-research.mjs`

```mjs
// 疑似コード
import { llmAsk } from './llm-ask.mjs';

const TARGETS = [
  { name: '野村興産', url: 'https://www.nomura-booth.co.jp/news/', query: 'お知らせ一覧から前日更新分を抽出' },
  { name: '展示会協会', url: 'https://www.npo-jeca.jp/news/', query: '最新のニュース・イベント情報' },
  // ... 設定ファイルから読み込み
];

async function main() {
  for (const target of TARGETS) {
    const result = await llmAsk(target.query, {
      url: target.url,
      kind: 'investigate',
      provider: 'gemini', // 低コストでWeb検索可能
    });
    // 結果を蓄積
  }
  // 統合JSONを出力
}
```

### 2.4 重要度分類基準

| 重要度 | 定義 | 判定方法 | 例 |
|--------|------|---------|-----|
| **S**（最重要） | 競合の新製品/サービス発表、業界の構造変化、オージャストの事業に直接影響 | xAI confidence `high` + キーワード一致（発表・リリース・新規・開始） | 競合が新ブース商品を発表、展示会協会がルール改定 |
| **A**（重要） | トレンド記事、ベストプラクティス、業界動向、参考になる実例 | xAI confidence `high` or `medium` + トレンド系キーワード | 展示会マーケティングの成功事例、ブースデザイントレンド |
| **B**（参考） | 汎用的な知見、背景情報、既知トピックのフォローアップ | 上記以外 | AIツールのアップデート、一般的なノウハウ記事 |

**分類の自動化**: xAI API の応答に含まれる文中のキーワードと `confidence` 値から機械分類。閾値は設定で調整可能。

### 2.5 差分報告フォーマット

```
# 📰 毎朝ニュース速報 2026-11-12

## 🔴 S（最重要）— 1件
1. 【S】競合X社が新ブース製品「○○」発表
   出典: X（@companyX） / ○○公式プレスリリース
   重要度: S / カテゴリ: 競合動向
   サマリ: 再利用可能ブースの新ライン。オージャストのRe:ブースと競合。

## 🟠 A（重要）— 2件
1. 【A】展示会マーケティング2026トレンド
   出典: X（@exhibition_trend）
   ...

## 🔵 B（参考）— 2件
1. 【B】AIブースデザインツールの新機能
   ...

---
*前回比: 新規5件 / 重複除外3件 / 重要度S:1 A:2 B:2*
```

---

## 3. 既存リソースとの統合

### 3.1 x-ai-tips-collect.mjs との関係

| 観点 | x-ai-tips-collect（既存） | Grok Bot レーン（本設計） | 補完関係 |
|---|---|---|---|
| 目的 | AI活用Tips収集（cost/site/business） | 展示会・競合・イベント動向（business特化） | トピックを分担。既存configに追加すれば統合可能 |
| 実行時刻 | 夜間batch内 | 朝8時固定 | 別時刻運用 |
| 出力先 | ai-news-proposals.jsonl | reports/daily-news-*.md（+提案ファイル） | proposals への登録は共通 |
| 費用枠 | maxCalls:8 / $2/日 | Grok + Muse で別予算 | 設定で分離または統合 |

### 3.2 muse-handoff（既存）との関係

`muse-handoff.mjs` は認証情報の暗号化委譲機能であり、本設計の「Muse レーン（公式一次情報調査）」とは異なるレイヤー。

- muse-handoff → API鍵の安全な共有（キー管理基盤）
- Muse レーン → 公式情報調査エージェント（業務フロー）

将来的に Muse レーンが外部AI（Muse Wonder 等）で動作する場合、`muse-handoff` で認証情報を暗号化して渡せる。

### 3.3 next-session.md との関係

毎朝のレポートは自動的に残TODOに影響しない。重要度Sの案件は必要に応じて手動で next-session.md へ転記する（自動転記は初期フェーズでは行わない）。

---

## 4. コスト見積もり

### 4.1 Grok Bot レーン（xAI API）

| 項目 | 単価 | 想定使用量 | 日額 | 月額（22営業日） |
|------|------|-----------|------|----------------|
| 入力トークン | $3/100万トークン | ~5K/回 × 5トピック = 25K | $0.075 | $1.65 |
| 出力トークン | $15/100万トークン | ~2K/回 × 5 = 10K | $0.15 | $3.30 |
| x_search（投稿取得） | $0.005/投稿 | 5件/トピック × 5 = 25件 | $0.125 | $2.75 |
| x_search（ユーザー照会） | $0.01/回 | 5件取得中に発生 | $0.05 | $1.10 |
| **Grok Bot 計** | | | **$0.40** | **$8.80** |

### 4.2 Muse レーン（Gemini Flash / DeepSeek）

| 項目 | 単価 | 想定使用量 | 日額 | 月額 |
|------|------|-----------|------|------|
| Gemini Flash（Web検索） | $0.075/100万入力 + grounding 無料 | 4調査 × 1K = 4K | $0.003 | $0.07 |
| DeepSeek（代替） | $0.27/100万入力 | 同左 | $0.001 | $0.02 |
| **Muse レーン計** | | | **~$0.01** | **~$0.20** |

### 4.3 総計

| 区分 | 日額 | 月額 |
|------|------|------|
| Grok Bot（xAI） | $0.40 | $8.80 |
| Muse（Gemini Flash） | $0.01 | $0.20 |
| **合計** | **$0.41** | **$9.00** |

x-ai-tips-collect の既存枠（max $2/日）に $0.40 を加算する形で予算枠内に収まる。

---

## 5. 実装計画（フェーズ分け）

### Phase 0（本セッション: リサーチ完了）✅
- [x] 現状分析（既存x-ai-tips-collect / grok-bot-prompt-bridge / muse-handoff）
- [x] 役割分担設計（Grok Bot 8時 X調査 / Muse 9時 公式調査）
- [x] コスト見積もり
- [x] 重要度S/A/B分類基準の策定

### Phase 1（次セッション: 設定変更）
- [ ] `config/x-ai-tips-topics.json` に展示会・競合トピックを追加（上記5トピック）
- [ ] x-ai-tips-collect に `--purpose business` フィルタモード追加
- [ ] x-ai-tips-collect に8時実行用 cron 設定追加（夜間batch分と分離）

### Phase 2（次次セッション: Muse レーン実装）
- [ ] `tools/daily-muse-research.mjs` 作成（llm-ask ラッパー）
- [ ] 公式調査対象URLリスト設定ファイル作成
- [ ] 9時実行 cron 設定

### Phase 3（統合・レポート）
- [ ] 統合レポート生成（重複除去・重要度分類・差分検出）
- [ ] state 管理（既知URL・ハッシュ履歴）
- [ ] kim-inbox / Discord DM 配送
- [ ] 検証: 1週間連続動作確認

---

## 6. 参考リソース

- [xAI API ドキュメント](https://docs.x.ai/developers) — x_search / cost tracking / pricing
- [x-ai-tips-collect.mjs](../tools/x-ai-tips-collect.mjs) — 既存X収集実装
- [grok-bot-prompt-bridge.mjs](../tools/grok-bot-prompt-bridge.mjs) — Grok→Claude Code ブリッジ
- [muse-handoff.mjs](../tools/muse-handoff.mjs) — 認証情報暗号化委譲（P-0306）
- [llm-ask.mjs](../tools/llm-ask.mjs) — 汎用LLM呼び出し（調査・分類・要約）
- [docs/x-ai-tips-loop.md](../docs/x-ai-tips-loop.md) — xAI収集ループ仕様
- [config/x-ai-tips-topics.json](../config/x-ai-tips-topics.json) — 収集トピック設定
- [X-0014: Grok Bot + Claude Code コーディングワークフロー](./ai-news-x0014-grok-bot-coding-workflow.md) — 既存Grok Bot活用設計
- [P-0306: Muse Credential Handoff](../docs/plans/P-0306-muse-credential-handoff.md) — 認証情報委譲基盤

---

## 7. 意思決定記録

| 日付 | 決定 | 理由 |
|------|------|------|
| 2026-11-12 | Grok Bot = xAI API / x_search を使用 | 既存のx-ai-tips-collectと同じ経路。別API不要。コスト最小。 |
| 2026-11-12 | Muse = llm-ask (Gemini Flash) を使用 | 公式一次情報調査はWeb検索が主。Gemini Flashはgrounding内蔵で低コスト。 |
| 2026-11-12 | 頻度は1日1回、まず2週間運用 | むやみに増やさない方針。必要ならPhase 3後に見直す。 |
| 2026-11-12 | クロスソース重複除去はURLベース + 内容ハッシュ | x-ai-tips-collect が既に実装済みの方式を踏襲。 |
| 2026-11-12 | レポート配送先はkim-inbox（初期） | Discord DM は宛先未解決リスク。kim-inbox は全セッションで確実に読み取り可能。 |