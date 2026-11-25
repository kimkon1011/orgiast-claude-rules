# AIニューステーマ提案 運用計画

> **X-0062 ⑤** | 作成: 2026-11-18 | 更新: 2026-11-18 | ステータス: 初版

## 概要

本ドキュメントは、AIニューステーマ提案ワークフロー（`docs/news-theme-workflow.md`）の運用を具体化する計画書である。
各Phaseの実行主体・スケジュール・自動化方式を定め、月次サイクルを確実に回すための体制を定義する。

### 運用方針

| 方針 | 内容 |
|------|------|
| 自動化できるものは自動化する | Google Trends収集、提案ファイル生成、ChatGPT入力フォーマット生成、通知 |
| 人間にしかできないことは人間がやる | ChatGPT評価（Phase 2）、記事化判断（Phase 4） |
| ボトルネックは可視化する | 各Phaseの状態をGASシートで管理し、遅延時はDiscord通知 |
| 障害時はフォールバックする | CI cron / GAS / 手動実行の3経路を確保 |

---

## 1. 月次サイクル全体像

### タイムライン

```
Day 1（每月1日 09:00 JST）
  ├── [自動] Phase 1: Google Trends KW収集 (CI cron)
  ├── [自動] 提案ファイル生成 (CI cron)
  ├── [自動] ChatGPT入力フォーマット生成 (CI cron)
  ├── [自動] Discord通知 (GAS time-driven trigger)
  └── [自動] GAS提案一覧シート初期化 (GAS)

Day 2-3（人間作業）
  └── [人間] Phase 2: ChatGPTにKW候補を投入・評価

Day 3（人間作業完了後）
  ├── [人間] 評価結果を提案ファイルに反映 (Git push)
  └── [自動] GAS提案一覧シート同期 (手動トリガー or CI)

Day 3-5（人間判断）
  └── [人間] Phase 4: 記事化判断（執筆着手 or バックログ）

Day 5（09:00 JST）
  └── [自動] 未着手提案リマインダー (GAS time-driven trigger)

月末 (23:00 JST)
  └── [自動] 当月運用サマリ生成 (GAS time-driven trigger)
```

### 責務分担

| Phase | 実行主体 | 自動化方式 | 所要時間目安 |
|-------|---------|-----------|-------------|
| Phase 1（KW収集） | CI cron (GitHub Actions) | node seo/x0057-ai-news-pipeline.mjs | 約5分 |
| Phase 1.5（入力整形） | CI cron | フォーマット自動生成 | 約1分 |
| Phase 2（ChatGPT評価） | 人間 (kim or 編集担当) | ブラウザ操作 + 手動入力 | 約30分 |
| Phase 3（提案生成） | CI cron + 人間追記 | 自動生成 + 手動プッシュ | 約5分 (自動) + 10分 (人間) |
| Phase 4（記事化判断） | 人間 | 判断 + 指示 | 約15分 |
| Phase 5（効果検証） | CI cron + GAS | 自動集計 + シート反映 | 約10分 |

---

## 2. CI cron 自動化（GitHub Actions）

### 2.1 ワークフロー定義

`.github/workflows/ai-news-pipeline.yml` を新規作成する。

```yaml
name: AI News Pipeline (Monthly)
on:
  schedule:
    - cron: "0 0 1 * *"   # 每月1日 00:00 UTC = 09:00 JST
  workflow_dispatch:       # 手動トリガーも可能

jobs:
  collect-and-propose:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22

      - name: Install dependencies
        run: npm ci

      - name: Phase 1 — Google Trends KW収集
        run: node seo/x0057-ai-news-pipeline.mjs --mode full
        env:
          NODE_OPTIONS: --experimental-vm-modules

      - name: ChatGPT入力フォーマット生成
        run: node tools/ai-news-inject.mjs --format chatgpt-input
        env:
          NODE_OPTIONS: --experimental-vm-modules

      - name: 提案ファイルをコミット
        run: |
          git config user.name "orgiast-fleet[bot]"
          git config user.email "fleet@orgiast.jp"
          git add outputs/X-0057/
          git diff --cached --quiet || git commit -m "feat(ai-news): auto monthly proposals $(date +%Y-%m)"

      - name: プッシュ
        run: git push
```

### 2.2 必要なSecrets

| Secret名 | 用途 | 取得元 |
|----------|------|--------|
| GH_TOKEN | プッシュ用トークン | GitHub設定（PAT） |
| DISCORD_WEBHOOK_URL | Discord通知用 | Discordチャンネル設定 |

### 2.3 CI失敗時の挙動

