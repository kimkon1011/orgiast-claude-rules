# X-0029: Ahrefs監査をAIでSEO優先度付け — orgiast.jp 適用

**ステータス**: ✅ ドキュメント作成完了
**ブロッカー**: Ahrefs Site Audit CSVエクスポート未入手・Search Console SA鍵不在
**作成日**: 2026-11-12

## 概要

X-0024で開発した `seo/ahrefs-gsc-priority.mjs` を www.orgiast.jp に適用するための手順書と実測結果。

## 作成物

| ファイル | 説明 |
|---------|------|
| `docs/ai-news-x0029-ahrefs-gsc-apply-orgiast.md` | AIニュース提案書（適用編） |
| `priority-table.md` | X-0024ツールのモック実行結果 |
| `orgiast-schema-audit.md` | www.orgiast.jp スキーマ監査結果 |

## ブロッカー解消手順

### Search Console データ取得
```bash
# 方法1: SA鍵を配置してエクスポート
# sheets-sa.json を所定のパスに配置後:
node seo/export-search-console.mjs --site "sc-domain:orgiast.jp" --days 90

# 方法2: BigQuery一括エクスポート（推奨）
# GSC管理画面 > 設定 > 一括エクスポート > BigQuery プロジェクトを選択
```

### Ahrefs データ取得
Ahrefsダッシュボード > Site Audit > 該当プロジェクト > Export > CSV
