# X-0029: Ahrefs監査をAIでSEO優先度付け

**ステータス**: ✅ ツール実装完了・サンプル動作確認済み
**ブロッカー**: Ahrefs APIキー / データエクスポート未入手・Search Console SA鍵不在
**作成日**: 2026-11-11

## 概要

Ahrefs Site Audit のエラー一覧と Google Search Console のページ別データを統合し、AIによる修正優先度判定を行うツールとワークフロー。

## 作成物

| ファイル | 説明 |
|---------|------|
| `seo/ahrefs-gsc-priority.mjs` | 統合・優先度判定ツール |
| `sample-ahrefs.csv` | Ahrefs Site Audit サンプルデータ |
| `sample-gsc.csv` | Search Console サンプルデータ |
| `sample-output.md` | サンプルデータ実行結果 |
| `orgiast-schema-audit.md` | 実際の www.orgiast.jp スキーマ監査結果 |

## 使い方

```bash
# 実際のデータで実行
node seo/ahrefs-gsc-priority.mjs \
  --ahrefs seo/ahrefs-site-audit.csv \
  --gsc seo/pages.csv \
  --output outputs/X-0029/priority-table.md

# サンプルデータでテスト
node seo/ahrefs-gsc-priority.mjs --sample
node seo/ahrefs-gsc-priority.mjs --ahrefs outputs/X-0029/sample-ahrefs.csv --gsc outputs/X-0029/sample-gsc.csv
```

## 優先度判定ロジック

修正優先度 = f(問題の重大性, 検索流入影響, 影響範囲)

| 要素 | 重み | 判定基準 |
|------|------|---------|
| 重大性 | Error=3 / Warning=2 / Notice=1 | Ahrefs の重大度 |
| 検索流入 | 高=3(click≧100/imp≧10k) / 中=2 / 低=1 | GSC クリック数・表示回数 |
| 影響範囲 | 高=3(≧50page) / 中=2(≧10) / 低=1 | 影響ページ数 |

- 🔴 緊急 (score≧18): 直ちに修正
- 🟠 高 (score≧9): 優先的に修正
- 🟡 中 (score≧4): 計画的に修正
- 🟢 低 (score<4): 余裕のあるときに

## サンプルデータ実行結果（要約）

15件のサンプルデータを処理し、以下の優先度分布を得た:

- 🟠 高: 2件（トップページmeta description欠如 / 問い合わせページリンク切れ）
- 🟡 中: 7件（H1欠如・タイトル重複・読み込み速度・alt属性・テキスト比率等）
- 🟢 低: 6件（4xxエラー・ディレクトリリスティング・OGP不足等）

## ブロッカー

本番データでの実行には以下が必要:

1. **Ahrefs Site Audit の CSV エクスポート**: orgiast.jp の Ahrefs Site Audit 結果を CSV でエクスポート
2. **Search Console データ**: `seo/export-search-console.mjs` でエクスポート（SA鍵要）
3. **または**: 両データを手動で CSV に整形してツールに渡す

## スキーマ監査結果（実測）

www.orgiast.jp の構造化データを監査した結果:

- ✅ Organization: 必須項目すべてあり（推奨欠落: logo）
- ✅ WebSite: 必須項目すべてあり（推奨欠落: description, potentialAction）
- ✅ FAQPage: 必須項目すべてあり

**問題点**:
- 古い All in One SEO Pack (v2.11, 2016年) を使用
- ページタイトルが「社内イベント」に偏り、展示会ブース制作がSEO上のメインKWになっていない
- viewport 固定 (1024px) でモバイルファーストではない
- 事例ページ（case-studies）が存在しない
