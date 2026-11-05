# SEO最適化 × AI Overview引用獲得 [X-0001]

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
2. SA鍵 (`sheets-sa.json`) をこのPCに配置 または Search Consoleスコープ対応のGWS proxy設定
3. 対象サイトのリポジトリ・公開URLを特定
4. 上記充足後、`seo/export-search-console.mjs` を実行してデータエクスポート

## 参考
- Search Console API: `https://searchconsole.googleapis.com/webmasters/v3/`
- Google Property Check: `tools/google-property-check.mjs`（プロパティ一覧確認用）

## 進行管理
- 本件は `next-session.md` #7 として管理
- ブロッカー解消後に再開