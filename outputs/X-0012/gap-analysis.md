# X-0012: Gap Analysis — オージャスト既存サイトのAI検索ギャップ

> 2026-11-09 実測調査

> **⚠️ 2026-11-10 訂正（463URL 全件の機械監査で判明）**: 下記の G1「canonical 全欠」・G2「構造化データ全欠」は誤り。
> 実測: canonical あり 374/463（欠落 89＝clients 48・eventphoto 12・recruiting 12・slide 4・一覧ページ）、
> 構造化データは 374 ページに全ページ共通の Organization/WebSite/FAQPage が wp_head へ直書きされている（ページ固有の Article/BreadcrumbList は無い・FAQPage 全ページ共通は Google ガイドライン違反の恐れ・@id が orgiast.jp で canonical の www.orgiast.jp と不一致）。
> 本当の最大ギャップ: robots.txt と GSC に登録の sitemap.xml は AIOSEO 2.11 の静的生成で 14件（タクソノミー・nav_menu）だけ／GSC indexed=0。正しい 463件は sitemap.xml.gz（インデックス）側にしかない。GSC には壊れた登録 sitemaps.org・xmlsitemap.xml（errors=1）も残る。noindex なのに sitemap 掲載 5件、description 欠落は個別記事 4件（他は一覧ページ）。Bing は未登録（msvalidate 無し・BingSiteAuth 404）。
> 権限: WP の ai-pdca-bot は編集者相当（plugins 500・theme-editor 403・AIOSEO 欄なし）、DWD SA は GSC readonly のみ。GSC フル権限は shirakawa@・yasue@。
> 全件データ: Google スプレッドシート 1IKJHQG4Mop9IzL-VT5nh7ixaX4B9Vbew0FkSwiQruJ4


## Bing Index Coverage（実測）

| セクション | 総ページ数（sitemap） | Bing 表示件数（site: 検索） | カバレッジ |
|-----------|---------------------|--------------------------|-----------|
| イベント事例 | 85 | ~4件 | **4.7%** |
| 制作事例 | 26 | 0件 | **0%** |
| トピックス | 213 | 数件 | **<3%** |
| クライアント | 47 | 0件 | **0%** |
| rebooth.co.jp | 確認中 | 一部 | 部分的 |

**結論**: Bing の index は非常に限定されている。Google も事例ページの十分な発見に至っていない可能性が高い。

## ChatGPT / Perplexity での言及状況

- **企業自体**: オージャストの AI 活用（AI代行堂、マキモノ、Claude Code 自動化）は検索で発見可能
- **事例ページ**: ブース事例・制作実績ページの具体的な引用は確認できず
- **ギャップ**: Bing/Google に index されていないため、ChatGPT の参照元になっていない

## G1〜G6 ギャップ分析

### G1: Canonical タグ不在
**ページ**: 全ページ（調査した全URL）
**影響**: Bing が重複コンテンツを誤認識し、index から除外する可能性
**対処**: WordPress テーマの `header.php` または SEO プラグインで `rel="canonical"` を全ページに追加

### G2: 構造化データ不在
**ページ**: 全ページ
**影響**: 
- ChatGPT/Perplexity 等 AI が信頼できるデータとして認識しない（schema.org が信頼性シグナルになる）
- Google リッチリザルト非対応
- Bing の deep link 非対応
**対処**: 
- 組織: `Organization` スキーマ（logo, address, contactPoint, sameAs）
- 事例: `Article` + `Event` スキーマ
- ブログ: `BlogPosting` スキーマ
- パンくず: `BreadcrumbList` スキーマ

### G3: Bing 未登録
**状態**: Bing Webmaster Tools への登録未確認
**影響**: Bing の index が Google 比で大幅に少ない（事例ページの 95% が未index）
**対処**: 
1. Bing Webmaster Tools にサイト追加
2. sitemap.xml 送信
3. IndexNow プロトコル対応（WordPress プラグインで自動送信可）

### G4: メタデータ不足
**ページ**: 事例ページ（event, creative）、トピックスに meta description 不足
**影響**: AI がスニペット生成時に適切な説明文を拾えない
**対処**: AI（Claude）で各事例ページの内容から meta description を一括生成

### G5: rebooth.co.jp 孤立
**状態**: Vercel ホスティング、WordPress と別管理
**影響**: 
- 相互リンクが orgiast.jp からの単方向（rebooth banner）
- rebooth → orgiast へのリンク最小限
- ドメイン権威が分散
**対処**: 
- rebooth に `Article` + `Product` スキーマ実装
- rebooth から orgiast 事例への相互リンク追加
- orgiast とのコアトピック関係を schema.org の sameAs で明示

### G6: 第三者引用ソース不足
**状態**: 外部ドメインからの引用/被リンク獲得が未着手
**影響**: ChatGPT 等が orgiast の事例ページを引用先として使わない
**対処**: 
- 展示会関連 Reddit スレ（r/JapanTradeShow, r/ExhibitionStand）への関与
- 制作関連 Qiita/Zenn 記事での言及獲得
- AI が引用するサードパーティドメイン（展示会ニュースサイト等）のスクレイプ＋アウトリーチ

## 優先順位付き実行計画

### 🏃 今すぐ（この週）
1. canonical タグ実装（WordPress Rank Math へ移行して自動付与）
2. Bing Webmaster Tools 登録 + sitemap 送信
3. 主要5ページに構造化データ実装（トップ・event・creative・rebooth・連絡先）

### 📅 今月中
4. 全事例ページ meta description 一括生成・適用
5. 事例ページに Event + Article スキーマ一括実装
6. rebooth に Product スキーマ + 相互リンク

### 📆 3ヶ月以内
7. 定期的なトピックス増産（AI生成SEOガイド × 毎日1本）
8. サードパーティ引用獲得キャンペーン
9. クリーン帰属 vs 影響帰属の分離指標構築

## 参考：ChatGPT に発見されるための3条件

1. **index されている** → Bing + Google 両方 ← 現状 Bing が ×
2. **信頼できる** → 構造化データ + 被リンク ← 現状 ×
3. **引用される** → 固有の知見・データを含む ← 事例ページは条件満たすが発見されていない