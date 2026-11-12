# X-0024: Ahrefs監査をAIで優先修正 — 優先度判定パイプライン

**AIニュース提案 X-0024**: Ahrefs監査結果とGSCページデータを突合し、AI（判定ロジック）で修正優先度を自動判定する。実データ（1746件のエラー）で実施し、事例ページやフォームの問題を優先修正して検索・UI改善を試す。株式会社オージャストの展示会ブース制作サイト（orgiast.jp）で適用する。

観測日: 2026-11-12 | 実装: `seo/ahrefs-gsc-priority.mjs` v1.0.0

---

## 1. 概要

Ahrefsのサイト監査は数百〜数千件のエラーを返すが、**全件を人力で精査して修正順序を決めるのは現実的でない**。本パイプラインは以下を組み合わせて、修正優先度を自動判定する:

1. **Ahrefsエラー一覧**（エラー種別・URL・影響ページ数） — 何が壊れているか
2. **GSCページデータ**（URL・クリック・表示回数・掲載順位） — どれだけ損をしているか
3. **判定ロジック**（重大性×流入影響×影響範囲） — どこから直すべきか

## 2. 入力データ

### 2.1 Ahrefsエクスポート CSV

Ahrefsのサイト監査（Site Audit）→ Issues → Export で出力したCSV。想定列:

```
URL, Error Type, Error Description, Affected Pages, First Detected, Last Detected, HTTP Status, Source
```

- `URL`: エラーが発生したページ
- `Error Type`: エラー種別（404 / Broken link / Missing title など、日本語ラベルも自動分類）
- `Affected Pages`: 影響を受けたページ数（重複タイトルの場合は適用ページ数）
- `HTTP Status`: ある場合はHTTPステータスコード（404/500系の分類に優先利用）

### 2.2 GSCページデータ CSV

Search Console → ページ → エクスポート で出力したCSV:

```
URL, Clicks, Impressions, CTR, Position
```

## 3. 判定ロジック（優先度スコア）

各エラーに3つの観点からスコアを付与し、合計0〜100点で優先度をラベリングする。

### 3.1 重大性（0〜40点）

エラー種別ごとの固定重み（`severityScores` で調整可能）:

| エラー種別 | 重大性 | 理由 |
|-----------|--------|------|
| タイトル欠落 | 9 | SEO評価に直結する致命的欠落 |
| 5xx / リダイレクトループ | 9 | クロール不能・UX直撃 |
| 404 / 410 | 8 | リンク価値・ユーザー損失 |
| noindex矛盾 | 8 | インデックス運用の事故 |
| ソフト404 | 8 | 誤認識で価値喪失 |
| タイトル重複 | 7 | IE最適化不全・表示劣化 |
| thin_content | 7 | 品質評価低下 |
| robotsブロック / 遅延 / リダイレクトチェーン / 孤立ページ / 内部リンク無し | 6 | クロール・評価不全 |
| H1欠落 | 5 | コンテンツ構造不全 |
| 重複/正規URL / メタ記述欠落 | 4-5 | CTR機会損失 |
| 外部リンク切れ / H1重複 / 混合コンテンツ | 3-4 | 軽微 |

### 3.2 流入影響（0〜40点）

GSCデータから算定:

```
クリックスコア   = min(clicks/100, 1.0) × 10   （100クリック以上で満点）
表示回数スコア   = min(impressions/10000, 1.0) × 10
流入影響スコア   = クリック×0.5 + 表示回数×0.3  → 0〜10点
流入影響加点     = 流入影響スコア × 4            → 0〜40点
```

GSCに該当URLのデータがなくても動作する（0点として計算）。

### 3.3 影響範囲（0〜20点）

| Affected Pages | 倍率 | 加点 |
|----------------|------|------|
| 1ページ | 1.0 | 0点 |
| 2〜5ページ | 1.5 | 5点 |
| 6〜20ページ | 2.0 | 10点 |
| 21ページ以上 | 3.0 | 20点 |

