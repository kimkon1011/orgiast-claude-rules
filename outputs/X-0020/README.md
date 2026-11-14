# X-0020 出力: スマホGrok経由Claude Codeのテスト付きサイト更新

**ステータス**: PHASE1 基盤構築完了（2026-11-11）
**関連**: X-0014（Grok Bot + Claude Code コーディング手順）

## 成果物

| ファイル | 内容 |
|---------|------|
| `docs/ai-news-x0020-site-test-deploy-workflow.md` | 設計文書（パイプライン図・ツール構成・適用計画） |
| `tools/site-test-runner.mjs` | テスト実行CLI（全6スイート＋変更種別自動選択） |
| `tools/site-test-runner.test.mjs` | テストランナーのテスト（9ケース） |
| `tools/site-test-suites.mjs` | テストスイート定義（6スイート） |
| `tools/site-test-suites.test.mjs` | スイートのテスト（15ケース） |
| `tools/grok-bot-test-report.mjs` | Grok Bot 向けMarkdownレポート生成 |
| `tools/grok-bot-test-report.test.mjs` | レポーターのテスト（10ケース） |
| `tools/site-update-hook.mjs` | Git hookスクリプト（自動テスト起動） |
| `outputs/X-0020/sample-grok-request.json` | Grok Bot からの構造化リクエストサンプル |

## テストスイート

| スイートID | チェック内容 |
|-----------|-------------|
| `html-valid` | DOCTYPE・lang=ja・charset・viewport・title・h1・main |
| `links` | リンクのhref存在確認 |
| `seo-meta` | title 30-60字・h1重複・canonical・og:title |
| `performance` | HTMLサイズ < 50KB・画像数 < 20 |
| `structure` | 見出し階層・img alt属性 |
| `wcag-basic` | tabindex・img alt（WCAG 1.1.1） |

## 使用方法

### テスト実行
```bash
# 全スイート実行
node tools/site-test-runner.mjs --url https://orgiast.jp

# 特定スイートのみ
node tools/site-test-runner.mjs --url https://orgiast.jp --suites html-valid,seo-meta

# 変更種別から自動選択
node tools/site-test-runner.mjs --url https://orgiast.jp --change-type text
```

### Grok Bot 向けレポート
```bash
# テスト結果JSONからレポート生成
node tools/grok-bot-test-report.mjs --results sample-test-report.json --url https://orgiast.jp/

# サンプル表示
node tools/grok-bot-test-report.mjs --sample
```

### Git hook（自動テスト）
```bash
# SITE_URL を設定してからコミット
export SITE_URL=https://orgiast.jp
git commit -m "実績セクション更新"
# → 自動でテスト実行 → PASSならコミット継続、FAILならブロック
```

## 次のステップ（Phase 2）

1. [ ] GitHub Actions でテスト実行 (`.github/workflows/site-test.yml`)
2. [ ] Grok Bot API Webhook の登録
3. [ ] プレビュー環境のセットアップ（Vercel Preview / GitHub Pages）
4. [ ] 実際の orgiast.jp 更新パイプラインへの適用