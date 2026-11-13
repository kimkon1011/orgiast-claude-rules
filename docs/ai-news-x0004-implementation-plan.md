# X-0004: rebooth.co.jp インデックス最適化 実装計画

## 概要

X-0004（ページインデックス最適化とAI引用分析）を株式会社オージャストの展示会ブース制作サイト rebooth.co.jp に適用する実装手順。

関連文書:
- `docs/ai-news-x0004-llmo-content-4points.md` — コンテンツ設計の4ポイント
- `docs/ai-news-x0004-index-audit-report.md` — インデックス監査レポート
- `tools/ai-index-audit.mjs` — インデックス監査ツール
- `docs/ai-news-x0007-llmo-measurement.md` — LLMO測定（改善サイクル）

## Phase 0: ベースライン測定（当日〜3日）

### 0.1 インデックス監査の実行
```bash
node tools/ai-index-audit.mjs https://rebooth.co.jp --crawl 5 --verbose
node tools/ai-index-audit.mjs https://orgiast.jp --crawl 3 --verbose
```

### 0.2 Bing Webmaster Tools 登録
- https://www.bing.com/webmasters/ にアクセス
- rebooth.co.jp と orgiast.jp を追加
- site: 検索で現在のインデックスページ数を記録

### 0.3 AI引用ベースライン測定
3つのAIプラットフォームで以下を質問し、`site:rebooth.co.jp` を含む引用の有無を記録:
1. ChatGPT: 「展示会ブース制作 大阪 おすすめ 会社」
2. Perplexity: 「rebooth.co.jp ってどんな会社？」
3. Gemini: 「大阪で展示会ブース制作できる会社を教えて」
4. Claude: 「rebooth.co.jp のサービス内容は？」

## Phase 1: インデックス基盤整備（今週）

### 1.1 robots.txt 設置
**ファイル**: rebooth.co.jp/robots.txt
```
User-agent: GPTBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: CCBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: *
Allow: /
Sitemap: https://rebooth.co.jp/sitemap.xml
```

### 1.2 sitemap.xml 生成
手動生成またはCMSプラグインで。最低限含めるURL:
- https://rebooth.co.jp/
- https://rebooth.co.jp/about/
- https://rebooth.co.jp/news/ （各記事）
- https://rebooth.co.jp/customer-interviews/
- https://rebooth.co.jp/exhibition-guides/ （各ガイド）

### 1.3 llms.txt 設置
**ファイル**: rebooth.co.jp/llms.txt
```
# Re:ブース (rebooth.co.jp) — 株式会社オージャスト
# 最終更新: 2026-11-09

## 会社概要
株式会社オージャスト（Orgiast Inc.）は、再利用可能な展示会ブース「Re:ブース」を提供する展示会ブース制作会社。
東京（墨田区）・大阪に本社、札幌・名古屋・広島・福岡・沖縄に営業所。

## 提供サービス
- 展示会ブースの企画・デザイン・制作・設営・撤去 一貫対応
- Re:ブース（再利用可能ブース）設計・制作
- 展示会出展コンサルティング
- グラフィック・展示内容のリニューアル

## 主な実績
- 2025年大阪・関西万博 Yemen Pavillion 銅賞受賞
- 2025年大阪・関西万博 Zimbabwe Republic Pavillion
- W2株式会社（120%達成率のブース）
- ソラコム / アイモバイル / 20世紀FOX

## FAQ 概要
Q: 初めての展示会で何から始めればいいですか？
A: ご予算・目的・出展規模をお聞きし、最適なプランを提案します。初回相談無料。

Q: 予算は最低いくらから？
A: 小ブース（3m×3m）で60万円〜。予算に応じたプランをご提案します。

Q: 再利用可能なブースとは？
A: 構造材を再利用可能に設計し、次回は表面グラフィックのみ差し替え。コスト約40%削減、廃棄物削減。

## 連絡先
Web: https://rebooth.co.jp
問い合わせ: https://rebooth.co.jp/contact
```