| 失敗箇所 | 影響 | フォールバック |
|----------|------|---------------|
| Google Trends API不通 | KW収集スキップ、当月は前月のKWを再利用 | 手動実行 (`--mock` 付きで代替) |
| npm install 失敗 | ワークフロー全体失敗、再実行 | `workflow_dispatch` で再トリガー |
| push 失敗 | 提案ファイルはローカルのみに残る | GAS通知でkim確認依頼 |

---

## 3. GAS定期実行（提案管理）

### 3.1 GASプロジェクト構成

新規GASプロジェクトを作成する。

```
gas/news-theme-proposals/
├── appsscript.json          # OAuth設定
├── Setup.gs                 # 初回セットアップ
├── ProposalSheet.gs         # 提案一覧シート操作
├── DiscordNotify.gs         # Discord通知
└── CommandQueue.gs          # コマンドキュー（既存パターン流用）
```

### 3.2 appsscript.json

```json
{
  "timeZone": "Asia/Tokyo",
  "oauthScopes": [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/script.external_request"
  ],
  "runtimeVersion": "V8",
  "executionApi": { "access": "MYSELF" },
  "webapp": { "executeAs": "USER_DEPLOYING", "access": "MYSELF_ONLY" }
}
```

### 3.3 Google Sheets構成

**スプレッドシート**: AIニュース提案管理（初回Setup.gs実行時に自動作成）

| 列 | ヘッダ名 | 型 | 説明 |
|----|---------|-----|------|
| A | 提案ID | string | x0062-YYYYMMDD-NN |
| B | キーワード | string | 提案の元となったKW |
| C | 検索意図タイプ | string | 情報収集/比較検討/取引・購入/ナビゲーション |
| D | 検索意図詳細 | string | 具体的な検索意図の説明 |
| E | 判定 | string | 新規記事向き/追記向き/対象外 |
| F | 優先度 | string | 高/中/低 |
| G | 推奨タイトル | string | 新規記事向きの場合のタイトル案 |
| H | 状態 | string | 未着手/進行中/完了/スキップ |
| I | 作成日 | date | 提案が生成された日 |
| J | 記事化日 | date | 実際に記事化された日 |
| K | 記事URL | string | 公開された記事のURL |
| L | 備考 | string | 自由メモ |

### 3.4 GASトリガー設定

| トリガー名 | スケジュール (cron) | 処理概要 | 関数名 |
|-----------|-------------------|---------|--------|
| monthlyProposalCheck | `0 0 1 * *` | 提案ファイル確認 + Discord通知 | `checkMonthlyProposals` |
| weeklyReminder | `0 0 5 * *` | 未着手提案リマインダー | `sendReminder` |
| monthlySummary | `0 14 L * *` | 当月運用サマリ生成 | `generateMonthlySummary` |

### 3.5 スクリプトプロパティ

| プロパティ | 説明 | 設定タイミング |
|-----------|------|---------------|
| SHEET_ID | 管理スプレッドシートID | Setup.gs で自動設定 |
| DISCORD_WEBHOOK | Discord通知用Webhook URL | Setup.gs の初回入力 |
| GH_REPO | 連携するGitHubリポジトリ | 手動設定 |
| MONTHLY_WORKFLOW | 月次ワークフローの状態 | 自動管理 |

---

## 4. Discord通知設計

### 4.1 通知チャンネル

| チャンネル | 用途 |
|-----------|------|
| #ai-news | 全般的なAIニュース提案の進捗・結果通知 |
| @kim (DM) | 判断依頼・遅延警告（緊急度が高いもののみ） |

### 4.2 通知内容

#### Phase 1 完了通知 (#ai-news)
```
📡 AIニュースKW収集完了
- 収集日: YYYY-MM-DD
- 取得KW数: N件
- 新規記事候補: M件
- 追記候補: K件
📋 ChatGPT入力フォーマット:
  https://github.com/orgiast-jp/nightly-repo/blob/main/outputs/X-0057/YYYY-MM-DD-chatgpt-input.md
```

#### リマインダー通知 (@kim DM)
```
⏰ AIニュース提案リマインダー
- Phase 2（ChatGPT評価）が未完了です
- 期日: YYYY-MM-DD（残りN日）
- 遅延すると次週の記事執筆に影響します
```

#### サマリ通知 (#ai-news)
```
📊 YYYY年MM月 AIニュース提案サマリ
- 提案総数: N件
- 記事化済み: M件（率: X%）
- スキップ: K件
- 次月への持ち越し: L件
```

---

## 5. 障害・遅延対応

### 5.1 各Phaseのタイムアウト

