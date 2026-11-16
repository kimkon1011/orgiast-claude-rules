# X-0019 AI SEOエージェントによるミニサイト展開自動化

> 作成: 2026-11-15 | ステータス: 設計完了 / 実装フェーズ

## 概要

AIエージェント（Hermes/OpenClaw/Claude Code）をVPS上で稼働させ、SEO分析・コンテンツ戦略・ミニサイト展開を自動実行するシステム。

### アーキテクチャ

```
[VPS $10/月] ──→ AI Agent ──→ SEO MCP Tools ──→ Mini-site Generator
                  │                    │                    │
                  ├─ GSC分析            ├─ Keyword Research   ├─ Template Render
                  ├─ GA4分析            ├─ Content Strategy   ├─ Static Site Gen
                  ├─ 競合分析            ├─ Internal Link      └─ Deploy (Vercel/CF)
                  └─ レポート生成         └─ Rank Tracking
```

## 1. コンポーネント

### 1.1 エージェントプラットフォーム（選択肢）

| 方式 | 月額 | 導入期間 | 自動化度 | 備考 |
|------|------|---------|---------|------|
| A: Claude Code + GAS | $0〜5 | 1〜2日 | 中 | 既存環境流用、GAS 6分/回制限 |
| B: Hermes/OpenClaw on VPS | $10〜30 | 1〜2週間 | 高 | 本命。Hetzner CX22 $10.89/月 |
| C: カスタムNode.js + GitHub Actions | $1〜10 | 3〜5日 | 中 | VPS不要、Actions無料枠内 |
| **D: 既存ツール統合（推奨）** | **$0〜1** | **1日** | **中** | **既存のdaily-seo-guide/gsc-keyword-finderをcron統合** |

### 1.2 SEO MCP / ツール群

| ツール | 役割 | 既存実装 |
|--------|------|---------|
| GSC Keyword Finder | 高IMP低CTRキーワード検出 | `tools/gsc-keyword-finder.mjs` |
| SEO Content Complement | コンテンツギャップ補完 | `tools/seo-content-complement.mjs` |
| Daily SEO Guide | 毎日1本SEOガイド生成 | `tools/daily-seo-guide.mjs` |
| Competitor Analysis | 競合コンテンツ構造分析 | `tools/competitor-content-structure.mjs` |
| AI SEO Workflow | ワークフロー全体制御 | `tools/ai-seo-agent-workflow.mjs`（本Runbookで拡張） |
| Agent Integration | 外部エージェント連携 | `tools/agent-integration-plan.mjs` |

## 2. 自動実行パイプライン

### 2.1 全体フロー

```
毎日 06:00 ─→ GSC Keyword Finder → キーワード候補抽出
      06:30 ─→ 候補スコアリング → 本日生成対象を決定
      07:00 ─→ Daily SEO Guide → 記事生成 (codex-do委譲)
      07:30 ─→ SEO Content Complement → 内部リンク・補完
      08:00 ─→ ミニサイトテンプレート → 静的サイト生成
      08:30 ─→ Deploy (CF Pages / Vercel)
      09:00 ─→ レポート生成 → kim-inbox通知
```

### 2.2 週次フロー

```
毎週月曜 06:00 ─→ GSC 7日間データ分析 → 戦略見直し
毎週水曜 06:00 ─→ 競合分析 → コンテンツギャップレポート
毎週金曜 06:00 ─→ 総合レポート + 次週計画
```

## 3. デプロイ手順

### 3.1 前提条件

- Node.js 18+ が動作する環境（VPS または GitHub Actions）
- Google Search Console API 認証（`keys/aujust-sheets-reader.json`）
- Google Analytics Data API 認証（任意）
- Cloudflare / Vercel アカウント（ミニサイト公開先）

### 3.2 セットアップ

```bash
# リポジトリクローン
git clone https://github.com/kimkon1011/orgiast-claude-rules.git
cd orgiast-claude-rules

# 依存���係インストール
npm install googleapis @googleapis/searchconsole @google-analytics/data

# 認証鍵配置
cp /path/to/aujust-sheets-reader.json keys/

# cron登録（Linux / WSL）
crontab -e
# 以下を追記:
# 0 6 * * * cd /path/to/repo && node tools/ai-seo-agent-workflow.mjs --mode daily >> logs/seo-agent.log 2>&1
# 0 8 * * 1 cd /path/to/repo && node tools/ai-seo-agent-workflow.mjs --mode weekly >> logs/seo-agent-weekly.log 2>&1
```

### 3.3 VPS セットアップ（方式B）

