# X-0040: SEO用SKILL.mdのnpx一括導入 — npx skills add Illyism/seo-skills

**AIニュース提案 2026-11-13**: Claude Codeで利用可能なSEOスキル30種を`npx skills add Illyism/seo-skills`の1コマンドで一括導入。seo-autopilotで日次技術チェック・キーワードマップ・比較ページ・AI回答追跡、blog-refresherでSERPギャップ分析を実施。株式会社オージャストでは展示会ブース制作サイトのGitHubリポジトリにClaude Codeを接続し、これらのスキルで自社キーワードの最適化と既存ページのTop3押し上げを試す。

観測日: 2026-11-13

---

## 1. 概要

Claude Code 4.0から導入された `skills` コマンドは、`npx skills add <GitHubリポジトリ>` の1コマンドで第三者が作成したスキル定義をプロジェクトにインストールできる。`Illyism/seo-skills` リポジトリはSEOに特化した30のスキルを提供しており、SEOの専門知識がなくてもClaude CodeにSEO施策を委任できる。

### 1.1 インストール方法

```bash
# プロジェクトのルートディレクトリで実行
npx skills add Illyism/seo-skills
```

これにより `.agents/skills/` 以下に30のスキルがインストールされ、Claude Code・Codex・Gemini CLI など79のAIエージェントで利用可能になる。

### 1.2 インストールされた30スキル一覧

| スキル名 | 用途 |
|---------|------|
| **seo-autopilot** | SEO完全自動化パイロット（日次/週次/月次） |
| **blog-refresher** | 既存ブログ記事のSERPギャップ分析・リフレッシュ |
| ahrefs-research | Ahrefsデータ分析 |
| ai-seo-report | AI SEOレポート生成 |
| aiseotracker | AI検索（ChatGPT/Perplexity）での自社表示追跡 |
| awesome-tools | SEOツール一覧生成 |
| blitz-copy | 高速コピーライティング |
| blitz-seo | 高速SEO最適化 |
| block-ai-scrapers | AIクローラーブロック設定 |
| content-coverage | コンテンツカバレッジ分析 |
| customer-journey | カスタマージャーニーマップ作成 |
| dataforseo-serp | DataForSEO SERP API連携 |
| diff-marketing | 差別化マーケティング戦略 |
| directory-submissions | ディレクトリ登録下書き |
| domain-migration | ドメイン移行SEO対応 |
| honest-link-outreach | リンク獲得アウトリーチ |
| internal-linking | 内部リンク最適化 |
| intro | スキル紹介・ナビゲーション |
| linkdr | LinkDR連携（被リンク分析） |
| parasite-and-pr | パラサイトSEO・PR戦略 |
| proof-kb | ナレッジベース証明 |
| reddit-serp | Reddit SERP分析 |
| scribiz | 記事リライト |
| seo-blog-images | ブログ画像SEO |
| seo-roast | SEO監査・批評 |
| seo-title-optimization | タイトルタグ最適化 |
| understand-customers | 顧客理解 |
| unslop-seo | SEOノイズ除去 |
| vs-and-alternatives | 比較・代替ページ作成 |
| youtube-seo | YouTube SEO |

## 2. 主要スキルの詳細

### 2.1 seo-autopilot（SEO完全自動化パイロット）

プロダクトのリポジトリ内でSEOを完全自動化する。`seo/` ディレクトリに状態を永続化し、日次・週次・月次のサイクルで自律実行する。

**設定（SKILL.mdの冒頭5行）:**
```
Site:          https://example.com
Product:       <1文: 何をする製品か、誰が買うか>
Conversion:    <コンバージョンアクション>
Competitors:   <競合3〜8社、または "find them">
Ship mode:     <"PR for review" または "merge when the build passes">
```

**日次タスク:**
1. **ヘルスチェック**: サイトマップ全URLのステータス確認、リダイレクトチェーン・正準化・noindex・robots.txt・重複メタ・欠落タイトル・速度問題を検出・修正
2. **ファクトチェック**: 前回実行以降のコミットを読み、価格・プラン・機能変更が古いページに反映されているか確認・修正
3. **バックログ消化**: 優先度順に1件出荷
4. ログ追記

**週次タスク:**
1. **Page 2 → Page 1**: 8〜20位のクエリを分析、上位3サイトを調査して差別化ポイントを特定・自ページを改善
2. **既存ページ修正**: 週12件以上の修正（タイトル・内部リンク・速度・リダイレクト・構造化データ）
3. **インデックス確認**: サイトマップ全URLのGoogleインデックス状況確認
4. **AI回答追跡**: 25の質問をChatGPT/Perplexity/Google AI Overviewsに問い合わせ、自社の表示状況・引用元・誤情報を記録
5. **競合サイトマップ差分**: 前週との差分を比較し、競合の新規公開ページと獲得クエリを特定
6. **レポート**: 週次レポート（300語以内）を `seo/reports/YYYY-MM-DD.md` に出力

