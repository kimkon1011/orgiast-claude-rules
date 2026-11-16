# X-0053: llms.txt WordPress デプロイガイド（X-0052参照）

> 本ファイルは X-0053 の成果物です。
> **AIクローラー検出・分類・Markdownパイプラインの詳細は `docs/X-0052-ai-crawler-optimize-guide.md` を参照してください。**

## 概要

X-0052 / X-0056 で実装されたツール群を使用して、orgiast.jp に llms.txt / ai.txt をデプロイします。

## ファイル

- **`tools/ai-markdown-gen.mjs`** — コンテンツレジストリから llms.txt を生成
- **`tools/ai-crawler-detect.mjs`** — 22種のAIクローラー検出・nginx map生成
- **`tools/ai-markdown-registry.json`** — コンテンツレジストリ（会社概要・ブース制作・イベント制作・実績・FAQ）
- **`tools/ai-llms-discoverability.test.mjs`** — llms.txt のAI発見性を検証するテスト（X-0056追加）
- **`ai-visibility/x0053-llms-txt/llms.txt`** — デプロイ用テンプレート（手動調整版）

## コンテンツレジストリの項目（X-0056）

| ID | カテゴリ | 内容 |
|----|---------|------|
| top | 概要 | 会社情報・事業内容・全国拠点 |
| booth-production | サービス | Re:ブース特長・提供範囲・展示会実績（9社+展示会名） |
| event-produce | サービス | 社内イベントメニュー・提供フロー・イベント実績（7社） |
| case-studies | 実績事例 | 実績一覧表（クライアント・展示会・規模・業種） |
| faq-cost | FAQ | 費用の目安と問い合わせ方法 |

## 生成方法

```bash
# 標準生成（コンテンツレジストリから自動生成）
node tools/ai-markdown-gen.mjs llms tools/ai-markdown-registry.json "株式会社オージャスト"

# Markdownファイル一括生成
node tools/ai-markdown-gen.mjs render tools/ai-markdown-registry.json ./ai-markdown-output/

# AIサイトマップ生成
node tools/ai-markdown-gen.mjs sitemap tools/ai-markdown-registry.json ./ai-markdown-sitemap.md
```

## デプロイ用テンプレート

`ai-visibility/x0053-llms-txt/llms.txt` は手動で最適化したデプロイ用テンプレートです。自動生成版よりリッチな構造（サブセクション、実績箇条書き、blockquote内要約）を含みます。実際のサイトにデプロイする際はこのテンプレートをサイトルートにコピーします。

### 差分: 自動生成 vs テンプレート

- 自動生成: `tools/ai-markdown-gen.mjs` がレジストリから機械生成 → 簡潔だが網羅的
- テンプレート: 手動で階層化・実績を個別箇条書きに展開 → AI可読性が高い

## 検証

```bash
# AI発見性テスト
node --test tools/ai-llms-discoverability.test.mjs

# ユニットテスト
node --test tools/ai-markdown-gen.test.mjs
```

## 配置

サイトルート (`/llms.txt`, `/ai.txt`) に設置。詳細は `docs/X-0052-ai-crawler-optimize-guide.md` の「デプロイ手順」を参照。