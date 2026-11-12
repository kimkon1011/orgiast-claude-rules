# SEO最適化 × AI Overview引用獲得 [X-0001 / X-0003]

## 目的
オージャストの展示会ブース制作サイトをSEO最適化し、Google AI Overviewからの引用獲得を目指す。

## 手順（全19ステップ）
1. ✅ ~~Search Console 3ヶ月データ(Queries.csv, Pages.csv) export~~ → **ブロッカー: SA鍵不在**
2. CLAUDE.mdにサイト情報記述
3-5. 意図・タイトルキーワード・内部リンク・権威・ページリンクの5レバー
7-9. ポジション5-20クエリ抽出→ビジネスポテンシャルフィルタ→作業
12. タイトル最適化（キーワード先頭・約束＋年・600px以下）
14. 同一トピックから3-5内部リンク追加
17. 実変更後90日判断
18-19. Search Console正確クエリフィルタ＋週次5+クリック変動のみ再実行

## 現在のブロッカー
- **Google Search Console API アクセス不可**: サービスアカウント鍵 (`sheets-sa.json`) がこのPCに存在しない
  - 既定パス: `~/Downloads/CLAUDE.md配布/aujust-sales-automation/.gcp/sheets-sa.json` — 不在
  - `GOOGLE_SA_KEY` 環境変数 — 未設定
  - GWS proxy — `webmasters.readonly` スコープ非対応
- **対象サイトリポジトリ**: このPC上に展示会ブース制作の公開Webサイトリポジトリ未発見
  - `D:/repos/booth-production-app/` は内部GASアプリ（展示会ブース制作の案件管理）のリポジトリであって、公開Webサイトではない
  - `C:/Users/kimko/.claude/auto-session-repo/apps/expo-apply/` は海外向け出展受付サイト（localStorage保存）

## 解消条件
1. kim@orgiast.jp でSearch Consoleへログインし該当サイトを確認
2. GSCのBigQuery一括エクスポートを設定（推奨）、またはSA鍵 (`sheets-sa.json`) をこのPCに配置
3. 対象サイトのリポジトリ・公開URLを特定
4. BigQuery設定後、`seo/gsc-bq-weekly-analysis.sql` のプレースホルダーを置換して週次クエリを登録

## X-0003: GSC BigQuery週次分析（推奨経路）

GSCの継続的な分析には、従来のSearch Console APIベースの `seo/export-search-console.mjs` よりも、GSC公式のBulk Data Export（一括エクスポート）を推奨する。APIの行数制限を前提にした分割取得が不要で、エクスポート開始後のデータをBigQueryに保持し、定期SQLで週次分析できる。

- 完全設定ガイド: [`docs/gsc-bigquery-weekly-seo-analysis.md`](../docs/gsc-bigquery-weekly-seo-analysis.md)
- 週次分析SQL: [`seo/gsc-bq-weekly-analysis.sql`](./gsc-bq-weekly-analysis.sql)
- 分析内容:
  - 前週比クリック減ページ（URL×クエリ）
  - 表示増なのにCTR低下したキーワード
  - 順位上昇なのに流入が伸びないページ

実行前にSQL内の `your-project-id` を実際のGCPプロジェクトIDへ置換し、GSC側でデータセット名を変えた場合は `searchconsole` も置換する。`your_dataset` はScheduled Queryの結果保存先を示す説明用プレースホルダーである。GSCデータセット、定期クエリ、結果保存先は同じBigQueryロケーションにそろえること。設定前の過去データは遡及取得できない。

`seo/export-search-console.mjs` は単発取得や既存フローの互換用途として残すが、新規の継続運用はBigQuery経路を使う。

## 参考
- Search Console API: `https://searchconsole.googleapis.com/webmasters/v3/`
- GSC一括エクスポート: `https://support.google.com/webmasters/answer/12918484`
- BigQuery定期クエリ: `https://cloud.google.com/bigquery/docs/scheduling-queries`
- Google Property Check: `tools/google-property-check.mjs`（プロパティ一覧確認用）

## X-0024: Ahrefs監査 × GSC 優先度判定

Ahrefsの監査エラー一覧とGSCのページデータを突合し、**重大性×流入影響×影響範囲**から修正優先度を自動判定する。全件を人力レビューせず、P0/P1（対応優先度上位）だけに集中する。

```bash
# モックで動作確認
node seo/ahrefs-gsc-priority.mjs --mock

# 実データ（AhrefsエクスポートCSV × GSCページCSV）
node seo/ahrefs-gsc-priority.mjs --ahrefs ahrefs-errors.csv --gsc gsc-pages.csv --output seo/reports/priority-YYYYMMDD.md
```

- 設計書: [`docs/ai-news-x0024-ahrefs-gsc-priority.md`](../docs/ai-news-x0024-ahrefs-gsc-priority.md)
- サンプルデータ: `seo/data/ahrefs-sample-errors.csv` / `seo/data/gsc-sample-pages.csv`
- テスト: `node --test seo/ahrefs-gsc-priority.test.mjs`

## 進行管理
- 本件は `next-session.md` #7 として管理
- ブロッカー解消後に再開

## X-0020 顧客質問からのSEOコンテンツギャップ分析（2026-11-12 完了）
- [x0020-content-gap-analysis.md](./x0020-content-gap-analysis.md) — 上位3記事の分析（答える内容/悪い説明/不足例）×自社サイトギャップ比較
- [x0020-missing-content-proposal.md](./x0020-missing-content-proposal.md) — 不足説明の構築（費用完全ガイド/選び方ガイド/Re:ブースFAQの3コンテンツ案）
- 成果物: 2ファイル。サイト実装には公開リポジトリが必要（このPCには無し）
