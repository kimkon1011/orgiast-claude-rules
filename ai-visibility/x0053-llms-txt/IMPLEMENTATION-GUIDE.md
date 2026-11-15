# X-0053: llms.txt WordPress デプロイガイド（X-0052参照）

> 本ファイルは X-0053 の成果物です。
> **AIクローラー検出・分類・Markdownパイプラインの詳細は `docs/X-0052-ai-crawler-optimize-guide.md` を参照してください。**

## 概要

X-0052 で実装されたツール群を使用して、orgiast.jp に llms.txt / ai.txt をデプロイします。

## ファイル

- **`tools/ai-markdown-gen.mjs`** — コンテンツレジストリから llms.txt を生成
- **`tools/ai-crawler-detect.mjs`** — 22種のAIクローラー検出・nginx map生成
- **`tools/ai-markdown-registry.json`** — コンテンツレジストリ（サンプル）

## 生成方法

```bash
node tools/ai-markdown-gen.mjs llms tools/ai-markdown-registry.json "株式会社オージャスト"
```

## 配置

サイトルート (`/llms.txt`, `/ai.txt`) に設置。詳細は `docs/X-0052-ai-crawler-optimize-guide.md` の「デプロイ手順」を参照。