```bash
# Hetzner CX22 $10.89/月で注文
# Ubuntu 22.04 LTS
ssh root@<VPS_IP>

# 基本セットアップ
apt update && apt upgrade -y
apt install -y nodejs npm git
npm install -g n
n 18

# リポジトリクローン
git clone https://github.com/kimkon1011/orgiast-claude-rules.git /opt/seo-agent
cd /opt/seo-agent
npm install

# 認証鍵配置（scp等）
# systemd service登録
cat > /etc/systemd/system/seo-agent.service << 'SERVICEEOF'
[Unit]
Description=AI SEO Agent
After=network.target

[Service]
Type=oneshot
User=root
WorkingDirectory=/opt/seo-agent
ExecStart=/usr/local/bin/node tools/ai-seo-agent-workflow.mjs --mode daily
StandardOutput=append:/var/log/seo-agent.log
StandardError=append:/var/log/seo-agent.log

[Install]
WantedBy=multi-user.target
SERVICEEOF

systemctl daemon-reload

# cronで毎日実行
echo "0 6 * * * root systemctl start seo-agent" >> /etc/crontab
```

### 3.4 GitHub Actions 方式（方式C・推奨暫定）

```yaml
# .github/workflows/seo-agent-daily.yml
name: SEO Agent Daily
on:
  schedule:
    - cron: '0 6 * * *'
  workflow_dispatch:

jobs:
  seo-agent:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 18
      - run: npm install
      - run: node tools/ai-seo-agent-workflow.mjs --mode daily --json
        env:
          GOOGLE_APPLICATION_CREDENTIALS: ${{ secrets.GCP_SA_KEY }}
      - uses: actions/upload-artifact@v4
        with:
          name: seo-report
          path: outputs/X-0019/reports/
```

## 4. ミニサイト展開

### 4.1 テンプレート

ミニサイトは以下5テーマから開始:

| # | テーマ | ターゲットKW | コンテンツ構成 |
|---|--------|-------------|--------------|
| 1 | 展示会ブース費用相場 | ブース費用, 相場, 予算, 坪単価 | 費用テーブル+規模別事例+見積CTA |
| 2 | 小規模ブースデザイン | 小規模, 3坪, 6坪, 島ブース | 実績ギャラリー+レイアウト例+費用目安 |
| 3 | 展示会集客施策 | 集客, ノベルティ, ブース誘導 | 施策リスト+事例+チェックリストDL |
| 4 | イベント企画代行 | イベント企画, 運営代行, 丸投げ | サービス一覧+フローチャート+実績 |
| 5 | ブース製作会社比較 | ブース製作会社, 選び方, 比較 | 選定基準+自社の強み+比較表 |

### 4.2 生成→公開フロー

```
1. キーワード決定 ← GSC分析または手動指定
2. コンテンツ生成 ← daily-seo-guide.mjs
3. HTMLテンプレート反映 ← テンプレートエンジン
4. 内部リンク最適化 ← seo-content-complement.mjs
5. プレビュー生成 ← ローカルHTML
6. デプロイ ← CF Pages / Vercel / gh-pages
7. インデックス確認 ← URL Inspection API
8. レポート ← 翌日のGSCで効果測定
```

## 5. 監視・レポート

### 5.1 日次レポート（kim-inbox通知）

- 生成した記事 / ミニサイト
- GSCインプレッション推移（前日比）
- クリック数 / CTR
- 掲載順位変化
- エラー・警告

### 5.2 週次レポート

- 週間サマリ（全KPI）
- キーワード順位変動トップ10
- コンテンツギャップ分析
- 次週アクションプラン

## 6. 人間監視（必須ルール）

> **オージャストのブース/イベントサイトで試す際は人間監視を必須とする**

- 生成コンテンツの公開前レビュー期間: 初月は全件kim承認
- 2ヶ月目以降: 週1回サンプリングレビュー
- 自動公開の閾値: SEOスコア80点以上のみ自動公開
- 緊急停止: kim-inbox に `[SEO-AGENT-STOP]` と送信

## 7. 費用試算

| 項目 | 月額 | 年額 | 備考 |
|------|------|------|------|
| VPS (Hetzner CX22) | $10.89 | $130.68 | 方式Bのみ |
| GSC API | $0 | $0 | 無料枠内 |
| GA4 API | $0 | $0 | 無料枠内 |
| CF Pages | $0 | $0 | 無料枠 |
| 合計（方式D推奨） | $0〜1 | $0〜12 | Actions + 既存ツール統合 |
| 合計（方式B） | $10.89〜30 | $130〜360 | VPS + API従量 |

## 8. 既存ツールとの統合

| 既存ツール | X-0019での役割 | 統合方法 |
|-----------|---------------|---------|
| `gsc-keyword-finder.mjs` | キーワード入力 | パイプ入力 |
| `daily-seo-guide.mjs` | コンテンツ生成 | サブプロセス呼出 |
| `seo-content-complement.mjs` | 補完・最適化 | サブプロセス呼出 |
| `competitor-content-structure.mjs` | 競合分析 | 週次フロー |
| `ai-seo-agent-workflow.mjs` | **統合オーケストレータ** | 本ツールが全制御 |
| `agent-integration-plan.mjs` | エージェント連携設計 | 設定参照 |

## 9. 次のステップ

- [ ] 方式D（既存ツール統合）のcron設定と試験稼働
- [ ] kim-inboxへの日次レポート通知パイプライン
- [ ] 初回GSC分析レポート生成
- [ ] ミニサイトテンプレートHTML作成
- [ ] VPS（方式B）の試験導入判断