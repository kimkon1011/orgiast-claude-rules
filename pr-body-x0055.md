# X-0055: AI引用を増やすサイト構造最適化

## 概要

AIニュース提案 [X-0055]: サービス別・ロケーションページの構造設計、FAQの拡充、構造化データ（JSON-LD）の整備、著者資格マークアップにより、オージャストサイトのAI引用率向上を図る。

## 変更内容

### 新規ファイル

- **ai-visibility/x0055-site-structure/SPEC.md**: サイト構造最適化の全体仕様書
  - ロケーションページ（例: 「大阪 展示会ブース制作」向けエリアページ）の設計指針
  - サービス別詳細ページ（ブース施工・イベント企画・クリエイティブ）の構造要件
  - FAQページのAI引用最適化（X-0007のFAQを拡張）
  - 構造化データ追加ガイド（LocalBusiness + areaServed, Service, Author/Person）
  - 著者資格（EEAT）マークアップ仕様

- **ai-visibility/x0055-site-structure/location-page-archetype.md**: ロケーションページの雛形
  - 主要7拠点（大阪・東京・名古屋・札幌・広島・福岡・沖縄）＋関東・関西汎用
  - 各拠点の展示会会場（インテックス大阪・東京ビッグサイト等）に対応
  - Schema.org LocalBusiness + areaServed のJSON-LDテンプレート

- **ai-visibility/x0055-site-structure/service-page-archetype.md**: サービス詳細ページの雛形
  - 展示会ブース制作 / 社内イベントプロデュース / クリエイティブ制作 の3サービス
  - Schema.org Service 型のJSON-LDテンプレート
  - AI引用されやすい「前倒し構造」の見出し設計

- **ai-visibility/x0055-site-structure/author-credential-spec.md**: 著者資格マークアップ仕様
  - Person + author スキーマのテンプレート
  - デザイナー・ディレクターの経歴・実績を構造化
  - ブログ記事・事例ページへの適用手順

- **tools/ai-location-schema-gen.mjs**: ロケーション・サービススキーマ自動生成ツール
  - 拠点名・会場名からJSON-LDを生成
  - サービス別スキーマのテンプレート出力
  - 「サービス×拠点」の組み合わせ一括生成

### 更新ファイル

- **ai-visibility/x0053-llms-txt/llms.txt**: 全国拠点リスト・認定資格・デザイナー情報を追加
- **ai-visibility/phase2-schema-spec.md**: 著者資格（Person/author）スキーマの優先度を追記
- **tools/ai-markdown-registry.json**: ロケーション情報と著者情報をレジストリに追加

## 根拠データ

- Yext調査: 全検索エンジンが同一ソースを引用する場合、自サイト引用率91%
- 著者情報の追加で引用率1.8倍（EEATシグナル）
- ロケーションページの充実で地域特化クエリのAI引用率向上（X-0007 スコアリングで会社名なし汎用クエリの引用率0%問題への対策）

## AI引用への効果

| 対策 | 想定効果 | 根拠 |
|------|---------|------|
| ロケーションページ設置 | 地域特化クエリ（「大阪 展示会ブース制作」等）での検出率向上 | 会社名なし汎用クエリ0%→改善 |
| 著者資格マークアップ | 全クエリの引用率1.8倍 | Yext 著者情報エンリッチメント |
| 構造化データ整備 | リッチスニペット獲得・AI Overviews引用率向上 | Schema.org完全準拠 |
| サービス別ページ充実 | サービス比較クエリでの被引用増 | 比較クエリ引用率100%維持を拡張 |

🤖 Generated with [Claude Code](https://claude.com/claude-code)