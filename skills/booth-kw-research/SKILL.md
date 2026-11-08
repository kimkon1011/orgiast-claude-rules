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

## 使用方法

全Phaseはマスターオーケストレータから実行する。

```bash
node skills/booth-kw-research/run.mjs
node skills/booth-kw-research/run.mjs --gsc-csv <GSCエクスポートCSV>
node skills/booth-kw-research/run.mjs --dry-run <出力先ディレクトリ>
```

`--dry-run` はネットワークとLLMを使わず、同じ出力先をPhase 1から4へ引き継ぐ。通常実行の成果物は `output/` に生成する。

## 使用条件
- `node -e "require('node:http');require('node:https')"` が正常終了すること
- `tools/llm-ask.mjs` が利用可能であること（LLM分類用）
- 競合サイトのURLリストが `data/competitors.json` に設定されていること

## 処理内容

### Phase 1: 現状把握（サイトクロール）
1. `run.mjs` が `process/phase1-crawl.mjs` を実行し、自社サイト + 競合サイトをクロール
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
| `output/keywords-priority.csv` | 優先度順キーワードリスト（priority, keyword, intent, category, volume, difficulty, business_value, score, recommended_action） |
| `output/content-gaps.md` | コンテンツギャップ分析＋最適化提案書 |

## 制約
- `robots.txt` を遵守すること。禁止パスはクロールしない
- クロール間隔は最低1秒空ける
- 外部API（GSC/Keyword Planner）が利用不可の場合、検索ボリュームは推定値として明示
- 出力のキーワードはすべて日本語

## 監視・改善

### 監視項目

| 指標 | 計測方法 | 目標 |
|---|---|---|
| 1実行あたりの時間 | 開始〜終了までの実測 | 15分以内（フェーズ毎にタイムアウト設定） |
| キーワード抽出精度 | 出力を人間がサンプル確認 | 適合率90%以上 |
| 分類の一貫性 | 同一キーワードを2回分類 | 一致率95%以上 |
| 提案の採用率 | 制作チームが採用した提案の割合 | 60%以上 |
| テスト合格率 | `node --test skills/booth-kw-research/test/*.test.mjs` | 全件PASS |
| 未実装スタブ | process配下を検索 | 0件 |

### 改善サイクル

```
月次実行 → 結果レビュー → フィードバック → プロンプト調整 → 翌月
         ↓（3ヶ月ごと）
      競合リスト更新・設定値見直し
```

### 既知の制約
- GSC API/Keyword Plannerへのアクセスがない場合、検索ボリュームデータは代替手段に頼る
- クロールは`robots.txt`を遵守するが、サイト側の変更により取得不能になる可能性がある
- LLM分類はバイアスを含む可能性があるため、重要なキーワードは人間のレビューを推奨
- 標準ライブラリのみの簡易HTML解析・日本語キーワード抽出であり、完全なDOM解析や形態素解析ではない

## 関連スキル
- `design-deck`: 可視化資料作成（提案書のスライド化）
