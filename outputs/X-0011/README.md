# X-0011: gumツールで毎朝1本のSEOガイド作成 — PHASE1 設計

> 2026-11-09 初回設計。自動セッションによる設計・実装開始。

## 概要

Google Search Console の高インプレッション・低CTRキーワードを毎朝検出し、そのキーワードを狙った高品質SEOガイドを1日1本自動生成・公開するシステム。

### 参照元

元記事の「gum（オープンソース）」は [github.com/ehmo/gum](https://github.com/ehmo/gum) (v2.3.1) — Google API (Search Console・Keyword Planner等) へのCLI/MCPインターフェース。ただし Windows バイナリ未提供のため、本実装では同様の操作を Node.js Google API クライアントで代替する。

## アーキテクチャ

```
[Google Search Console API] ← GSC Keyword Finder (gsc-keyword-finder.mjs)
       ↓
[高IMP低CTRキーワード一覧] → キーワード選定
       ↓
[Guide Generator (guide-generator.mjs)] → SEOガイド本文生成
       ↓
[Internal Link Manager (internal-linker.mjs)] → 内部リンク追加
       ↓
[WordPress Publisher (wp-publisher.mjs)] → 公開・スケジュール
```

### コンポーネント

| ツール | 役割 | 依存 |
|--------|------|------|
| `gsc-keyword-finder.mjs` | GSCから高IMP低CTRキーワードを抽出 | Google APIs OAuth |
| `guide-generator.mjs` | キーワードからSEOガイド生成 | LLM (Claude/Gemini) |
| `internal-linker.mjs` | 既存記事への内部リンク管理 | sitemap.xml |
| `wp-publisher.mjs` | WordPressへの投稿 | XML-RPC / REST API |
| `daily-seo-guide.mjs` | 日次ワークフロー統合 | 上記全ツール |

## PHASE1 実装計画

### Step 1: GSC Keyword Finder（今回実装）
- Google Search Console API 認証
- 直近30日のクエリデータ取得
- インプレッション数でフィルタ（例: >1,000）
- CTR/平均掲載順位で低パフォーマンス判定
- キーワード候補リスト出力

### Step 2: Guide Generator
- LLM (Claude/Gemini) によるSEOガイド生成
- タイトル・meta description・本文構成の自動生成
- 展示会ブース関連キーワードを優先

### Step 3: WordPress 連携
- 記事投稿・下書き保存
- カテゴリ・タグ設定
- 内部リンク追加

### Step 4: 日次自動実行
- 毎朝の定期実行設定
- 進捗レポート生成

## 技術スタック

- **ランタイム**: Node.js v24
- **Google API**: googleapis (npm) — Search Console・Google Ads API
- **認証**: OAuth 2.0 Desktop (aujust-sheets-reader.json を流用 or 新規クライアント)
- **LLM**: codex-do 経由の Claude/Gemini
- **CMS**: WordPress REST API (orgiast.jp)

## ギャップ・リスク

| # | ギャップ | 対処 |
|---|---------|------|
| G1 | gum が Windows 非対応 | Node.js Google API クライアントで代替 |
| G2 | Google Ads API (Keyword Planner) の認証スコープ追加 | 既存 OAuth クライアントのスコープ拡張 |
| G3 | WordPress 管理者権限 | 既存の投稿者権限で下書き保存可能か確認要 |
| G4 | GSC データの量的制限 | 日次クエリ制限に注意 (GSC API は 1日 2,000 クエリ) |

## 成果物

| ファイル | 状態 |
|---------|------|
| `tools/gsc-keyword-finder.mjs` | ✅ 実装完了 |
| `outputs/X-0011/README.md` | ✅ 本ファイル |
| `outputs/X-0011/gap-analysis.md` | ✅ 完了 |
| `outputs/X-0011/guide-generator.mjs` | ⏳ 未着手 |
| `outputs/X-0011/wp-publisher.mjs` | ⏳ 未着手 |
| `outputs/X-0011/daily-seo-guide.mjs` | ⏳ 未着手 |