### 3.4 優先度ラベル

| スコア | ラベル | 対応目安 |
|--------|--------|----------|
| 65以上 | P0-CRITICAL | 即日対応 |
| 45-64 | P1-HIGH | 週内対応 |
| 30-44 | P2-MEDIUM | 月内対応 |
| 15-29 | P3-LOW | 余力で対応 |
| 0-14 | P4-NEGLIGIBLE | 放置可 |

## 4. 使い方

```bash
# モックで動作確認
node seo/ahrefs-gsc-priority.mjs --mock

# 実データで実行
node seo/ahrefs-gsc-priority.mjs --ahrefs seo/data/ahrefs-sample-errors.csv --gsc seo/data/gsc-sample-pages.csv

# レポートをファイルに保存・上位20件表示
node seo/ahrefs-gsc-priority.mjs --ahrefs ahrefs-errors.csv --gsc gsc-pages.csv --output seo/reports/priority-YYYYMMDD.md --top 20

# AI後処理用にJSONで出力（判定ロジックをLLMに委譲する場合の入力に使える）
node seo/ahrefs-gsc-priority.mjs --ahrefs ahrefs-errors.csv --gsc gsc-pages.csv --json > seo/reports/priority-YYYYMMDD.json
```

### 出力（Markdownレポート）

1. **優先度サマリ**（P0〜P4の件数・割合）
2. **エラー種別内訳**（種別ごとの件数・重大性）
3. **修正優先度一覧**（スコア降順の表: 優先度/URL/種別/スコア/流入/影響範囲/理由）
4. **P0・P1詳細一覧**（チェックボックス付きタスク化できる形式）
5. **推奨アクション**（優先度帯ごとの対応方針）

## 5. 実施手順（orgiast.jp）

| # | ステップ | ツール |
|---|---------|--------|
| 1 | Ahrefsでサイト監査を実行（全ページクロール） | Ahrefs Site Audit |
| 2 | Issues → Export でCSV取得 | Ahrefs |
| 3 | Search Console → ページ で直近3ヶ月データをエクスポート | GSC |
| 4 | 優先度判定パイプラインを実行 | `ahrefs-gsc-priority.mjs` |
| 5 | P0/P1を対象URLのWordPressで修正 | WordPress編集 |
| 6 | 修正後、Ahrefs再クロールでエラー解消を確認 | Ahrefs |
| 7 | 90日後のGSCデータで流入変動を測定 | GSC |

## 6. 既知の制約と次の改善

- **AI委譲オプション**: 現在はルールベースの判定ロジック。`--json` 出力をLLM（Gemini/Claude）に渡して「理由の自然言語化」や「エラー種別をまたぐ総合判断」を行える（次フェーズ）
- **Ahrefs API連携**: 現状は手動CSV取り込み。Ahrefs API（`https://api.ahrefs.com/v3/site-audit`）から自動取得する拡張が可能
- **GSCのBigQuery経路**: `seo/gsc-bq-weekly-analysis.sql`（X-0003）と組み合わせると週次自動化が可能
- **誤検知フィルタ**: Ahrefsのエラーには「意図的な404（旧版キャンペーンURL等）」が含まれる。P0/P1判定後に人手レビューを挟むことを推奨

## 7. テスト

```bash
node --test seo/ahrefs-gsc-priority.test.mjs
# 6件全て成功: スコア計算 / URL正規化 / 範囲倍率 / ソート / GSC欠落 / サンプルCSV
```

## 参考
- 先行実装: `tools/competitor-content-structure.mjs`（X-0008、Ahrefs的視点の競合分析）
- 週次SEO改善: `seo/weekly-seo-improve.sh` / `seo/ga4-ai-pipeline.mjs`（X-0006）
- GSC BigQuery分析: `docs/gsc-bigquery-weekly-seo-analysis.md`（X-0003）