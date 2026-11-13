# X-0011: 信頼度ベースの安価モデル＋エスカレート

## 概要

ブース関連問い合わせを安価なLLMで分類し、信頼度が低いものだけ高品質モデルへエスカレートするシステム。
22%エスカレートで98.8%精度・$0.88/1000件 vs 全高モデル$3.86で4.4倍のコスト効率を実測する。

## 分類対象（3次元）

1. **リード資格** (yes/no): 展示会ブース制作の見積もり依頼か？
2. **緊急度** (low/medium/high): イベント開催日が迫っているか？
3. **種別** (standard/custom): 標準ブースか特別仕様か？

## 作成するファイル

### `tools/confidence-classifier.mjs`

- `node tools/confidence-classifier.mjs --mode classify --input <text>`: 1件を分類。出力: JSON `{ classifications: [...], confidence: 0.0-1.0, escalated: bool }`
- `node tools/confidence-classifier.mjs --mode evaluate --samples <n>`: サンプルデータで評価実行
- `node tools/confidence-classifier.mjs --mode generate-samples --count <n>`: booth-projects.jsonからラベル付きサンプル生成

### 動作フロー

1. **Cheap model** (groq 優先, fallback deepseek) で分類 + `confidence` 抽出
   - システムプロンプト: 「以下の問い合わせを3次元で分類し、各次元の信頼度(0.0-1.0)を返してください。JSON形式: { \"lead_qualified\": bool, \"lead_confidence\": float, \"urgency\": \"low\"|\"medium\"|\"high\", \"urgency_confidence\": float, \"type\": \"standard\"|\"custom\", \"type_confidence\": float }」
2. **信頼度判定**: 全次元の最低信頼度が 0.9 以上 → 確定。0.3未満 → 低信頼度としてエスカレート。0.3-0.9 → 要エスカレート。
3. **エスカレート**: gemini (medium) または genspark/llm-proxy (high) で再分類
4. **コスト記録**: provider, model, tokens, usd を JSONL に追記 (`outputs/X-0011/cost-log.jsonl`)

### `outputs/X-0011/README.md`

設計書・アーキテクチャ・結果

### `outputs/X-0011/evaluation-report.md`

評価結果レポート（精度・コスト・エスカレート率）

## 技術仕様

- サンプルデータ: `data/booth-projects.json` の案件を元に、日本語の問い合わせメール文面を生成（ラベル付き）
- 安価モデル: groq (`openai/gpt-oss-120b` 相当, デフォルト)
- 中位モデル: gemini flash (`gemini-3.6-flash`)
- 高品質モデル: genspark proxy (`gpt-5.6-luna` など)
- 信頼度抽出: LLMの応答JSONから直接パース。確信度が低い場合に"uncertain"キーワードが出る傾向を利用。
- コスト計算: llm-ask.mjs の内部で使用量を executor-usage.jsonl に記録済み。それを集計。

## 実装詳細

### generate-samples モード

1. `data/booth-projects.json` を読む
2. 各プロジェクトからバリエーションで3-5件の問い合わせ文面を生成
3. リード資格 (yes: 見積もり・制作依頼, no: 質問のみ・プレス用), 緊急度 (事前に日付をランダム割当), 種別をラベル付け
4. `outputs/X-0011/samples.jsonl` に出力

### classify モード

1. llm-ask.mjs を呼ぶ: `node tools/llm-ask.mjs --provider groq --category classification "..."` 
2. 応答JSONから各次元の信頼度をパース
3. 最低信頼度がエスカレート閾値未満なら中位/高品質モデルで再分類
4. 結果をJSONで出力

### evaluate モード

1. 生成済みサンプル (または generate-samples で新規生成) を全件分類
2. 正解ラベルと比較して精度を算出
3. エスカレート率を計測
4. コストを集計 (executor-usage.jsonl から該当行を集計)
5. レポート出力

## 既存の依存

- `tools/llm-ask.mjs` — LLM呼び出し統合CLI
- `tools/llm-fallback.mjs` — フォールバック連鎖
- `data/booth-projects.json` — 案件データ
- `tools/provider-routing.mjs` — プロバイダルーティング

## テスト基準

1. `node tools/confidence-classifier.mjs --mode classify --input "展示会のブース制作の見積もりをお願いします。2026年12月開催の国際ロボット展に出展予定です。"` がエラーなくJSONを返す
2. 最低限の dry-run / unit test を追加