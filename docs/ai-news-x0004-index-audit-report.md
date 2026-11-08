# X-0004: ページインデックス最適化とAI引用分析 — インデックス監査レポート

- 観測日: 2026-11-09
- 対象サイト: rebooth.co.jp（株式会社オージャスト 展示会ブース制作サービス Re:ブース）
- 補完対象: orgiast.jp（コーポレートサイト）
- 出典: AIニュース digest X-0004「ページインデックス最適化とAI引用分析で$506K」

## 1. サイト構造とインデックス状態（Web検索調査）

### 1.1 rebooth.co.jp（Re:ブース）

| 項目 | 状態 |
|------|------|
 | サイト種別 | 展示会ブース制作のランディング／コーポレートサイト |
 | ページ数 | 〜10ページ程度（About, News×複数, Exhibition guides×複数, Customer interviews） |
 | robots.txt | 未確認（外部クローラーからの実測が必要） |
 | sitemap.xml | 未確認 |
 | llms.txt | 未確認 |
 | ai.txt | 未確認 |
 | JSON-LD構造化データ | 未確認 |
 | 最終更新日表示 | 未確認 |
 | noindex/canonical設定 | 未確認 |

**確認済みページ**:
- トップページ（rebooth.co.jp）
- Aboutページ
- News: Yemen Pavilion Bronze Award（2025大阪万博）
- 展示会ガイド: オンライン/ハイブリッドブース活用
- 展示会ガイド: 来場者事前獲得
- お客様インタビュー（W2株式会社）

### 1.2 orgiast.jp（コーポレートサイト）

| 項目 | 状態 |
|------|------|
 | ページ数 | 社内イベント運営ノウハウ記事が主体 |
 | 展示会ブース制作の言及 | **なし**（社内イベント・社員総会・効果測定が中心） |
 | AI引用の可能性 | 低い（「展示会ブース制作」のクエリとコンテンツが一致しない） |

### 1.3 ギャップ: 展示会ブース制作クエリでの可視性

**調査結果: 「展示会ブース制作 大阪」のWeb検索・AI検索でオージャスト（rebooth.co.jp）はトップ10に登場しない。**

AI引用を引きやすい競合（上位から）:
1. 乃村工藝社 — 万博10館パビリオン実績、豊富なプレスリリース
2. 丹青社 — 東証プライム、空間プロデュース大手
3. 大伸社 — 制作プロセス公開、多ジャンル実績
4. 関西ディスプレイ — リピート率8割、SEO記事「ブース設営.com」運営
5. ビィ — 年間300件超、対応スピード
6. 西尾レントオール — 年間2,000件超、レンタル品カタログ

## 2. AI引用ソース分析

### 2.1 ChatGPT・Perplexity・Gemini が引用するソースの特徴

2026年時点の観測値として、展示会ブース制作クエリでAIが引用する際の共通パターン:

| 特徴 | AI引用への影響 |
|------|---------------|
 | FAQ形式のQ&Aページ | 最も引用されやすい。Q→Aペアがそのまま回答文に使われる |
 | 数値付き事例（㎡・予算・成果） | 比較クエリ・課題解決クエリでの推薦確率を決定 |
 | 業界特化の専門記述 | 指名クエリでの企業説明精度に直結 |
 | 最新更新日の明示 | 鮮度シグナルとして採用判断に影響 |
 | robots.txtでのクローラー許可 | 前提条件（ブロックされるとゼロ） |
 | 構造化データ（JSON-LD） | 機械可読性向上、回答への採用率上昇 |

### 2.2 オージャストの現在のAI引用状況

**推定: 現時点でAI（ChatGPT/Perplexity/Gemini）に「展示会ブース制作 大阪」などで質問しても、rebooth.co.jp が引用される確率は低い（〜10%未満）。** 理由:
- FAQページがない（LLMが引用可能なQ&A形式のコンテンツ）
- 実績に数値データが不足（㎡・予算・成果の構造化データ）
- robots.txt / llms.txt / ai.txt が未確認
- サイト更新頻度と鮮度情報が不明
- 地域キーワード（大阪）の一貫性が不十分

**唯一の強み**: 大阪万博 Yemen Pavillion 銅賞受賞のニュースは、大型イベント実績として権威シグナルになる可能性がある（万博関連クエリでは引用される可能性）。

## 3. Bingインデックス状況（ChatGPT発見性への影響）

ChatGPTはBingをリアルタイム検索に使用するため、**BingにインデックスされていないページはChatGPTの回答に引用されない。**

確認事項（手動確認が必要）:
- `bing.com/search?q=site:rebooth.co.jp` でインデックス件数を確認
- `bing.com/search?q=site:orgiast.jp` でインデックス件数を確認
- Bing Webmaster Tools 未登録の場合、登録してインデックス制御

## 4. 推奨アクション（優先順位順）

### Phase 0: ベースライン計測（即日）
1. rebooth.co.jp の robots.txt / sitemap.xml / llms.txt / ai.txt の有無を確認
2. Bing Webmaster Tools にサイト登録
3. ChatGPT / Perplexity / Gemini で `site:rebooth.co.jp` を含むクエリの引用有無を記録
4. ツール `tools/ai-index-audit.mjs` で全ページのインデックス状態を計測（本セッションで作成）

### Phase 1: インデックス最適化（今週）
5. robots.txt で GPTBot / Google-Extended / CCBot / PerplexityBot / Claude-Web を許可
6. sitemap.xml を生成・送信（Google Search Console + Bing Webmaster Tools）
7. llms.txt をサイトルートに設置（会社説明＋サービス一覧＋FAQ概要）
8. ai.txt を設置（AIの利用許可範囲を明示）

### Phase 2: FAQ整備（優先度高・即効性大）
9. 展示会ブース制作に関する FAQ 20問を作成（予算・納期・サービス範囲・初心者向け・比較選定）
10. JSON-LD FAQPage Schema を実装

### Phase 3: 事例ページ強化
11. 各実績に数値データ（㎡・動員数・期間・成果）を追記
12. schema.org/Article + CreativeWork の JSON-LD 埋め込み

### Phase 4: 継続測定
13. X-0007 20問測定を月1回実施
14. AI引用数の推移を記録（目標: 6ヶ月で引用数3倍）

## 5. 測定KPI

| KPI | 現状（推定） | 目標（6ヶ月後） | 測定方法 |
|-----|------------|----------------|---------|
 | AI引用サイト数 | 0-1 | 8+ | ChatGPT/Perplexity/Gemini で `site:rebooth.co.jp` の出現回数 |
 | ChatGPT引用 | 未確認 | 3+ | ChatGPT `site:rebooth.co.jp 展示会` |
 | LLMトラフィック | 未測定 | 全トラフィックの5% | Google Analytics + リファラー分析 |
 | Bingインデックスページ数 | 未確認 | 全ページ | Bing Webmaster Tools |
 | Googleインデックスページ数 | 未確認 | 全ページ | Google Search Console |
 | X-0007測定スコア | 0（未測定） | 40/100 | X-0007 20問テスト |

## 6. 出典

- AIニュース digest X-0004「ページインデックス最適化とAI引用分析で$506K」
- X-0004 実装ランブック: `docs/ai-news-x0004-llmo-content-4points.md`
- X-0007 測定ランブック: `docs/ai-news-x0007-llmo-measurement.md`
- X-0007 PHASE1 競合分析: `run-file-20261108-003008.md`
- Web検索（2026-11-09）: rebooth.co.jp, orgiast.jp, 展示会ブース制作 大阪 会社