| Phase | 期限 | 超過時の対応 |
|-------|------|-------------|
| Phase 1 | Day 1 12:00 JST | CI再実行 or 手動実行 |
| Phase 2 | Day 3 18:00 JST | kimにDiscord通知、代替担当者への依頼 |
| Phase 3 | Day 4 12:00 JST | 前月の提案を持ち越し |
| Phase 4 | Day 5 18:00 JST | 次月に繰り越し |

### 5.2 エスカレーションパス

```
1次: Discord #ai-news への自動通知
2次: @kim DM + kim-inbox への記録
3次: 全自動経路失敗 → 手動実行手順に切り替え
```

### 5.3 手動実行手順（フォールバック）

```bash
# すべての自動経路が使えない場合
cd /c/Users/user/.claude/nightly-repo

# Phase 1: KW収集
node seo/x0057-ai-news-pipeline.mjs --mode full

# ChatGPT入力フォーマット生成
node tools/ai-news-inject.mjs --format chatgpt-input

# 提案ファイルの場所
# outputs/X-0057/YYYY-MM-DD-proposals.json
```

---

## 6. 運用管理

### 6.1 月次チェックリスト

| # | 項目 | 確認タイミング |
|---|------|---------------|
| 1 | CI cronが予定通り実行されたか | Day 1 10:00 |
| 2 | 提案ファイルが生成されたか | Day 1 10:00 |
| 3 | ChatGPT入力フォーマットが生成されたか | Day 1 10:00 |
| 4 | Discord通知が届いたか | Day 1 10:00 |
| 5 | Phase 2が完了したか | Day 3 |
| 6 | Phase 3のファイルが反映されたか | Day 3-4 |
| 7 | Phase 4の判断が完了したか | Day 5 |
| 8 | GAS提案一覧が最新状態か | Day 5 |

### 6.2 四半期レビュー

3ヶ月に1回、以下の項目を見直す：

| # | 項目 | 判断基準 |
|---|------|---------|
| 1 | シードキーワードの見直し | 検索トレンドの変化に追従できているか |
| 2 | ChatGPT分類精度の評価 | 記事化したテーマのパフォーマンス |
| 3 | GAS運用コストの評価 | 無料枠内か、有料化が必要か |
| 4 | 通知設計の過不足 | 通知過多で無視されていないか |
| 5 | ワークフロー手順の陳腐化 | 実際の運用と乖離していないか |

---

## 7. 初期セットアップ手順

### 7.1 CI cron設定

```bash
# 1. GitHubリポジトリで Secrets 設定
# Settings → Secrets and variables → Actions
# GH_TOKEN: <PAT>
# DISCORD_WEBHOOK_URL: <Discord Webhook URL>

# 2. ワークフローファイル配置
cp .github/workflows/ai-news-pipeline.yml.ci .github/workflows/ai-news-pipeline.yml
# ※ ファイル名末尾 .ci はテンプレート。有効化時に拡張子除去
```

### 7.2 GASセットアップ

```bash
# 1. GASプロジェクトをデプロイ
cd gas/news-theme-proposals
clasp push

# 2. 初回セットアップを実行
# GASエディタで setupOnce() を実行
# → スプレッドシート自動作成
# → スクリプトトリガー設定

# 3. Discord Webhook URL をスクリプトプロパティに設定
```

### 7.3 運用開始時の確認事項

- [ ] CI cronが正常動作（手動dispatchでテスト実行）
- [ ] Google Trends APIが利用可能
- [ ] GASトリガーが正常動作
- [ ] Discord通知が正しいチャンネルに届く
- [ ] 提案ファイルが出力される
- [ ] ChatGPT入力フォーマットが生成される
- [ ] GAS提案一覧シートが作成される

---

## 8. 関連ファイル

| ファイル | 役割 |
|---------|------|
| `docs/news-theme-workflow.md` | プロセス手順書（本計画のベース） |
| `docs/news-theme-operations-plan.md` | **本ドキュメント** — 運用計画 |
| `docs/ai-news-x0062-ai-agent-seo.md` | X-0062 提案全体の戦略文書 |
| `seo/x0057-ai-news-pipeline.mjs` | Google Trends 収集パイプライン |
| `seo/data/x0057-seed-keywords.json` | シードキーワード定義 |
| `tools/ai-news-inject.mjs` | ChatGPT入力フォーマット生成 |
| `.github/workflows/ai-news-pipeline.yml` | CI cron定義（作成予定） |
| `gas/news-theme-proposals/` | GASプロジェクト（作成予定） |

## 9. 更新履歴

| 日付 | 更新内容 | 担当 |
|------|---------|------|
| 2026-11-18 | 初版作成 | Claude |