**月次タスク:**
1. **キーワードマップ再構築**: 購入者の検索行動から出発したキーワードマップ再構築
2. **記事最大12本**: SERP上位5サイトを調査し差別化できる場合のみ執筆
3. **比較ページ**: 競合ごとに「alternatives to X」「this product vs X」ページ作成
4. **無料ツール**: 計算機・ジェネレーター・チェッカー等を1つ構築
5. **リンク**: ディレクトリ登録・アウトリーチの下書き

### 2.2 blog-refresher（ブログ記事リフレッシュ）

既存ブログ記事を6フェーズの分析フレームワークでリフレッシュし、競合を上回るよう改善する。

**6フェーズ:**
1. **現状分析**: 記事の基本指標・構造・品質を監査
2. **競合調査**: 上位5〜10のSERP結果を分析
3. **ギャップ特定**: 競合が持っていて自記事に欠けている要素を優先度付きで特定
4. **改善計画**: 構造化されたアップグレード戦略
5. **承認チェックポイント**: 分析結果を提示して承認待ち
6. **コンテンツ再作成**: 改良版の執筆

**SEOチェックリスト:**
- タイトルタグ 50〜60文字
- メタディスクリプション 150〜160文字
- 最初の100語に主要キーワード
- 関連語を自然に使用
- スニペット対応の回答を上部に
- People Also Ask に対応するFAQ
- 関連記事への内部リンク

## 3. 株式会社オージャストでの適用計画

### 3.1 適用対象サイト

展示会ブース制作サイト（https://orgiast.jp または展示会特化ミニサイト）のGitHubリポジトリにClaude Codeを接続し、以下を実行する。

### 3.2 フェーズ1: セットアップ（初回）

1. `npx skills add Illyism/seo-skills` を対象リポジトリで実行
2. seo-autopilot の設定5行を記入
3. 初回実行で `seo/context.md` 作成・キーワードマップ構築・サイトクロール・バックログ作成
4. 優先度の高い3件をその日のうちに出荷

### 3.3 フェーズ2: 日常運用

- **毎日**: seo-autopilot の日次サイクル（ヘルスチェック＋ファクトチェック＋バックログ消化）
- **毎週**: Page 2→Page 1 プッシュ、AI回答追跡、競合分析、週次レポート
- **毎月**: キーワードマップ再構築、比較ページ、無料ツール

### 3.4 フェーズ3: ブログリフレッシュ

既存のブログ記事に対して blog-refresher を適用し、SERPギャップ分析から改善を実施。以下のキーワードを優先:
- 「展示会ブース 制作」「イベントブース デザイン」「展示会 集客 ノウハウ」
- 「ブース レイアウト 設計」「展示会 出展 効果」

## 4. 注意点・制約

- seo-autopilot の Snyk リスク評価は「High Risk」（セキュリティ評価上注意が必要）
- 実際の検索エンジンデータ（Search Console, Ahrefs等）が接続されていない場合、その旨をレポートに記載し、手持ちのデータで継続
- AI回答追跡は手動で各アシスタントに問い合わせる方式のため、大量クエリには非効率（aiseotracker の導入を推奨）
- 被リンク分析には LinkDR の導入を推奨
- キーワードマップの再構築は月1回（月初推奨）
- **外部への自動送信（メール・ディレクトリ登録・SNS投稿）は行わず、下書きをレポートに掲載して人間が確認後に送信**

## 5. 期待効果

- SEO施策の属人化防止（スキル定義としてリポジトリにバージョン管理）
- 日次・週次・月次のサイクルで自律的なSEO改善
- AI検索（ChatGPT/Perplexity/AI Overviews）での可視性向上
- 競合分析の自動化による継続的な差別化
- 既存コンテンツのリフレッシュによるランキング回復

## 6. リスク評価

| スキル | Gen AI | Socket | Snyk |
|-------|--------|--------|------|
| seo-autopilot | High Risk | 0 alerts | Med Risk |
| blog-refresher | Safe | 0 alerts | Med Risk |
| ahrefs-research | Safe | 0 alerts | Critical Risk |
| domain-migration | Safe | 0 alerts | Critical Risk |
| honest-link-outreach | Med Risk | 0 alerts | Critical Risk |
| internal-linking | Safe | 0 alerts | Critical Risk |

※ Critical Risk は主に外部APIキーやデータ送信を伴うスキル。使用前にコードレビューを推奨。

## 7. 検証結果

### 7.1 インストール検証

- **コマンド**: `npx skills add Illyism/seo-skills`
- **結果**: 成功（30スキル全件インストール完了）
- **インストール先**: `.agents/skills/`（当リポジトリ）
- **対応エージェント**: Claude Code, Codex, Gemini CLI 他79エージェント
- **日時**: 2026-11-13

### 7.2 スキル内容確認

- seo-autopilot: SKILL.md の内容を確認。日次/週次/月次の3サイクルでSEOを完全自動化する設計。状態は `seo/` ディレクトリに永続化。
- blog-refresher: SKILL.md の内容を確認。6フェーズのフレームワークで既存ブログ記事を分析・改善する設計。SERP上位5〜10サイトとのギャップ分析を実施。
- 全30スキルの SKILL.md が `.agents/skills/<name>/SKILL.md` に配置されていることを確認。
