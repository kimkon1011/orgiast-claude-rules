---
name: booth-kw-research
description: 展示会ブース制作のキーワードリサーチを自動実行する。orgiast.jp のSEO改善のため、自社・競合サイトのクロール、キーワード抽出、優先順位付け、コンテンツ最適化提案を4Phaseで行う。
---

# 展示会ブース制作 キーワードリサーチエージェント

## 目的
株式会社オージャストのWebサイト（orgiast.jp）および関連ドメイン（rebooth.co.jp, orgiast-product.jp, event-shop.jp）を対象に、展示会ブース制作関連のキーワードリサーチを実行し、優先順位付きキーワードリストとコンテンツ最適化提案を生成する。

## トリガー
- `/booth-kw-research` で起動
- または `claude -p "展示会ブース制作のキーワードリサーチを実行"`

## 使用条件
- `node -e "require('node:http');require('node:https')"` が正常終了すること
- `tools/llm-ask.mjs` が利用可能であること（LLM分類用）
- 競合サイトのURLリストが `data/competitors.json` に設定されていること

## 手順

### Phase 1: 現状把握（サイトクロール）
1. `process/phase1-crawl.mjs` を実行し、自社サイト + 競合サイトをクロール
2. 各ページのURL、タイトル、H1、メタディスクリプション、主要見出しを抽出
3. 結果を `output/crawl-results.json` に保存
4. ページ数・エラー数・取得失敗数をサマリ出力

### Phase 2: キーワード発掘・収集
5. Phase 1のクロール結果からキーワード候補を抽出
6. 同一キーワードを統合（類似度80%以上はマージ）
7. GSCデータがあれば読み込み、統合
8. 結果を `output/raw-keywords.json` に保存

### Phase 3: 評価と優先順位付け
9. `tools/llm-ask.mjs --kind classify` で各キーワードの検索意図を分類
10. `data/business-value.json` からビジネス価値を取得
11. 優先度スコアを計算（Score = Volume × BusinessValue ÷ Difficulty）
12. 優先度順にソートして `output/keywords-priority.csv` に出力

### Phase 4: コンテンツ提案生成
13. 優先キーワードのうち、自社サイトに未カバーのものを特定
14. 推奨ページ種別を割り当て（サービスページ/事例/コラム）
15. 既存ページのタイトル・メタディスクリプション最適化案を生成
16. 内部リンク改善案を生成
17. `output/content-gaps.md` に提案書として出力

## 出力

| ファイル | 説明 |
|---|---|
| `output/crawl-results.json` | 全サイトのクロール結果 |
| `output/raw-keywords.json` | 抽出・統合済みキーワード一覧 |
| `output/keywords-priority.csv` | 優先度順キーワードリスト（優先度, キーワード, 意図, ビジネス価値, スコア, 推奨アクション） |
| `output/content-gaps.md` | コンテンツギャップ分析＋最適化提案書 |

## 制約
- `robots.txt` を遵守すること。禁止パスはクロールしない
- クロール間隔は最低1秒空ける
- 外部API（GSC/Keyword Planner）が利用不可の場合、検索ボリュームは推定値として明示
- 出力のキーワードはすべて日本語

## 関連スキル
- `make-blog`: 提案されたコンテンツを実際に執筆
- `design-deck`: 可視化資料作成（提案書のスライド化）