### 1.4 ai.txt 設置
**ファイル**: rebooth.co.jp/ai.txt
```
# Re:ブース (rebooth.co.jp) — AI利用許可
# 最終更新: 2026-11-09

AIの学習・情報源としての利用を許可します。
ユーザーからの質問に対する回答生成のために、このサイトのコンテンツを引用することを許可します。
引用時は出典（rebooth.co.jp）の明記を推奨します。

禁止事項:
- 事実と異なる情報の生成
- 商標・著作権を侵害する利用
```

## Phase 2: FAQ整備（優先度: 最高）

### 2.1 FAQ 20問 作成・公開
会社サイトに `/faq/` ページを新設。`schema.org/FAQPage` のJSON-LDを実装。

**カテゴリ別FAQ案**:

| カテゴリ | 質問案 |
|---------|--------|
 | 予算・費用 | 最低いくらから依頼できますか？ 見積もりは無料ですか？ 分割払いは可能ですか？ |
 | 納期 | 最短どのくらいで制作できますか？ 繁忙期はいつですか？ 追加対応のリードタイムは？ |
 | サービス範囲 | 設計だけの依頼は可能ですか？ 海外展示会に対応していますか？ 撤去のみの依頼は？ |
 | 初心者向け | 初めての展示会、何から始めるべきですか？ どの規模のブースを選べばいいですか？ |
 | 比較・選定 | 自社で作るより安いですか？ 他社との違いは？ リブース（再利用型）のメリットは？ |
 | 業種別 | 製造業の事例はありますか？ IT企業の事例は？ 医療業界の実績は？ |

### 2.2 JSON-LD FAQPage 実装例
```json
{
  "@context": "https://schema.org",
  "@type": "FAQPage",
  "mainEntity": [
    {
      "@type": "Question",
      "name": "展示会ブースの制作費用は最低いくらからですか？",
      "acceptedAnswer": {
        "@type": "Answer",
        "text": "小ブース（3m×3m）の場合、木工造作で60万円〜、システム造作で40万円〜が目安です。ご予算とご要望に応じて最適なプランをご提案します。初回相談は無料です。"
      }
    }
  ]
}
```

## Phase 3: 実績ページ強化

### 3.1 実績データの構造化
既存実績に数値データを付与:
- ブース規模（㎡）
- 制作期間（週）
- 来場者数（概数）
- 成果指標（リード獲得数・アンケートスコア等）

### 3.2 JSON-LD Article 実装
各実績ページに `schema.org/Article` + `CreativeWork` を埋め込み。

## Phase 4: 継続監視

### 4.1 定期インデックス監査
```bash
# cron: 毎週月曜
node tools/ai-index-audit.mjs https://rebooth.co.jp --json > audits/rebooth-weekly-$(date +%Y%m%d).json
```

### 4.2 X-0007 測定（月1回）
- X-0007 20問テストを月1回実施
- スコア推移を記録
- 6ヶ月目標: 引用数3倍、スコア40/100

## リスクと注意点

1. **サイト構成の確認**: rebooth.co.jp のCMS・ホスティング・編集権限を事前に確認。ファイル追加（robots.txt / llms.txt）が可能か確認。
2. **noindexの意図確認**: 意図的にnoindexにしているページがないか、現状の設定意図を確認してから変更。
3. **Bing優先度**: ChatGPT引用にはBingインデックスが前提。Bing Webmaster Tools を最優先で設定。
4. **効果測定の客観性**: AI引用はプラットフォームのアップデートで変動する。3ヶ月以上のトレンドで判断。
5. **X-0007との連携**: 改善→測定→再改善のサイクルを守る。改善だけして測定しないと効果が不明。

## 担当リソース目安

| タスク | 想定工数 | 優先度 |
|--------|---------|--------|
 | robots.txt設置 | 0.5日 | P0 |
 | sitemap.xml生成 | 0.5日 | P0 |
 | llms.txt/ai.txt設置 | 0.5日 | P0 |
 | FAQ 20問作成 + JSON-LD | 2日 | P0 |
 | Bing Webmaster Tools登録 | 0.5日 | P0 |
 | 実績ページ数値追記 | 1日 | P1 |
 | 継続監査設定 | 0.5日 | P1 |
 | 事例ページ新設 | 3日 | P1 |

**合計: 約8日（分散して1ヶ月）**